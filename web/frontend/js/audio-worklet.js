// Plays the core's audio from the ring in WASM memory (struct WebAudioRing in web_host.cpp):
// u32 capacity, u32 writePos, u32 readPos, then interleaved s16 stereo frames.
// Resamples linearly from the core's 44.1kHz to whatever the AudioContext runs at.

class PPSSPPAudio extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const { buffer, ringPtr, sourceRate } = options.processorOptions;
		this.header = new Uint32Array(buffer, ringPtr, 3);
		this.capacity = this.header[0];
		this.samples = new Int16Array(buffer, ringPtr + 12, this.capacity * 2);
		this.step = sourceRate / sampleRate;
		this.frac = 0;
		this.last = [0, 0];
	}

	process(inputs, outputs) {
		const [left, right] = outputs[0];
		const write = Atomics.load(this.header, 1);
		let read = Atomics.load(this.header, 2);
		const cap = this.capacity;
		for (let i = 0; i < left.length; i++) {
			// Need the frame at `read` and the next one to interpolate.
			if (((write - read) >>> 0) < 2) {
				// Underrun: hold the last value so it fades less abruptly than a click.
				left[i] = this.last[0];
				right[i] = this.last[1];
				continue;
			}
			const a = (read % cap) * 2;
			const b = ((read + 1) % cap) * 2;
			const t = this.frac;
			const l = (this.samples[a] + (this.samples[b] - this.samples[a]) * t) / 32768;
			const r = (this.samples[a + 1] + (this.samples[b + 1] - this.samples[a + 1]) * t) / 32768;
			left[i] = l;
			right[i] = r;
			this.last[0] = l * 0.98;
			this.last[1] = r * 0.98;
			this.frac += this.step;
			const whole = Math.floor(this.frac);
			this.frac -= whole;
			read = (read + whole) >>> 0;
		}
		Atomics.store(this.header, 2, read);
		return true;
	}
}

registerProcessor('ppsspp-audio', PPSSPPAudio);
