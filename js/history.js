/**
 * history.js : Stockage circulaire des analyses audio (pas de son brut).
 *
 * Chaque tranche conserve :
 *   timestamp, bands[BANDS] (Uint8), bass, mid, treble, intensity,
 *   rmsDb, peak, dominantFrequency
 * Mémoire : ~150 octets par tranche → 10 min à 30 tranches/s ≈ 2.7 Mo.
 *
 * Les tableaux typés sont alloués une seule fois (réalloués uniquement
 * quand la durée de rétention ou la cadence change).
 */
import { clamp } from './utils.js';

export class AudioHistory {
  /**
   * @param {number} bandCount  nombre de bandes par tranche
   * @param {number} retention  durée conservée (s)
   * @param {number} rate       tranches par seconde
   */
  constructor(bandCount, retention, rate) {
    this.bandCount = bandCount;
    this.peaks = [];          // { id, time, intensity, db, peakDb, freq, band, h, open }
    this.start = 0;
    this.length = 0;
    this.capacity = 0;
    this.configure(retention, rate);
  }

  /** (Ré)alloue les buffers en conservant les tranches les plus récentes. */
  configure(retention, rate) {
    this.retention = retention;
    this.rate = rate;
    const cap = Math.ceil(retention * rate * 1.05) + 16;
    if (cap === this.capacity) return;
    const B = this.bandCount;
    const next = {
      time: new Float64Array(cap),
      bands: new Uint8Array(cap * B),
      bass: new Float32Array(cap),
      mid: new Float32Array(cap),
      treble: new Float32Array(cap),
      intensity: new Float32Array(cap),
      rmsDb: new Float32Array(cap),
      peak: new Float32Array(cap),
      dom: new Float32Array(cap),
    };
    const keep = Math.min(this.length, cap);
    for (let k = 0; k < keep; k++) {
      const src = this._p(this.length - keep + k);
      next.time[k] = this.time_[src];
      next.bass[k] = this.bass_[src];
      next.mid[k] = this.mid_[src];
      next.treble[k] = this.treble_[src];
      next.intensity[k] = this.intensity_[src];
      next.rmsDb[k] = this.rmsDb_[src];
      next.peak[k] = this.peak_[src];
      next.dom[k] = this.dom_[src];
      next.bands.set(this.bands.subarray(src * B, src * B + B), k * B);
    }
    this.time_ = next.time;
    this.bands = next.bands;
    this.bass_ = next.bass;
    this.mid_ = next.mid;
    this.treble_ = next.treble;
    this.intensity_ = next.intensity;
    this.rmsDb_ = next.rmsDb;
    this.peak_ = next.peak;
    this.dom_ = next.dom;
    this.capacity = cap;
    this.start = 0;
    this.length = keep;
    this._prunePeaks();
  }

  clear() {
    this.start = 0;
    this.length = 0;
    this.peaks.length = 0;
  }

  /** Indice physique d'une tranche logique (0 = plus ancienne). */
  _p(i) { return (this.start + i) % this.capacity; }

  get oldestTime() { return this.length ? this.time_[this._p(0)] : 0; }
  get latestTime() { return this.length ? this.time_[this._p(this.length - 1)] : 0; }
  get duration() { return this.length ? this.latestTime - this.oldestTime : 0; }
  get memoryBytes() { return this.capacity * (this.bandCount + 8 + 7 * 4); }

  /** Ajoute une tranche (copie des valeurs de la frame). */
  push(f) {
    if (this.length === this.capacity) {
      this.start = (this.start + 1) % this.capacity;
      this.length--;
    }
    const p = this._p(this.length);
    this.time_[p] = f.time;
    this.bands.set(f.bands, p * this.bandCount);
    this.bass_[p] = f.bass;
    this.mid_[p] = f.mid;
    this.treble_[p] = f.treble;
    this.intensity_[p] = f.intensity;
    this.rmsDb_[p] = f.rmsDb;
    this.peak_[p] = f.peak;
    this.dom_[p] = f.dominantFrequency;
    this.length++;
    // Suppression de l'excédent au-delà de la durée de rétention.
    const limit = f.time - this.retention;
    while (this.length > 1 && this.time_[this._p(0)] < limit) {
      this.start = (this.start + 1) % this.capacity;
      this.length--;
    }
    if (this.peaks.length && this.peaks[0].time < this.oldestTime) this._prunePeaks();
  }

  time(i) { return this.time_[this._p(i)]; }
  dom(i) { return this.dom_[this._p(i)]; }
  intensity(i) { return this.intensity_[this._p(i)]; }
  bass(i) { return this.bass_[this._p(i)]; }
  mid(i) { return this.mid_[this._p(i)]; }
  treble(i) { return this.treble_[this._p(i)]; }
  /** Décalage dans this.bands de la tranche logique i. */
  bandOffset(i) { return this._p(i) * this.bandCount; }

  /**
   * Indice logique fractionnaire correspondant au temps t (recherche dichotomique).
   * NaN si t est hors de l'historique.
   */
  indexAt(t) {
    const n = this.length;
    if (!n) return NaN;
    if (t < this.time_[this._p(0)] || t > this.time_[this._p(n - 1)]) return NaN;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.time_[this._p(mid)] <= t) lo = mid; else hi = mid;
    }
    if (lo === hi) return lo;
    const ta = this.time_[this._p(lo)], tb = this.time_[this._p(hi)];
    return lo + clamp((t - ta) / (tb - ta || 1), 0, 1);
  }

  /**
   * Remplit `out` avec l'état interpolé au temps t.
   * @returns {boolean} false si aucune donnée à cet instant
   */
  sample(t, out) {
    const fi = this.indexAt(t);
    if (Number.isNaN(fi)) return false;
    const i0 = Math.floor(fi), i1 = Math.min(i0 + 1, this.length - 1), k = fi - i0;
    const a = this._p(i0), b = this._p(i1);
    const L = (arr) => arr[a] + (arr[b] - arr[a]) * k;
    out.time = t;
    out.bass = L(this.bass_);
    out.mid = L(this.mid_);
    out.treble = L(this.treble_);
    out.intensity = L(this.intensity_);
    out.rmsDb = L(this.rmsDb_);
    out.peak = L(this.peak_);
    out.peakDb = out.peak > 1e-7 ? 20 * Math.log10(out.peak) : -140;
    out.dominantFrequency = k < 0.5 ? this.dom_[a] : this.dom_[b];
    out.clipping = Math.max(this.peak_[a], this.peak_[b]) >= 0.995;
    const B = this.bandCount, oa = a * B, ob = b * B, bands = this.bands;
    for (let j = 0; j < B; j++) out.bands[j] = bands[oa + j] + (bands[ob + j] - bands[oa + j]) * k;
    return true;
  }

  addPeak(p) { this.peaks.push(p); }

  _prunePeaks() {
    const t0 = this.oldestTime;
    let k = 0;
    while (k < this.peaks.length && this.peaks[k].time < t0) k++;
    if (k) this.peaks.splice(0, k);
  }
}
