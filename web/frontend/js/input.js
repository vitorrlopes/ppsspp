// Keyboard, gamepad and touch, merged into one libretro joypad bitmask plus the left stick.

// libretro RETRO_DEVICE_ID_JOYPAD_* bits, named after the PSP buttons the core maps them to.
export const Button = Object.freeze({
	CROSS: 0,      // B
	SQUARE: 1,     // Y
	SELECT: 2,
	START: 3,
	UP: 4,
	DOWN: 5,
	LEFT: 6,
	RIGHT: 7,
	CIRCLE: 8,     // A
	TRIANGLE: 9,   // X
	L: 10,
	R: 11,
});

const KEYMAP = {
	ArrowUp: Button.UP, ArrowDown: Button.DOWN, ArrowLeft: Button.LEFT, ArrowRight: Button.RIGHT,
	KeyX: Button.CROSS, KeyZ: Button.CIRCLE, KeyA: Button.SQUARE, KeyS: Button.TRIANGLE,
	KeyQ: Button.L, KeyW: Button.R,
	Space: Button.START, Enter: Button.START, KeyV: Button.SELECT, ShiftRight: Button.SELECT,
};

// Keys for the analog stick: [axis, direction].
const STICK_KEYS = { KeyI: [1, -1], KeyK: [1, 1], KeyJ: [0, -1], KeyL: [0, 1] };

// The "standard" Gamepad API layout.
const PADMAP = {
	0: Button.CROSS, 1: Button.CIRCLE, 2: Button.SQUARE, 3: Button.TRIANGLE,
	4: Button.L, 5: Button.R, 6: Button.L, 7: Button.R,
	8: Button.SELECT, 9: Button.START,
	12: Button.UP, 13: Button.DOWN, 14: Button.LEFT, 15: Button.RIGHT,
};

const DEADZONE = 0.15;

function applyDeadzone(v) {
	return Math.abs(v) < DEADZONE ? 0 : v;
}

// Eight-way d-pad: the direction from the cluster's center, in 45 degree sectors. The middle
// is neutral, so a thumb resting there presses nothing.
const DPAD_SECTORS = [
	1 << Button.RIGHT, (1 << Button.RIGHT) | (1 << Button.DOWN), 1 << Button.DOWN, (1 << Button.DOWN) | (1 << Button.LEFT),
	1 << Button.LEFT, (1 << Button.LEFT) | (1 << Button.UP), 1 << Button.UP, (1 << Button.UP) | (1 << Button.RIGHT),
];

function dpadBits(rect, x, y) {
	const dx = x - (rect.left + rect.width / 2);
	const dy = y - (rect.top + rect.height / 2);
	if (Math.hypot(dx, dy) < rect.width * 0.12) {
		return 0;
	}
	return DPAD_SECTORS[Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7];
}

function nearest(elements, x, y) {
	let best = null;
	let bestDist = Infinity;
	for (const el of elements) {
		const r = el.getBoundingClientRect();
		const dist = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
		if (dist < bestDist) {
			bestDist = dist;
			best = el;
		}
	}
	return best;
}

export class InputManager {
	constructor() {
		this.keyMask = 0;
		this.touchMask = 0;
		this.keyStick = [0, 0];
		this.touchStick = [0, 0];
		this.enabled = false;
		// Buttons that went down since the last poll, however briefly (see WebInput.pressedSince).
		this.pressedSince = 0;
		this._padMask = 0;
		this._keys = new Set();
		window.addEventListener('keydown', (e) => this._onKey(e, true));
		window.addEventListener('keyup', (e) => this._onKey(e, false));
		window.addEventListener('blur', () => this._releaseKeys());
	}

	_onKey(e, down) {
		if (!this.enabled || e.target.closest?.('input, select, textarea, dialog')) {
			return;
		}
		const bit = KEYMAP[e.code];
		const stick = STICK_KEYS[e.code];
		if (bit === undefined && !stick) {
			return;
		}
		e.preventDefault();
		if (down) {
			this._keys.add(e.code);
		} else {
			this._keys.delete(e.code);
		}
		this._recomputeKeys();
	}

	_releaseKeys() {
		this._keys.clear();
		this._recomputeKeys();
	}

	_recomputeKeys() {
		let mask = 0;
		const stick = [0, 0];
		for (const code of this._keys) {
			if (KEYMAP[code] !== undefined) {
				mask |= 1 << KEYMAP[code];
			}
			const s = STICK_KEYS[code];
			if (s) {
				stick[s[0]] += s[1];
			}
		}
		this.pressedSince |= mask & ~this.keyMask;
		this.keyMask = mask;
		this.keyStick = stick.map((v) => Math.max(-1, Math.min(1, v)));
	}

