import { Emulator } from './emulator.js';
import { InputManager } from './input.js';
import { applyTranslations, formatBytes, t } from './i18n.js';
import {
	deleteGame, importGame, isGameFile, listGames, requestPersistence, storageEstimate,
} from './library.js';

// Where the source of this build is published (the GPL requires offering it).
const SOURCE_URL = 'https://github.com/vitorrlopes/ppsspp';
const OPTIONS_KEY = 'ppsspp.options';
const TOUCH_KEY = 'ppsspp.touch';

const $ = (sel) => document.querySelector(sel);

const ui = {
	library: $('#library'),
	player: $('#player'),
	bootStatus: $('#boot-status'),
	gameList: $('#game-list'),
	emptyLibrary: $('#empty-library'),
	fileInput: $('#file-input'),
	dropzone: $('#dropzone'),
	importProgress: $('#import-progress'),
	storageInfo: $('#storage-info'),
	canvas: $('#canvas'),
	pauseMenu: $('#pause-menu'),
	touch: $('#touch-controls'),
	toast: $('#toast'),
	settingsDialog: $('#settings-dialog'),
	settingsList: $('#settings-list'),
	aboutDialog: $('#about-dialog'),
	updateBanner: $('#update-banner'),
};

const emulator = new Emulator(ui.canvas);
// ?debug exposes the emulator to the console and to automated tests.
if (new URLSearchParams(location.search).has('debug')) {
	window.__emu = emulator;
}
const input = new InputManager();
let emulatorReady = null;   // Promise, set once boot starts.
let inGame = false;
let menuOpen = false;

// Small helpers

function readJson(key, fallback) {
	try {
		return JSON.parse(localStorage.getItem(key)) ?? fallback;
	} catch {
		return fallback;
	}
}

function writeJson(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Private mode or storage full: settings just won't stick.
	}
}

let toastTimer = 0;
function toast(message) {
	ui.toast.textContent = message;
	ui.toast.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2500);
}

function showError(message) {
	if (inGame) {
		toast(message);
	} else {
		alert(message);
	}
}

function prefersTouch() {
	return matchMedia('(pointer: coarse)').matches;
}

// Boot

function boot() {
	emulatorReady = emulator.start().then(() => {
		ui.bootStatus.hidden = true;
		for (const [key, value] of Object.entries(readJson(OPTIONS_KEY, {}))) {
			emulator.setOption(key, value);
		}
	}).catch((err) => {
		ui.bootStatus.textContent = crossOriginIsolated ? t('bootFailed') + err.message : t('noIsolation');
		ui.bootStatus.classList.add('error');
		throw err;
	});
	emulator.addEventListener('message', (e) => toast(e.detail));
	// The core gave up on the game (a bad dump, say). The host has already unloaded it.
	emulator.addEventListener('shutdown', async (e) => {
		inGame = false;
		await quitGame();
		showError(e.detail ? `${t('gameStopped')}\n\n${e.detail}` : t('gameStopped'));
	});
}

// Library

async function refreshLibrary() {
	const games = await listGames();
	ui.gameList.replaceChildren(...games.map((game) => {
		const li = document.createElement('li');
		li.className = 'game';
		const name = document.createElement('span');
		name.className = 'name';
		name.textContent = game.name;
		const size = document.createElement('span');
		size.className = 'muted small';
		size.textContent = formatBytes(game.size);
		const play = document.createElement('button');
		play.className = 'btn primary';
		play.textContent = t('play');
		play.addEventListener('click', () => startGame(game));
		const remove = document.createElement('button');
		remove.className = 'btn';
		remove.textContent = t('remove');
		remove.addEventListener('click', async () => {
			if (confirm(t('confirmRemove', game.name))) {
				await deleteGame(game.name);
				refreshLibrary();
			}
		});
		const info = document.createElement('div');
		info.append(name, size);
		li.append(info, play, remove);
		return li;
	}));
	ui.emptyLibrary.hidden = games.length > 0;
	const est = await storageEstimate();
	ui.storageInfo.textContent = est ? t('storageUsed', formatBytes(est.usage), formatBytes(est.quota)) : '';
}

