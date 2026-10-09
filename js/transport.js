/**
 * transport.js : État de lecture : direct, pause, lecture (avant/arrière).
 *
 * Le curseur temporel (cursor, en secondes de session) est la seule
 * source de vérité pour "l'instant affiché". L'enregistrement continue
 * en arrière-plan quel que soit le mode (comme un magnétoscope numérique).
 */
import { Emitter, clamp } from './utils.js';

export const SPEEDS = [-4, -2, -1, -0.5, 0.25, 0.5, 1, 2, 4];

export class Transport extends Emitter {
  constructor(history) {
    super();
    this.history = history;
    this.mode = 'live';   // live | paused | playing
    this.speed = 1;
    this.cursor = 0;
  }

  get isLive() { return this.mode === 'live'; }
  get isPlaying() { return this.mode === 'playing'; }

  _set(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit('change', this);
  }

  /** Avance le curseur ; appelé à chaque image. `liveTime` = instant affiché en direct. */
  update(dt, liveTime) {
    const h = this.history;
    if (this.mode === 'live') { this.cursor = liveTime; return; }
    if (this.mode === 'playing') {
      this.cursor += dt * this.speed;
      if (this.speed > 0 && this.cursor >= liveTime) { this.goLive(); return; }
      if (this.speed < 0 && h.length && this.cursor <= h.oldestTime) {
        this.cursor = h.oldestTime;
        this._set('paused');
      }
    }
    // L'historique a pu "glisser" sous un curseur en pause.
    if (h.length) this.cursor = clamp(this.cursor, h.oldestTime, liveTime);
  }

  play() {
    if (this.mode === 'live') return;
    if (this.speed > 0 && this.cursor >= this.history.latestTime - 0.05) { this.goLive(); return; }
    this._set('playing');
  }

  pause() {
    if (this.mode === 'paused') return;
    this._set('paused');
  }

  togglePlay() {
    if (this.mode === 'playing' || this.mode === 'live') this.pause(); else this.play();
  }

  goLive() { this._set('live'); }

  /** Déplace le curseur à un instant précis (quitte le direct). */
  seek(t) {
    const h = this.history;
    if (!h.length) return;
    this.cursor = clamp(t, h.oldestTime, h.latestTime);
    if (this.mode === 'live') this._set('paused');
    else this.emit('change', this);
  }

  /** Recule (dt < 0) ou avance (dt > 0) de dt secondes. */
  step(dt) {
    const target = this.cursor + dt;
    if (dt > 0 && target >= this.history.latestTime) { this.goLive(); return; }
    this.seek(target);
  }

  setSpeed(s) {
    this.speed = s;
    this.emit('change', this);
  }

  /** Lecture arrière / avant rapide : enchaîne les vitesses à chaque appui. */
  shuttle(direction) {
    const cur = this.mode === 'playing' && Math.sign(this.speed) === direction ? Math.abs(this.speed) : 0.5;
    const next = Math.min(4, cur * 2);
    if (direction > 0 && this.mode === 'live') return;
    this.speed = direction * next;
    this._set('playing');
    this.emit('change', this);
  }
}
