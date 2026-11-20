// Copyright (c) 2012- PPSSPP Project.

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, version 2.0 or later versions.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License 2.0 for more details.

// A copy of the GPL 2.0 should have been included with the program.
// If not, see http://www.gnu.org/licenses/

// Official git repository and contact information can be found at
// https://github.com/hrydgard/ppsspp and http://www.ppsspp.org/.

// A minimal libretro frontend for the browser, linked statically with the PPSSPP libretro core.
//
// Threads: main() runs on a pthread (PROXY_TO_PTHREAD) that owns the WebGL2 context through an
// OffscreenCanvas. All retro_* calls happen there. The browser's main thread only writes to
// WebInput (plain shared memory) and posts commands through web_post_command(), so the page
// stays responsive whatever the core does. The core runs the emulated CPU on a thread of its own
// and replays the GL commands it records on this one, inside retro_run().

#include <emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/wasmfs.h>
#include <GLES3/gl3.h>

#include <atomic>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>
#include <pthread.h>
#include <string>
#include <sys/stat.h>
#include <vector>

#include "libretro.h"

namespace {

const char *const SYSTEM_DIR = "/system";
const char *const OPFS_ROOT = "/opfs";
const char *const SAVE_DIR = "/opfs/saves";
const char *const STATE_DIR = "/opfs/states";

// Shared with JS. JS writes it with Atomics on the browser's main thread; this thread only reads.
struct WebInput {
	std::atomic<uint32_t> buttons;      // Bit n = RETRO_DEVICE_ID_JOYPAD n.
	std::atomic<int32_t> analog[4];     // Left X, left Y, right X, right Y, each -32768..32767.
	std::atomic<uint32_t> canvasWidth;  // Wanted canvas size in device pixels. 0 = unknown.
	std::atomic<uint32_t> canvasHeight;
};

// Counters for the page (FPS display, tests). Written here, read by JS.
struct WebStats {
	std::atomic<uint32_t> framesRun;
};

// Single producer (this thread), single consumer (the AudioWorklet), interleaved stereo frames.
// It is static, so it sits below the initial memory size and stays valid in the worklet's view
// of the buffer even after memory grows.
constexpr uint32_t AUDIO_RING_FRAMES = 8192;
struct WebAudioRing {
	uint32_t capacity;
	std::atomic<uint32_t> writePos;  // Free-running frame counters; the difference is the fill.
	std::atomic<uint32_t> readPos;
	int16_t samples[AUDIO_RING_FRAMES * 2];
};

enum class Command {
	LOAD_GAME = 1,
	UNLOAD_GAME = 2,
	PAUSE = 3,
	RESUME = 4,
	RESET = 5,
	SAVE_STATE = 6,
	LOAD_STATE = 7,
	SET_OPTION = 8,
};

struct PendingCommand {
	Command cmd;
	std::string arg;
};

struct CoreOption {
	std::string desc;
	std::vector<std::string> values;
	std::string value;
};

WebInput g_input;
WebStats g_stats;
WebAudioRing g_audio = { AUDIO_RING_FRAMES };

std::mutex g_commandLock;
std::deque<PendingCommand> g_commands;

// The core's last error, logged from any of its threads. When it gives up on a game it says why
// in the log and then just asks for a shutdown.
std::mutex g_logLock;
std::string g_lastError;

// Only touched on the core's thread.
std::map<std::string, CoreOption> g_options;
bool g_optionsUpdated = false;
std::string g_gamePath;
bool g_gameLoaded = false;
bool g_paused = false;
bool g_shutdownRequested = false;
retro_system_av_info g_avInfo{};
retro_hw_render_callback g_hwRender{};
EMSCRIPTEN_WEBGL_CONTEXT_HANDLE g_glContext = 0;
GLuint g_fbo = 0;
GLuint g_fboColor = 0;
GLuint g_fboDepthStencil = 0;
int g_fboWidth = 0;
int g_fboHeight = 0;
int g_canvasWidth = 0;
int g_canvasHeight = 0;
double g_lastTick = 0.0;
double g_frameDebt = 0.0;

// Sends an event to the page (Module.onHostEvent). Synchronous, so the strings can live on our stack.
void PostEvent(const char *type, const char *detail) {
	MAIN_THREAD_EM_ASM({
		if (Module.onHostEvent) {
			Module.onHostEvent(UTF8ToString($0), UTF8ToString($1));
		}
	}, type, detail ? detail : "");
}

void LogCallback(enum retro_log_level level, const char *fmt, ...) {
	char buf[1024];
	va_list args;
	va_start(args, fmt);
	vsnprintf(buf, sizeof(buf), fmt, args);
	va_end(args);
	static const char *const names[] = { "DEBUG", "INFO", "WARN", "ERROR" };
	fprintf(level >= RETRO_LOG_WARN ? stderr : stdout, "[core %s] %s", names[level & 3], buf);
	if (level == RETRO_LOG_ERROR) {
		std::lock_guard<std::mutex> guard(g_logLock);
		g_lastError = buf;
		while (!g_lastError.empty() && (g_lastError.back() == '\n' || g_lastError.back() == '\r')) {
			g_lastError.pop_back();
		}
	}
}

std::string Trim(const std::string &s) {
	size_t start = s.find_first_not_of(' ');
	size_t end = s.find_last_not_of(' ');
	return start == std::string::npos ? std::string() : s.substr(start, end - start + 1);
}

// Parses the legacy "Description; default|other|other" form. The first value is the default.
void RegisterVariables(const retro_variable *vars) {
	for (; vars && vars->key; vars++) {
		std::string spec = vars->value ? vars->value : "";
		size_t semi = spec.find(';');
		if (semi == std::string::npos) {
			continue;
		}
		CoreOption &opt = g_options[vars->key];
		opt.desc = Trim(spec.substr(0, semi));
		opt.values.clear();
		std::string list = Trim(spec.substr(semi + 1));
		size_t pos = 0;
		while (pos <= list.size()) {
			size_t bar = list.find('|', pos);
			if (bar == std::string::npos) {
				bar = list.size();
			}
			opt.values.push_back(list.substr(pos, bar - pos));
			pos = bar + 1;
		}
		// A value the page set before the core registered its options wins over the default.
		if (opt.value.empty() && !opt.values.empty()) {
			opt.value = opt.values[0];
		}
	}
}

void AppendJsonString(std::string &out, const std::string &s) {
	out += '"';
	for (char c : s) {
		if (c == '"' || c == '\\') {
			out += '\\';
			out += c;
		} else if ((unsigned char)c < 0x20) {
			char esc[8];
			snprintf(esc, sizeof(esc), "\\u%04x", c);
			out += esc;
		} else {
			out += c;
		}
	}
	out += '"';
}

void PostOptions() {
	std::string json = "[";
	for (const auto &[key, opt] : g_options) {
		if (json.size() > 1) {
			json += ',';
		}
		json += "{\"key\":";
		AppendJsonString(json, key);
		json += ",\"desc\":";
		AppendJsonString(json, opt.desc);
		json += ",\"value\":";
		AppendJsonString(json, opt.value);
		json += ",\"values\":[";
		for (size_t i = 0; i < opt.values.size(); i++) {
			if (i) {
				json += ',';
			}
			AppendJsonString(json, opt.values[i]);
		}
		json += "]}";
	}
	json += ']';
	PostEvent("options", json.c_str());
}

// The core's GLES2 build declares the ES3 entry points as function pointers of its own (gl3stub.c),
// under the same names, so ours are fetched the same way instead of linked.
PFNGLBLITFRAMEBUFFERPROC g_glBlitFramebuffer = nullptr;

uintptr_t GetCurrentFramebuffer() {
	return g_fbo;
}

retro_proc_address_t GetProcAddress(const char *sym) {
	return (retro_proc_address_t)emscripten_webgl_get_proc_address(sym);
}

// Sizes the render target the core draws into. Keeps the FBO name, which the core may cache.
void EnsureFramebuffer(int width, int height) {
	if (width <= g_fboWidth && height <= g_fboHeight && g_fbo) {
		return;
	}
	GLint prevFbo = 0;
	glGetIntegerv(GL_FRAMEBUFFER_BINDING, &prevFbo);
	if (!g_fbo) {
		glGenFramebuffers(1, &g_fbo);
		glGenTextures(1, &g_fboColor);
		glGenRenderbuffers(1, &g_fboDepthStencil);
	}
	glBindTexture(GL_TEXTURE_2D, g_fboColor);
	glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
	glBindTexture(GL_TEXTURE_2D, 0);
	glBindRenderbuffer(GL_RENDERBUFFER, g_fboDepthStencil);
	glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, width, height);
	glBindRenderbuffer(GL_RENDERBUFFER, 0);
	glBindFramebuffer(GL_FRAMEBUFFER, g_fbo);
	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g_fboColor, 0);
	glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, g_fboDepthStencil);
	GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
	glBindFramebuffer(GL_FRAMEBUFFER, prevFbo);
	g_fboWidth = width;
	g_fboHeight = height;
	if (status != GL_FRAMEBUFFER_COMPLETE) {
		fprintf(stderr, "Render target %dx%d incomplete: %04x\n", width, height, status);
	}
}