	// Called once per animation frame. Returns { mask, pressed, stick: [x, y] }, where pressed has
	// the buttons that went down since the last call, even if they're already up again.
	poll() {
		let padMask = 0;
		let x = this.keyStick[0] + this.touchStick[0];
		let y = this.keyStick[1] + this.touchStick[1];
		for (const pad of navigator.getGamepads?.() ?? []) {
			if (!pad || !pad.connected) {
				continue;
			}
			pad.buttons.forEach((b, i) => {
				if (b.pressed && PADMAP[i] !== undefined) {
					padMask |= 1 << PADMAP[i];
				}
			});
			x += applyDeadzone(pad.axes[0] ?? 0);
			y += applyDeadzone(pad.axes[1] ?? 0);
		}
		const pressed = this.pressedSince | (padMask & ~this._padMask);
		this.pressedSince = 0;
		this._padMask = padMask;
		if (!this.enabled) {
			return { mask: 0, pressed: 0, stick: [0, 0] };
		}
		const mask = this.keyMask | this.touchMask | padMask;
		return { mask, pressed, stick: [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))] };
	}

	// Wires up the on-screen controls: elements with data-button="CROSS" etc., and one data-stick.
	// Wires up the on-screen controls: the .dpad and .face clusters, the other data-button
	// elements, and one data-stick. Each finger belongs to the control it first touched until it
	// lifts, and drifting off a button's edge doesn't release it: thumbs holding accelerate and
	// steer in a racing game drift a lot.
	attachTouch(root) {
		const active = new Map();  // pointerId -> button bitmask
		const buttons = [...root.querySelectorAll('[data-button]')];
		const update = () => {
			let mask = 0;
			for (const bits of active.values()) {
				mask |= bits;
			}
			this.pressedSince |= mask & ~this.touchMask;
			this.touchMask = mask;
			for (const el of buttons) {
				el.classList.toggle('pressed', (mask & (1 << Button[el.dataset.button])) !== 0);
			}
		};
		const zone = (el, resolve) => {
			el.addEventListener('pointerdown', (e) => {
				e.preventDefault();
				el.setPointerCapture(e.pointerId);
				active.set(e.pointerId, resolve(e));
				navigator.vibrate?.(8);
				update();
			});
			el.addEventListener('pointermove', (e) => {
				if (active.has(e.pointerId)) {
					active.set(e.pointerId, resolve(e));
					update();
				}
			});
			const end = (e) => {
				if (active.delete(e.pointerId)) {
					update();
				}
			};
			el.addEventListener('pointerup', end);
			el.addEventListener('pointercancel', end);
			el.addEventListener('lostpointercapture', end);
		};

		const dpad = root.querySelector('.dpad');
		if (dpad) {
			zone(dpad, (e) => dpadBits(dpad.getBoundingClientRect(), e.clientX, e.clientY));
		}
		const face = root.querySelector('.face');
		if (face) {
			const faceButtons = [...face.querySelectorAll('[data-button]')];
			zone(face, (e) => 1 << Button[nearest(faceButtons, e.clientX, e.clientY).dataset.button]);
		}
		for (const el of buttons) {
			if (!el.closest('.dpad, .face')) {
				zone(el, () => 1 << Button[el.dataset.button]);
			}
		}
		// Holding a button is a long press. Unless the context menu is stopped, Chrome on Android
		// opens it and cancels the touch, which let go of the button while the finger was still down.
		root.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });

		const stick = root.querySelector('[data-stick]');
		if (stick) {
			this._attachStick(stick);
		}
	}

	_attachStick(stick) {
		const knob = stick.querySelector('.knob');
		let active = null;
		const move = (e) => {
			const r = stick.getBoundingClientRect();
			const radius = r.width / 2;
			let dx = (e.clientX - (r.left + radius)) / radius;
			let dy = (e.clientY - (r.top + radius)) / radius;
			const len = Math.hypot(dx, dy);
			if (len > 1) {
				dx /= len;
				dy /= len;
			}
			this.touchStick = [dx, dy];
			knob.style.transform = `translate(${dx * 50}%, ${dy * 50}%)`;
		};
		stick.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			active = e.pointerId;
			stick.setPointerCapture(e.pointerId);
			move(e);
		});
		stick.addEventListener('pointermove', (e) => {
			if (e.pointerId === active) {
				move(e);
			}
		});
		const end = (e) => {
			if (e.pointerId !== active) {
				return;
			}
			active = null;
			this.touchStick = [0, 0];
			knob.style.transform = '';
		};
		stick.addEventListener('pointerup', end);
		stick.addEventListener('pointercancel', end);
	}
}