async function importFiles(files) {
	await requestPersistence();
	const bar = ui.importProgress;
	for (const file of files) {
		if (!isGameFile(file.name)) {
			showError(t('notAGame', file.name));
			continue;
		}
		bar.hidden = false;
		const setProgress = (f) => {
			bar.firstElementChild.style.width = `${(f * 100).toFixed(1)}%`;
			bar.lastElementChild.textContent = `${t('importing')} ${file.name} ${(f * 100).toFixed(0)}%`;
		};
		setProgress(0);
		try {
			await importGame(file, setProgress);
		} catch (err) {
			showError(err.message === 'quota' ? t('quotaExceeded') : err.message);
		}
	}
	bar.hidden = true;
	refreshLibrary();
}

// Game

async function startGame(game) {
	// Audio has to start inside the click that started the game.
	const audioReady = emulatorReady.then(() => emulator.startAudio()).catch(() => {});
	await emulatorReady;
	showPlayer(true);
	toast(t('loadingGame'));
	try {
		await emulator.loadGame(game.path);
		await audioReady;
		inGame = true;
		input.enabled = true;
	} catch (err) {
		showPlayer(false);
		showError(err.message);
	}
}

async function quitGame() {
	closeMenu(false);
	input.enabled = false;
	if (inGame) {
		inGame = false;
		await emulator.unloadGame();
	}
	if (document.fullscreenElement) {
		document.exitFullscreen().catch(() => {});
	}
	showPlayer(false);
	refreshLibrary();
}

function showPlayer(show) {
	ui.player.hidden = !show;
	ui.library.hidden = show;
	ui.touch.hidden = !show || !readJson(TOUCH_KEY, prefersTouch());
	if (show) {
		requestAnimationFrame(syncCanvasSize);
	}
}

function openMenu() {
	if (menuOpen || !inGame) {
		return;
	}
	menuOpen = true;
	input.enabled = false;
	emulator.pause();
	ui.pauseMenu.hidden = false;
}

function closeMenu(resume = true) {
	if (!menuOpen) {
		return;
	}
	menuOpen = false;
	ui.pauseMenu.hidden = true;
	if (resume && inGame) {
		input.enabled = true;
		emulator.resume();
	}
}

async function runMenuAction(action) {
	const slot = $('#state-slot').value;
	try {
		switch (action) {
		case 'resume': closeMenu(); break;
		case 'save-state':
			await emulator.saveState(slot);
			toast(t('stateSaved'));
			closeMenu();
			break;
		case 'load-state':
			await emulator.loadState(slot);
			toast(t('stateLoaded'));
			closeMenu();
			break;
		case 'fullscreen':
			if (document.fullscreenElement) {
				await document.exitFullscreen();
			} else {
				await ui.player.requestFullscreen?.({ navigationUI: 'hide' });
				await screen.orientation?.lock?.('landscape').catch(() => {});
			}
			break;
		case 'toggle-touch': {
			const on = ui.touch.hidden;
			writeJson(TOUCH_KEY, on);
			ui.touch.hidden = !on;
			break;
		}
		case 'settings': openSettings(); break;
		case 'reset':
			emulator.reset();
			closeMenu();
			break;
		case 'quit': await quitGame(); break;
		}
	} catch (err) {
		toast(err.message);
	}
}

// Settings: built from the options the core registers.

function openSettings() {
	const saved = readJson(OPTIONS_KEY, {});
	ui.settingsList.replaceChildren(...emulator.options.map((opt) => {
		const row = document.createElement('label');
		row.className = 'setting';
		const name = document.createElement('span');
		name.textContent = opt.desc || opt.key;
		const select = document.createElement('select');
		for (const value of opt.values) {
			const o = document.createElement('option');
			o.value = o.textContent = value;
			select.append(o);
		}
		select.value = opt.value;
		select.addEventListener('change', () => {
			emulator.setOption(opt.key, select.value);
			saved[opt.key] = select.value;
			writeJson(OPTIONS_KEY, saved);
		});
		row.append(name, select);
		return row;
	}));
	ui.settingsDialog.showModal();
}

