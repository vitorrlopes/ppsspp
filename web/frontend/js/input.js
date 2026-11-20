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

export class InputManager {
	constructor() {
		this.keyMask = 0;
		this.touchMask = 0;
		this.keyStick = [0, 0];
		this.touchStick = [0, 0];
		this.enabled = false;
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
		this.keyMask = mask;
		this.keyStick = stick.map((v) => Math.max(-1, Math.min(1, v)));
	}

	// Called once per animation frame. Returns { mask, stick: [x, y] }.
	poll() {
		let mask = this.keyMask | this.touchMask;
		let x = this.keyStick[0] + this.touchStick[0];
		let y = this.keyStick[1] + this.touchStick[1];
		for (const pad of navigator.getGamepads?.() ?? []) {
			if (!pad || !pad.connected) {
				continue;
			}
			pad.buttons.forEach((b, i) => {
				if (b.pressed && PADMAP[i] !== undefined) {
					mask |= 1 << PADMAP[i];
				}
			});
			x += applyDeadzone(pad.axes[0] ?? 0);
			y += applyDeadzone(pad.axes[1] ?? 0);
		}
		if (!this.enabled) {
			return { mask: 0, stick: [0, 0] };
		}
		return { mask, stick: [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))] };
	}

	// Wires up the on-screen controls: elements with data-button="CROSS" etc., and one data-stick.
	attachTouch(root) {
		const pressed = new Map();  // pointerId -> bit
		const update = () => {
			let mask = 0;
			for (const bit of pressed.values()) {
				mask |= 1 << bit;
			}
			this.touchMask = mask;
		};
		const buttonAt = (x, y) => {
			const el = document.elementFromPoint(x, y)?.closest('[data-button]');
			return el && root.contains(el) ? Button[el.dataset.button] : undefined;
		};
		// Sliding a finger from one button onto another (d-pad diagonals, say) follows the finger.
		const onMove = (e) => {
			if (!pressed.has(e.pointerId)) {
				return;
			}
			const bit = buttonAt(e.clientX, e.clientY);
			if (bit === undefined) {
				pressed.delete(e.pointerId);
			} else {
				pressed.set(e.pointerId, bit);
			}
			update();
		};
		root.querySelectorAll('[data-button]').forEach((el) => {
			el.addEventListener('pointerdown', (e) => {
				e.preventDefault();
				el.releasePointerCapture?.(e.pointerId);
				pressed.set(e.pointerId, Button[el.dataset.button]);
				navigator.vibrate?.(8);
				update();
			});
		});
		root.addEventListener('pointermove', onMove);
		const release = (e) => {
			pressed.delete(e.pointerId);
			update();
		};
		root.addEventListener('pointerup', release);
		root.addEventListener('pointercancel', release);

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