void ApplyGeometry(const retro_game_geometry &geom) {
	g_avInfo.geometry = geom;
	// The core may raise the internal resolution at any time, and draws into this FBO right after.
	EnsureFramebuffer((int)geom.max_width, (int)geom.max_height);
}

bool Environment(unsigned cmd, void *data) {
	switch (cmd) {
	case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
		((retro_log_callback *)data)->log = LogCallback;
		return true;
	case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
		*(const char **)data = SYSTEM_DIR;
		return true;
	case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
		*(const char **)data = SAVE_DIR;
		return true;
	case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
		return *(const retro_pixel_format *)data == RETRO_PIXEL_FORMAT_XRGB8888;
	case RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER:
		*(retro_hw_context_type *)data = RETRO_HW_CONTEXT_OPENGLES3;
		return true;
	case RETRO_ENVIRONMENT_SET_HW_RENDER: {
		auto *hw = (retro_hw_render_callback *)data;
		if (hw->context_type != RETRO_HW_CONTEXT_OPENGLES3 && hw->context_type != RETRO_HW_CONTEXT_OPENGLES2 &&
			hw->context_type != RETRO_HW_CONTEXT_OPENGL) {
			return false;
		}
		hw->get_current_framebuffer = GetCurrentFramebuffer;
		hw->get_proc_address = GetProcAddress;
		g_hwRender = *hw;
		return true;
	}
	case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
		// Version 0 makes the core fall back to the plain key/value list.
		*(unsigned *)data = 0;
		return true;
	case RETRO_ENVIRONMENT_SET_VARIABLES:
		RegisterVariables((const retro_variable *)data);
		return true;
	case RETRO_ENVIRONMENT_GET_VARIABLE: {
		auto *var = (retro_variable *)data;
		auto it = g_options.find(var->key);
		if (it == g_options.end() || it->second.value.empty()) {
			var->value = nullptr;
			return false;
		}
		var->value = it->second.value.c_str();
		return true;
	}
	case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
		*(bool *)data = g_optionsUpdated;
		g_optionsUpdated = false;
		return true;
	case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
		return true;
	case RETRO_ENVIRONMENT_GET_JIT_CAPABLE:
		*(bool *)data = false;
		return true;
	case RETRO_ENVIRONMENT_GET_FASTFORWARDING:
		*(bool *)data = false;
		return true;
	case RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION:
		*(unsigned *)data = 1;
		return true;
	case RETRO_ENVIRONMENT_SET_MESSAGE:
		PostEvent("message", ((const retro_message *)data)->msg);
		return true;
	case RETRO_ENVIRONMENT_SET_MESSAGE_EXT:
		PostEvent("message", ((const retro_message_ext *)data)->msg);
		return true;
	case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: {
		const auto *info = (const retro_system_av_info *)data;
		g_avInfo.timing = info->timing;
		ApplyGeometry(info->geometry);
		return true;
	}
	case RETRO_ENVIRONMENT_SET_GEOMETRY:
		ApplyGeometry(*(const retro_game_geometry *)data);
		return true;
	case RETRO_ENVIRONMENT_SHUTDOWN:
		// Acted on after retro_run() returns (see Tick), not from inside it.
		g_shutdownRequested = true;
		return true;
	default:
		return false;
	}
}