// Canvas size and input, once per display frame.

function syncCanvasSize() {
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const rect = ui.canvas.getBoundingClientRect();
	emulator.setCanvasSize(Math.round(rect.width * dpr), Math.round(rect.height * dpr));
}

function inputLoop() {
	if (emulator.module) {
		const { mask, stick } = input.poll();
		emulator.setButtons(mask);
		emulator.setAnalog(0, stick[0]);
		emulator.setAnalog(1, stick[1]);
	}
	requestAnimationFrame(inputLoop);
}

// Service worker and updates.

async function registerServiceWorker() {
	if (!('serviceWorker' in navigator)) {
		return;
	}
	const reg = await navigator.serviceWorker?.register('sw.js');
	if (!reg) {
		return;
	}
	// Reload only for an update the user asked for. On a first visit the new worker also takes
	// control (clients.claim), and reloading then would cut off an import in progress.
	let updateRequested = false;
	const offer = (worker) => {
		ui.updateBanner.hidden = false;
		$('#btn-update').onclick = () => {
			updateRequested = true;
			worker.postMessage('skipWaiting');
		};
	};
	if (reg.waiting && navigator.serviceWorker.controller) {
		offer(reg.waiting);
	}
	reg.addEventListener('updatefound', () => {
		const worker = reg.installing;
		worker?.addEventListener('statechange', () => {
			if (worker.state === 'installed' && navigator.serviceWorker.controller) {
				offer(worker);
			}
		});
	});
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (updateRequested) {
			updateRequested = false;
			location.reload();
		}
	});
}

// Wiring

function init() {
	applyTranslations();
	const source = $('#source-link');
	source.href = source.textContent = SOURCE_URL;

	ui.fileInput.addEventListener('change', () => {
		importFiles([...ui.fileInput.files]);
		ui.fileInput.value = '';
	});
	ui.dropzone.addEventListener('dragover', (e) => {
		e.preventDefault();
		ui.dropzone.classList.add('over');
	});
	ui.dropzone.addEventListener('dragleave', () => ui.dropzone.classList.remove('over'));
	ui.dropzone.addEventListener('drop', (e) => {
		e.preventDefault();
		ui.dropzone.classList.remove('over');
		importFiles([...e.dataTransfer.files]);
	});

	$('#btn-settings').addEventListener('click', () => emulatorReady.then(openSettings));
	$('#btn-about').addEventListener('click', () => ui.aboutDialog.showModal());
	$('#btn-menu').addEventListener('click', openMenu);
	ui.pauseMenu.addEventListener('click', (e) => {
		const action = e.target.closest('[data-action]')?.dataset.action;
		if (action) {
			runMenuAction(action);
		}
	});
	window.addEventListener('keydown', (e) => {
		if (e.code === 'Escape' && inGame && !ui.settingsDialog.open) {
			e.preventDefault();
			menuOpen ? closeMenu() : openMenu();
		}
	});
	// A hidden tab gets no animation frames; pausing keeps audio and timing from piling up.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			openMenu();
		}
	});

	// "Open with" from the OS, for the file types the manifest declares.
	if ('launchQueue' in window) {
		window.launchQueue.setConsumer(async (params) => {
			const files = await Promise.all(params.files.map((h) => h.getFile()));
			if (files.length) {
				importFiles(files);
			}
		});
	}

	// Some hosts overlay a badge in the bottom-right corner (Netlify's "Powered by Netlify"). In
	// portrait it lands on the bottom row of the touch controls, so those move up while it's there.
	const watchHostBadge = () => document.body.classList.toggle('has-host-badge', !!document.getElementById('nl-badge-frame'));
	new MutationObserver(watchHostBadge).observe(document.body, { childList: true });
	watchHostBadge();

	input.attachTouch(ui.touch);
	new ResizeObserver(syncCanvasSize).observe(ui.canvas);
	requestAnimationFrame(inputLoop);

	boot();
	refreshLibrary();
	registerServiceWorker().catch((err) => console.warn('Service worker:', err));
}

init();
