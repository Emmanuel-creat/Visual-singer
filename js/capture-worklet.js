/**
 * capture-worklet.js : AudioWorklet qui transmet le signal brut au thread principal.
 *
 * Le son est regroupé par blocs de 4096 échantillons (≈ 85 ms à 48 kHz)
 * pour limiter le nombre de messages. Il n'est jamais renvoyé vers les
 * haut-parleurs : il alimente uniquement le tampon de reconnaissance.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4096);
    this.fill = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const n = Math.min(ch.length - i, this.block.length - this.fill);
        this.block.set(ch.subarray(i, i + n), this.fill);
        this.fill += n;
        i += n;
        if (this.fill === this.block.length) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(4096);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('vs-capture', CaptureProcessor);