// Letterboxes the frame into the canvas, keeping the core's aspect ratio.
void VideoRefresh(const void *data, unsigned width, unsigned height, size_t pitch) {
	(void)pitch;
	if (!data || !width || !height) {
		return;  // Duplicate frame: the canvas keeps what it shows.
	}
	float aspect = g_avInfo.geometry.aspect_ratio > 0.0f ? g_avInfo.geometry.aspect_ratio : (float)width / height;
	int dstW = g_canvasWidth;
	int dstH = (int)(dstW / aspect + 0.5f);
	if (dstH > g_canvasHeight) {
		dstH = g_canvasHeight;
		dstW = (int)(dstH * aspect + 0.5f);
	}
	int x = (g_canvasWidth - dstW) / 2;
	int y = (g_canvasHeight - dstH) / 2;

	glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
	glDisable(GL_SCISSOR_TEST);
	glViewport(0, 0, g_canvasWidth, g_canvasHeight);
	glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
	glClear(GL_COLOR_BUFFER_BIT);
	glBindFramebuffer(GL_READ_FRAMEBUFFER, g_fbo);
	// The core's output is already the right way up for GL (checked against cube.iso's text).
	g_glBlitFramebuffer(0, 0, width, height, x, y, x + dstW, y + dstH, GL_COLOR_BUFFER_BIT, GL_LINEAR);
	glBindFramebuffer(GL_FRAMEBUFFER, g_fbo);
}

