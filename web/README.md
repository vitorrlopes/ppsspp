# PPSSPP Web (PWA)

The libretro core, built with Emscripten and wrapped in a small web frontend that installs as a
Progressive Web App. Games and saves stay in the browser's private storage (OPFS).

## Building

Needs the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html). It was
developed with 4.0.10.

```bash
git submodule update --init --recursive
source /path/to/emsdk/emsdk_env.sh
web/build.sh            # release build into web/dist
web/build.sh --debug    # same core, linked with runtime assertions and pthread tracing
python3 web/serve.py    # http://localhost:8080 with the COOP/COEP headers
```

The first build compiles the whole core (about half an hour on 4 cores); after that only what
changed. `--debug` doesn't rebuild the core in debug mode: that takes as long again and replaces
the release objects in `libretro/`.

## Deploying (Netlify)

Publish `web/dist` as it is. `_headers` in it sets what the build needs:

- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
  Without them the page isn't cross-origin isolated, there's no `SharedArrayBuffer`, and the
  threaded build can't start. The page says so instead of failing silently.
- `no-cache` on `sw.js` and `index.html`, so updates are noticed.

Any host works if it can send those headers and serves over HTTPS. GitHub Pages can't set headers.

## How it fits together

| Piece | Where | Runs on |
|---|---|---|
| libretro frontend | `host/web_host.cpp` | A pthread (`PROXY_TO_PTHREAD`), which owns the WebGL 2 context through an OffscreenCanvas |
| Emulated CPU | the core's emu thread | Its own pthread; GL commands it records are replayed on the host thread in `retro_run()` |
| UI, input, library | `frontend/js/app.js`, `input.js`, `library.js` | The page's main thread |
| Audio | `frontend/js/audio-worklet.js` | AudioWorklet, reading a ring buffer in WASM memory |
| Import | `frontend/js/import-worker.js` | A worker that copies a picked file into OPFS in 8 MB chunks |
| Offline cache | `frontend/sw.js` | Service worker, versioned per build |

The page never calls into the core directly. It writes buttons, sticks and the canvas size into a
shared `WebInput` block, and queues commands (load, pause, save state...) with
`web_post_command()`. The host answers with events through `Module.onHostEvent`.

Frame pacing follows the clock, nudged by how full the audio ring is, so audio neither underruns
nor drifts. A hidden tab pauses the game.

## Limitations

- **No JIT.** WebAssembly can't run code it generates, so the CPU runs on the IR interpreter and
  the vertex decoder JIT is off. Expect demanding 3D games to run below full speed, especially on
  phones.
- **No FFmpeg.** The core is built without it here, so games' MPEG/PSMF videos don't play.
- **No ad hoc or infrastructure networking.** Browsers have no raw sockets.
- **Storage can be evicted.** The app asks for persistent storage on the first import, but a
  browser (Safari above all) may still clear it after a long time unused.
- **Memory.** The build reserves 768 MB up front (see `build.sh`). That's fine on desktop and
  recent phones; older phones may refuse to start it.

## Licensing

PPSSPP is GPL-2.0-or-later. The build also links `ext/aemu_postoffice`, which is GPL-3.0, so the
app as a whole is distributed under the GPL-3.0. `build.sh` copies both license texts into
`dist/licenses`, and the About dialog links to them and to the source.
