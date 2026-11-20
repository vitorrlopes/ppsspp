// Talks to the WASM build (web/host/web_host.cpp). Everything that reaches the core goes through
// web_post_command() or the shared WebInput block, both safe from this (the page's) thread.

const Command = Object.freeze({
	LOAD_GAME: 1,
	UNLOAD_GAME: 2,
	PAUSE: 3,
	RESUME: 4,
	RESET: 5,
	SAVE_STATE: 6,
	LOAD_STATE: 7,
	SET_OPTION: 8,
});

// Byte offsets in struct WebInput.
const INPUT_BUTTONS = 0;
const INPUT_ANALOG = 4;
const INPUT_CANVAS_W = 20;
const INPUT_CANVAS_H = 24;
const INPUT_PRESSED_SINCE = 28;

// The runtime reports a crash in any of its threads through printErr like this. After that the
// emulator is dead, though the last frame stays on screen as if it had only frozen.
const CRASH_PATTERN = /Aborted\(|RuntimeError|sent an error!|Out of memory|OOM/i;
const LOG_LINES = 200;

// Path where the core sees the OPFS root.
export const OPFS_MOUNT = '/opfs';

export class Emulator extends EventTarget {
	constructor(canvas) {
		super();
		this.canvas = canvas;
		this.module = null;
		this.inputPtr = 0;
		this.audio = null;
		this.options = [];
		this.log = [];  // The last LOG_LINES lines the core printed, for diagnostics.
		this.crash = null;
	}

	_logLine(text, isError) {
		this.log.push(text);
		if (this.log.length > LOG_LINES) {
			this.log.shift();
		}
		(isError ? console.warn : console.log)(text);
		if (isError && !this.crash && CRASH_PATTERN.test(text)) {
			this._crashed(text);
		}
	}

	_crashed(reason) {
		if (this.crash) {
			return;
		}
		this.crash = String(reason);
		this.dispatchEvent(new CustomEvent('crashed', { detail: this.crash }));
	}

	async start() {
		if (!crossOriginIsolated) {
			throw new Error('This page needs cross-origin isolation (COOP/COEP headers) for threads.');
		}
		const { default: createPPSSPP } = await import('../ppsspp.mjs');
		const ready = new Promise((resolve, reject) => {
			this._onReady = resolve;
			this._onFatal = reject;
		});
		this.module = await createPPSSPP({
			canvas: this.canvas,
			onHostEvent: (type, detail) => this._onHostEvent(type, detail),
			print: (text) => this._logLine(text, false),
			printErr: (text) => this._logLine(text, true),
			onAbort: (what) => this._crashed(`Aborted: ${what}`),
		});
		this.inputPtr = this.module._web_input();
		await ready;
	}

	_onHostEvent(type, detail) {
		switch (type) {
		case 'ready':
			this._onReady();
			return;
		case 'fatal':
			this._onFatal(new Error(detail));
			return;
		case 'options':
			this.options = JSON.parse(detail);
			break;
		}
		this.dispatchEvent(new CustomEvent(type, { detail }));
	}

	_post(cmd, arg = '') {
		const ptr = this.module.stringToNewUTF8(String(arg));
		try {
			this.module._web_post_command(cmd, ptr);
		} finally {
			this.module._free(ptr);
		}
	}

	// Resolves on 'loaded', rejects on 'error'.
	loadGame(opfsPath) {
		return this._awaitEvent('loaded', () => this._post(Command.LOAD_GAME, `${OPFS_MOUNT}/${opfsPath}`));
	}

	unloadGame() {
		return this._awaitEvent('unloaded', () => this._post(Command.UNLOAD_GAME));
	}

	saveState(slot) {
		return this._awaitEvent('stateSaved', () => this._post(Command.SAVE_STATE, slot));
	}

	loadState(slot) {
		return this._awaitEvent('stateLoaded', () => this._post(Command.LOAD_STATE, slot));
	}

	pause() { this._post(Command.PAUSE); }
	resume() { this._post(Command.RESUME); }
	reset() { this._post(Command.RESET); }

	setOption(key, value) {
		this._post(Command.SET_OPTION, `${key}=${value}`);
		const opt = this.options.find((o) => o.key === key);
		if (opt) {
			opt.value = value;
		}
	}

	_awaitEvent(okType, send) {
		return new Promise((resolve, reject) => {
			const done = (fn) => (e) => {
				this.removeEventListener(okType, onOk);
				this.removeEventListener('error', onErr);
				fn(e.detail);
			};
			const onOk = done(resolve);
			const onErr = done((msg) => reject(new Error(msg)));
			this.addEventListener(okType, onOk);
			this.addEventListener('error', onErr);
			send();
		});
	}

	// The HEAP views are replaced when memory grows, so look them up on every write.
	_store32(offset, value) {
		if (!this.inputPtr) {
			return;  // Not booted yet. The player re-sends its size when it opens.
		}
		Atomics.store(this.module.HEAP32, (this.inputPtr + offset) >> 2, value | 0);
	}

	// Counters from struct WebStats: frames run so far, and microseconds spent running them (wraps).
	stats() {
		if (!this.module) {
			return { frames: 0, micros: 0, heapUsed: 0, heapSize: 0 };
		}
		const base = this.module._web_stats() >> 2;
		const heap = this.module.HEAPU32;
		return {
			frames: Atomics.load(heap, base),
			micros: Atomics.load(heap, base + 1),
			heapUsed: Atomics.load(heap, base + 2),
			heapSize: heap.byteLength,
		};
	}

	framesRun() {
		return this.stats().frames;
	}

	setButtons(mask) {
		this._store32(INPUT_BUTTONS, mask);
	}

	// Buttons that went down since the last frame. They're held for a few frames at least, so a
	// tap shorter than a frame still reaches the game.
	addPresses(mask) {
		if (mask && this.inputPtr) {
			Atomics.or(this.module.HEAP32, (this.inputPtr + INPUT_PRESSED_SINCE) >> 2, mask);
		}
	}

	setAnalog(index, value) {
		this._store32(INPUT_ANALOG + index * 4, Math.round(value * 32767));
	}

	setCanvasSize(width, height) {
		this._store32(INPUT_CANVAS_W, width);
		this._store32(INPUT_CANVAS_H, height);
	}

	// Has to run from a user gesture: browsers (iOS Safari above all) keep audio suspended until one.
	async startAudio() {
		if (this.audio) {
			await this.audio.resume();
			return;
		}
		const ctx = new AudioContext({ latencyHint: 'interactive' });
		await ctx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
		const node = new AudioWorkletNode(ctx, 'ppsspp-audio', {
			numberOfInputs: 0,
			outputChannelCount: [2],
			processorOptions: {
				buffer: this.module.wasmMemory.buffer,
				ringPtr: this.module._web_audio_ring(),
				sourceRate: 44100,
			},
		});
		node.connect(ctx.destination);
		this.audio = ctx;
		await ctx.resume();
	}
}