size_t AudioSampleBatch(const int16_t *data, size_t frames) {
	uint32_t write = g_audio.writePos.load(std::memory_order_relaxed);
	uint32_t read = g_audio.readPos.load(std::memory_order_acquire);
	uint32_t space = g_audio.capacity - (write - read);
	// Overflow drops the newest audio rather than blocking the emulator.
	size_t count = frames < space ? frames : space;
	for (size_t i = 0; i < count; i++) {
		uint32_t slot = (write + (uint32_t)i) % g_audio.capacity;
		g_audio.samples[slot * 2] = data[i * 2];
		g_audio.samples[slot * 2 + 1] = data[i * 2 + 1];
	}
	g_audio.writePos.store(write + (uint32_t)count, std::memory_order_release);
	return frames;
}

void AudioSample(int16_t left, int16_t right) {
	int16_t frame[2] = { left, right };
	AudioSampleBatch(frame, 1);
}

void InputPoll() {}

int16_t InputState(unsigned port, unsigned device, unsigned index, unsigned id) {
	if (port != 0) {
		return 0;
	}
	if (device == RETRO_DEVICE_JOYPAD) {
		uint32_t buttons = g_input.buttons.load(std::memory_order_relaxed);
		if (id == RETRO_DEVICE_ID_JOYPAD_MASK) {
			return (int16_t)(buttons & 0xFFFF);
		}
		return (buttons >> id) & 1;
	}
	if (device == RETRO_DEVICE_ANALOG && index <= RETRO_DEVICE_INDEX_ANALOG_RIGHT && id <= RETRO_DEVICE_ID_ANALOG_Y) {
		int32_t v = g_input.analog[index * 2 + id].load(std::memory_order_relaxed);
		return (int16_t)(v < -32768 ? -32768 : (v > 32767 ? 32767 : v));
	}
	return 0;
}

std::string StateFilePath(int slot) {
	std::string name = g_gamePath.substr(g_gamePath.find_last_of('/') + 1);
	return std::string(STATE_DIR) + "/" + name + "." + std::to_string(slot) + ".state";
}

void SaveState(int slot) {
	size_t size = retro_serialize_size();
	std::vector<uint8_t> buf(size);
	if (!size || !retro_serialize(buf.data(), size)) {
		PostEvent("error", "Couldn't create the save state.");
		return;
	}
	std::string path = StateFilePath(slot);
	FILE *f = fopen(path.c_str(), "wb");
	bool ok = f && fwrite(buf.data(), 1, size, f) == size;
	if (f) {
		ok = fclose(f) == 0 && ok;
	}
	PostEvent(ok ? "stateSaved" : "error", ok ? path.c_str() : "Couldn't write the save state.");
}

