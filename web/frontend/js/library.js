// The game library: files in the OPFS "games" folder, which the core sees under /opfs/games.

export const GAMES_DIR = 'games';
export const GAME_EXTENSIONS = ['.iso', '.cso', '.chd', '.pbp', '.elf', '.prx'];

// OPFS names can't hold some characters, and the core wants a plain path.
export function safeFileName(name) {
	return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200);
}

export function isGameFile(name) {
	const lower = name.toLowerCase();
	return GAME_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function gamesFolder(create = false) {
	const root = await navigator.storage.getDirectory();
	try {
		return await root.getDirectoryHandle(GAMES_DIR, { create });
	} catch (err) {
		if (err.name === 'NotFoundError') {
			return null;
		}
		throw err;
	}
}

export async function listGames() {
	const folder = await gamesFolder();
	if (!folder) {
		return [];
	}
	const games = [];
	for await (const [name, handle] of folder.entries()) {
		if (handle.kind === 'file' && isGameFile(name)) {
			const file = await handle.getFile();
			games.push({ name, size: file.size, path: `${GAMES_DIR}/${name}` });
		}
	}
	return games.sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteGame(name) {
	const folder = await gamesFolder();
	if (folder) {
		await folder.removeEntry(name);
	}
}

// Copies the file into the library. onProgress(fraction) is called as it goes.
export function importGame(file, onProgress) {
	const name = safeFileName(file.name);
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./import-worker.js', import.meta.url));
		worker.onmessage = (e) => {
			const msg = e.data;
			if (msg.type === 'progress') {
				onProgress?.(msg.done / msg.total);
				return;
			}
			worker.terminate();
			if (msg.type === 'done') {
				resolve({ name, size: file.size, path: `${GAMES_DIR}/${name}` });
			} else {
				reject(new Error(msg.message));
			}
		};
		worker.onerror = (e) => {
			worker.terminate();
			reject(new Error(e.message));
		};
		worker.postMessage({ file, dir: GAMES_DIR, name });
	});
}

// Asks the browser not to evict our storage. Safari in particular clears site data it thinks is unused.
export async function requestPersistence() {
	if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
		return navigator.storage.persist();
	}
	return true;
}

export async function storageEstimate() {
	return navigator.storage?.estimate ? navigator.storage.estimate() : null;
}
