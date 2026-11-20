#!/bin/bash
# Builds the PPSSPP web app (PWA) into web/dist.
#
# Needs the Emscripten SDK on the PATH (source emsdk_env.sh first).
# Usage: web/build.sh [--debug]
set -euo pipefail

WEB_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$WEB_DIR/.." && pwd)"
BUILD="$WEB_DIR/build"
DIST="$WEB_DIR/dist"
JOBS="$(nproc 2>/dev/null || echo 4)"

# --debug only changes the link (runtime assertions, symbols). The core stays a release build:
# a DEBUG=1 core takes a long time to build and replaces the release objects in libretro/.
OPT="-O3"
LINK_DEBUG=""
if [ "${1:-}" = "--debug" ]; then
	OPT="-O1"
	LINK_DEBUG="-g -sASSERTIONS=2 -sPTHREADS_DEBUG=1"
fi

if ! command -v emcc >/dev/null; then
	echo "emcc not found. Install the Emscripten SDK and source emsdk_env.sh." >&2
	exit 1
fi

echo "== Core"
emmake make -C "$ROOT/libretro" platform=emscripten -j"$JOBS"
# The Makefile names it .bc, but it is an ar archive, and emcc goes by the extension.
mkdir -p "$BUILD"
CORE_LIB="$BUILD/libppsspp_libretro.a"
cp "$ROOT/libretro/ppsspp_libretro_emscripten.bc" "$CORE_LIB"

echo "== Assets"
# What the core reads from <system>/PPSSPP. Most UI assets aren't needed: the page is the UI.
SYS="$BUILD/system/PPSSPP"
rm -rf "$BUILD/system"
mkdir -p "$SYS/lang"
for f in compat.ini compatvr.ini knownfuncs.ini langregion.ini ppge_atlas.zim ppge_atlas.meta; do
	cp "$ROOT/assets/$f" "$SYS/"
done
cp -r "$ROOT/assets/flash0" "$SYS/"
cp "$ROOT/assets/lang/en_US.ini" "$ROOT/assets/lang/pt_BR.ini" "$SYS/lang/"

echo "== zlib"
# A static libretro core leaves zlib to the frontend. Use the copy in ext/ rather than the
# Emscripten port, which would be downloaded at build time.
ZLIB_OBJ="$BUILD/zlib"
mkdir -p "$ZLIB_OBJ"
for src in "$ROOT"/ext/zlib/*.c; do
	obj="$ZLIB_OBJ/$(basename "${src%.c}").o"
	if [ ! "$obj" -nt "$src" ]; then
		emcc -O3 -pthread -c "$src" -o "$obj"
	fi
done

echo "== Link"
mkdir -p "$DIST"
# Linker settings, grouped by what they're for:
# - Threads: the core runs the emulated CPU on a thread of its own; PROXY_TO_PTHREAD moves main()
#   (and with it every libretro call) off the page's main thread, and the canvas goes with it.
#   No prestarted pool: with one, about one boot in five hung on the first OPFS access, its
#   helper thread never answering (Emscripten 4.0.10, reproduced without PPSSPP). Workers start
#   on demand instead, which is safe since no C code runs on the page's main thread.
# - WasmFS gives the OPFS backend, which holds the games and saves without loading them into memory.
# - FULL_ES3 emulates the bits of GLES3 that WebGL 2 lacks, like client-side vertex arrays.
# - Growable memory: a demo already takes 576 MB (256 MB of it the PSP address space), and with
#   a fixed 768 MB a big 3D game ran out and the runtime aborted, which looks like a frozen
#   game. Growth costs JS a check on each access to the heap, WebGL calls included.
emcc $OPT $LINK_DEBUG -std=c++17 -pthread -msimd128 \
	-I"$ROOT/libretro/libretro-common/include" \
	"$WEB_DIR/host/web_host.cpp" "$CORE_LIB" "$ZLIB_OBJ"/*.o \
	-o "$DIST/ppsspp.mjs" \
	-sPROXY_TO_PTHREAD=1 -sOFFSCREENCANVAS_SUPPORT=1 -sPTHREAD_POOL_SIZE=0 \
	-sWASMFS=1 \
	-sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2 -sFULL_ES3=1 -sGL_ENABLE_GET_PROC_ADDRESS=1 \
	-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=512MB -sMAXIMUM_MEMORY=2GB \
	-sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB \
	-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPPSSPP -sENVIRONMENT=web,worker \
	-sEXPORTED_FUNCTIONS=_main,_web_input,_web_stats,_web_audio_ring,_web_post_command,_malloc,_free \
	-sEXPORTED_RUNTIME_METHODS=stringToNewUTF8,HEAPU8,HEAP16,HEAP32,HEAPU32,wasmMemory \
	--preload-file "$BUILD/system@/system"

echo "== Frontend"
cp -r "$WEB_DIR/frontend/." "$DIST/"
# The GPL texts ship with the app. aemu_postoffice is GPL-3.0, which makes the whole build GPL-3.0.
mkdir -p "$DIST/licenses"
cp "$ROOT/LICENSE.TXT" "$DIST/licenses/PPSSPP-LICENSE.txt"
cp "$ROOT/ext/aemu_postoffice/gpl-3.0.txt" "$DIST/licenses/GPL-3.0.txt"
# The service worker caches by version, so a new build replaces the old files everywhere.
VERSION="$(git -C "$ROOT" describe --always --dirty 2>/dev/null || date +%s)-$(date +%s)"
sed -i "s/__BUILD_VERSION__/$VERSION/" "$DIST/sw.js" "$DIST/js/app.js"

echo "Done: $DIST"