void LoadState(int slot) {
	std::string path = StateFilePath(slot);
	FILE *f = fopen(path.c_str(), "rb");
	if (!f) {
		PostEvent("error", "There's no save state in that slot.");
		return;
	}
	fseek(f, 0, SEEK_END);
	long size = ftell(f);
	fseek(f, 0, SEEK_SET);
	std::vector<uint8_t> buf(size > 0 ? (size_t)size : 0);
	bool ok = size > 0 && fread(buf.data(), 1, buf.size(), f) == buf.size();
	fclose(f);
	ok = ok && retro_unserialize(buf.data(), buf.size());
	PostEvent(ok ? "stateLoaded" : "error", ok ? path.c_str() : "Couldn't load the save state.");
}

// Always answers with "unloaded", so the page never waits on a game that's already gone.
void UnloadGame() {
	if (g_gameLoaded) {
		retro_unload_game();
		g_gameLoaded = false;
		g_gamePath.clear();
	}
	PostEvent("unloaded", nullptr);
}

void LoadGame(const std::string &path) {
	if (g_gameLoaded) {
		UnloadGame();
	}
	{
		std::lock_guard<std::mutex> guard(g_logLock);
		g_lastError.clear();
	}
	g_shutdownRequested = false;
	retro_game_info info{};
	info.path = path.c_str();
	if (!retro_load_game(&info)) {
		PostEvent("error", "The game couldn't be loaded.");
		return;
	}
	g_gamePath = path;
	g_gameLoaded = true;
	g_paused = false;
	retro_get_system_av_info(&g_avInfo);
	ApplyGeometry(g_avInfo.geometry);
	g_frameDebt = 0.0;
	g_lastTick = emscripten_get_now();
	if (g_hwRender.context_reset) {
		g_hwRender.context_reset();
	}
	PostOptions();
	PostEvent("loaded", path.c_str());
}

void SetOption(const std::string &arg) {
	size_t eq = arg.find('=');
	if (eq == std::string::npos) {
		return;
	}
	g_options[arg.substr(0, eq)].value = arg.substr(eq + 1);
	g_optionsUpdated = true;
}

void RunCommand(const PendingCommand &pc) {
	switch (pc.cmd) {
	case Command::LOAD_GAME: LoadGame(pc.arg); break;
	case Command::UNLOAD_GAME: UnloadGame(); break;
	case Command::PAUSE: g_paused = true; break;
	case Command::RESUME:
		g_paused = false;
		g_lastTick = emscripten_get_now();
		break;
	case Command::RESET:
		if (g_gameLoaded) {
			retro_reset();
		}
		break;
	case Command::SAVE_STATE:
		if (g_gameLoaded) {
			SaveState(atoi(pc.arg.c_str()));
		}
		break;
	case Command::LOAD_STATE:
		if (g_gameLoaded) {
			LoadState(atoi(pc.arg.c_str()));
		}
		break;
	case Command::SET_OPTION: SetOption(pc.arg); break;
	}
}

void DrainCommands() {
	std::deque<PendingCommand> commands;
	{
		std::lock_guard<std::mutex> guard(g_commandLock);
		commands.swap(g_commands);
	}
	for (const PendingCommand &pc : commands) {
		RunCommand(pc);
	}
}

void UpdateCanvasSize() {
	int w = (int)g_input.canvasWidth.load(std::memory_order_relaxed);
	int h = (int)g_input.canvasHeight.load(std::memory_order_relaxed);
	if (w > 0 && h > 0 && (w != g_canvasWidth || h != g_canvasHeight)) {
		emscripten_set_canvas_element_size("#canvas", w, h);
		g_canvasWidth = w;
		g_canvasHeight = h;
	}
}

// How many frames to run on this display refresh. Paced by the clock, then nudged by how full the
// audio ring is, so the emulated audio neither underruns nor drifts away (dynamic rate control).
int FramesDue() {
	double now = emscripten_get_now();
	double elapsed = now - g_lastTick;
	g_lastTick = now;
	if (elapsed > 100.0) {
		elapsed = 100.0;  // Back from a hidden tab or a long stall: don't try to catch up.
	}
	double fps = g_avInfo.timing.fps > 0.0 ? g_avInfo.timing.fps : 60.0;
	double rate = g_avInfo.timing.sample_rate > 0.0 ? g_avInfo.timing.sample_rate : 44100.0;
	double target = rate * 0.05;  // 50ms of audio.
	double fill = (double)(g_audio.writePos.load() - g_audio.readPos.load());
	double skew = (fill - target) / target;
	skew = skew < -1.0 ? -1.0 : (skew > 1.0 ? 1.0 : skew);
	double period = 1000.0 / fps * (1.0 + 0.005 * skew);
	g_frameDebt += elapsed;
	int frames = 0;
	while (g_frameDebt >= period && frames < 3) {
		g_frameDebt -= period;
		frames++;
	}
	if (frames == 3) {
		g_frameDebt = 0.0;
	}
	return frames;
}

