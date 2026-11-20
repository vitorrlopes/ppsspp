// Copies a picked file into OPFS in chunks, so a 1.8GB ISO never has to fit in memory.
// Sync access handles only exist in workers, and they're the most widely supported way to write
// OPFS (Safari has had them longer than createWritable()).

const CHUNK = 8 * 1024 * 1024;

self.onmessage = async (e) => {
	const { file, dir, name } = e.data;
	let handle = null;
	try {
		const root = await navigator.storage.getDirectory();
		const folder = await root.getDirectoryHandle(dir, { create: true });
		const fileHandle = await folder.getFileHandle(name, { create: true });
		handle = await fileHandle.createSyncAccessHandle();
		handle.truncate(0);
		for (let offset = 0; offset < file.size; offset += CHUNK) {
			const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
			let written = 0;
			while (written < chunk.length) {
				written += handle.write(chunk.subarray(written), { at: offset + written });
			}
			self.postMessage({ type: 'progress', done: Math.min(offset + CHUNK, file.size), total: file.size });
		}
		handle.flush();
		handle.close();
		handle = null;
		self.postMessage({ type: 'done' });
	} catch (err) {
		if (handle) {
			handle.close();
		}
		// Don't leave a half-copied game in the library.
		try {
			const root = await navigator.storage.getDirectory();
			const folder = await root.getDirectoryHandle(dir);
			await folder.removeEntry(name);
		} catch {
			// Nothing to clean up.
		}
		self.postMessage({ type: 'error', message: err.name === 'QuotaExceededError' ? 'quota' : String(err.message || err) });
	}
};
