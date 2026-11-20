// Offline cache for the app shell. build.sh stamps the version, so each build gets its own cache,
// installs alongside the old one, and only takes over when the page says so (see app.js), never
// in the middle of a game.

const VERSION = '__BUILD_VERSION__';
const CACHE = `ppsspp-${VERSION}`;

const SHELL = [
	'./',
	'index.html',
	'manifest.webmanifest',
	'css/app.css',
	'js/app.js',
	'js/emulator.js',
	'js/input.js',
	'js/library.js',
	'js/i18n.js',
	'js/audio-worklet.js',
	'js/import-worker.js',
	'ppsspp.mjs',
	'ppsspp.wasm',
	'ppsspp.data',
	'icons/icon.svg',
	'icons/icon-192.png',
	'icons/icon-512.png',
	'licenses/PPSSPP-LICENSE.txt',
	'licenses/GPL-3.0.txt',
];

self.addEventListener('install', (event) => {
	// cache: 'reload' skips the HTTP cache, so a new version never precaches stale files.
	event.waitUntil(caches.open(CACHE).then((cache) =>
		cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		for (const key of await caches.keys()) {
			if (key.startsWith('ppsspp-') && key !== CACHE) {
				await caches.delete(key);
			}
		}
		await self.clients.claim();
	})());
});

self.addEventListener('message', (event) => {
	if (event.data === 'skipWaiting') {
		self.skipWaiting();
	}
});

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
		return;
	}
	event.respondWith((async () => {
		const cache = await caches.open(CACHE);
		// Navigations get the cached index.html, whatever the query string.
		const key = req.mode === 'navigate' ? 'index.html' : req;
		const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
		if (cached) {
			return cached;
		}
		return fetch(req);
	})());
});