void Tick() {
	DrainCommands();
	UpdateCanvasSize();
	if (!g_gameLoaded || g_paused) {
		g_lastTick = emscripten_get_now();
		return;
	}
	int frames = FramesDue();
	int ran = 0;
	while (ran < frames && !g_shutdownRequested) {
		retro_run();
		ran++;
	}
	g_stats.framesRun.fetch_add(ran, std::memory_order_relaxed);
	if (g_shutdownRequested) {
		g_shutdownRequested = false;
		std::string reason;
		{
			std::lock_guard<std::mutex> guard(g_logLock);
			reason = g_lastError;
		}
		UnloadGame();
		PostEvent("shutdown", reason.c_str());
	}
}

bool MountStorage() {
	backend_t opfs = wasmfs_create_opfs_backend();
	if (!opfs || wasmfs_create_directory(OPFS_ROOT, 0777, opfs) != 0) {
		return false;
	}
	mkdir(SAVE_DIR, 0777);
	mkdir(STATE_DIR, 0777);
	return true;
}

bool CreateGLContext() {
	EmscriptenWebGLContextAttributes attrs;
	emscripten_webgl_init_context_attributes(&attrs);
	attrs.majorVersion = 2;
	attrs.minorVersion = 0;
	attrs.alpha = false;
	attrs.depth = false;     // The core draws into our FBO, which has its own depth and stencil.
	attrs.stencil = false;
	attrs.antialias = false;
	attrs.preserveDrawingBuffer = false;
	attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
	g_glContext = emscripten_webgl_create_context("#canvas", &attrs);
	if (g_glContext <= 0) {
		return false;
	}
	if (emscripten_webgl_make_context_current(g_glContext) != EMSCRIPTEN_RESULT_SUCCESS) {
		return false;
	}
	g_glBlitFramebuffer = (PFNGLBLITFRAMEBUFFERPROC)emscripten_webgl_get_proc_address("glBlitFramebuffer");
	return g_glBlitFramebuffer != nullptr;
}

}  // namespace

extern "C" {

// Emscripten's libc declares this but doesn't define it, and the ad hoc server in
// ext/aemu_postoffice calls it. Thread names have nowhere to go in a browser anyway.
int pthread_setname_np(pthread_t, const char *) {
	return 0;
}

EMSCRIPTEN_KEEPALIVE WebInput *web_input() {
	return &g_input;
}

EMSCRIPTEN_KEEPALIVE WebStats *web_stats() {
	return &g_stats;
}

EMSCRIPTEN_KEEPALIVE WebAudioRing *web_audio_ring() {
	return &g_audio;
}

// Safe from any thread. The argument is copied.
EMSCRIPTEN_KEEPALIVE void web_post_command(int cmd, const char *arg) {
	std::lock_guard<std::mutex> guard(g_commandLock);
	g_commands.push_back({ (Command)cmd, arg ? arg : "" });
}

}  // extern "C"

int main() {
	if (!MountStorage()) {
		PostEvent("fatal", "Persistent storage (OPFS) isn't available in this browser.");
		return 1;
	}
	if (!CreateGLContext()) {
		PostEvent("fatal", "WebGL 2 isn't available.");
		return 1;
	}

	retro_set_environment(Environment);
	retro_set_video_refresh(VideoRefresh);
	retro_set_audio_sample(AudioSample);
	retro_set_audio_sample_batch(AudioSampleBatch);
	retro_set_input_poll(InputPoll);
	retro_set_input_state(InputState);
	retro_init();
	retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);

	PostOptions();
	PostEvent("ready", nullptr);
	emscripten_set_main_loop(Tick, 0, true);
	return 0;
}
