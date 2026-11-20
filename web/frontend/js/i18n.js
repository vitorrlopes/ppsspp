// UI strings. Portuguese first; anything else falls back to English.

const STRINGS = {
	pt: {
		settings: 'Configurações',
		about: 'Sobre',
		booting: 'Carregando o emulador…',
		bootFailed: 'O emulador não pôde ser iniciado: ',
		updateReady: 'Há uma nova versão disponível.',
		updateNow: 'Atualizar',
		dropHint: 'Arraste jogos de PSP aqui (ISO, CSO, CHD, PBP) ou',
		addGame: 'Adicionar jogo',
		importing: 'Importando',
		emptyLibrary: 'Nenhum jogo ainda. Os jogos ficam salvos neste navegador.',
		play: 'Jogar',
		remove: 'Remover',
		confirmRemove: 'Remover "{0}" da biblioteca? Os saves não são apagados.',
		storageUsed: '{0} usados de {1} disponíveis',
		quotaExceeded: 'Não há espaço suficiente no navegador para este jogo.',
		notAGame: 'Formato não suportado: {0}',
		paused: 'Pausado',
		resume: 'Continuar',
		slot: 'Slot',
		saveState: 'Salvar estado',
		loadState: 'Carregar estado',
		stateSaved: 'Estado salvo.',
		stateLoaded: 'Estado carregado.',
		fullscreen: 'Tela cheia',
		touchControls: 'Controles na tela',
		showFps: 'Mostrar FPS',
		gamepadConnected: 'Controle conectado: {0}',
		gamepadDisconnected: 'Controle desconectado. Jogo pausado.',
		crashedTitle: 'O emulador parou',
		crashedText: 'O emulador encontrou um erro e não pode continuar. Seu progresso salvo no jogo e os save states estão guardados. Recarregue para jogar de novo.',
		stalledTitle: 'O jogo parece travado',
		stalledText: 'Nenhum quadro foi emulado nos últimos segundos. Pode ser só um carregamento lento, ou o emulador travou.',
		diagnostics: 'Diagnóstico',
		copyReport: 'Copiar diagnóstico',
		reportCopied: 'Diagnóstico copiado.',
		keepWaiting: 'Continuar esperando',
		reload: 'Recarregar',
		reset: 'Reiniciar',
		quit: 'Sair do jogo',
		loadingGame: 'Iniciando o jogo…',
		gameStopped: 'O jogo foi interrompido pelo emulador.',
		settingsHint: 'Algumas opções só valem depois de reiniciar o jogo.',
		close: 'Fechar',
		aboutText: 'PPSSPP Web roda o emulador PPSSPP no navegador. Use apenas jogos que você possui. Jogos e saves ficam guardados só neste navegador.',
		licenses: 'Licenças',
		licenseCombined: 'Por incluir código GPL-3.0, este aplicativo como um todo é distribuído sob a GPL-3.0.',
		sourceCode: 'Código-fonte desta versão:',
		noIsolation: 'Este site precisa dos cabeçalhos COOP/COEP para usar threads. Verifique a hospedagem.',
	},
	en: {
		settings: 'Settings',
		about: 'About',
		booting: 'Loading the emulator…',
		bootFailed: 'The emulator couldn\'t start: ',
		updateReady: 'A new version is available.',
		updateNow: 'Update',
		dropHint: 'Drop PSP games here (ISO, CSO, CHD, PBP) or',
		addGame: 'Add game',
		importing: 'Importing',
		emptyLibrary: 'No games yet. Games are stored in this browser.',
		play: 'Play',
		remove: 'Remove',
		confirmRemove: 'Remove "{0}" from the library? Saves are kept.',
		storageUsed: '{0} used of {1} available',
		quotaExceeded: 'There isn\'t enough browser storage for this game.',
		notAGame: 'Unsupported format: {0}',
		paused: 'Paused',
		resume: 'Resume',
		slot: 'Slot',
		saveState: 'Save state',
		loadState: 'Load state',
		stateSaved: 'State saved.',
		stateLoaded: 'State loaded.',
		fullscreen: 'Fullscreen',
		touchControls: 'On-screen controls',
		showFps: 'Show FPS',
		gamepadConnected: 'Controller connected: {0}',
		gamepadDisconnected: 'Controller disconnected. Game paused.',
		crashedTitle: 'The emulator stopped',
		crashedText: 'The emulator hit an error and can\'t go on. Your in-game saves and save states are kept. Reload to play again.',
		stalledTitle: 'The game seems stuck',
		stalledText: 'No frames were emulated for a few seconds. It may just be a slow load, or the emulator hung.',
		diagnostics: 'Diagnostics',
		copyReport: 'Copy diagnostics',
		reportCopied: 'Diagnostics copied.',
		keepWaiting: 'Keep waiting',
		reload: 'Reload',
		reset: 'Reset',
		quit: 'Quit game',
		loadingGame: 'Starting the game…',
		gameStopped: 'The emulator stopped the game.',
		settingsHint: 'Some options only apply after restarting the game.',
		close: 'Close',
		aboutText: 'PPSSPP Web runs the PPSSPP emulator in the browser. Only use games you own. Games and saves are stored in this browser only.',
		licenses: 'Licenses',
		licenseCombined: 'Since it includes GPL-3.0 code, this app as a whole is distributed under the GPL-3.0.',
		sourceCode: 'Source code of this version:',
		noIsolation: 'This site needs the COOP/COEP headers to use threads. Check the hosting.',
	},
};

const lang = (navigator.language || 'en').toLowerCase().startsWith('pt') ? 'pt' : 'en';
document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';

export function t(key, ...args) {
	const s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
	return s.replace(/\{(\d)\}/g, (_, i) => args[i] ?? '');
}

export function applyTranslations(root = document) {
	root.querySelectorAll('[data-i18n]').forEach((el) => {
		el.textContent = t(el.dataset.i18n);
	});
	root.querySelectorAll('[data-i18n-title]').forEach((el) => {
		el.title = t(el.dataset.i18nTitle);
		el.setAttribute('aria-label', el.title);
	});
}

export function formatBytes(bytes) {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	while (bytes >= 1024 && i < units.length - 1) {
		bytes /= 1024;
		i++;
	}
	return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}
