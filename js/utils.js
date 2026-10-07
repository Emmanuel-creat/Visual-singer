/**
 * utils.js — Petits outils partagés (événements, maths, formatage, stockage sûr).
 */

/** Émetteur d'événements minimaliste (on / off / emit). */
export class Emitter {
  constructor() { this._handlers = new Map(); }
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { this._handlers.get(type)?.delete(fn); }
  emit(type, payload) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (err) { console.error(`[Emitter:${type}]`, err); }
    }
  }
}

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Facteur de lissage indépendant du framerate. */
export const damp = (lambda, dt) => 1 - Math.exp(-lambda * dt);

/** 83.4 → "1:23.4" ; 3725 → "1:02:05". */
export function formatClock(sec, decimals = 1) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = decimals > 0 ? s.toFixed(decimals).padStart(3 + decimals, '0') : String(Math.floor(s)).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

/** Durée relative courte : -12.4 → "-12.4s", -75 → "-1:15". */
export function formatOffset(sec) {
  const sign = sec < 0 ? '-' : '+';
  const a = Math.abs(sec);
  if (a < 60) return `${sign}${a.toFixed(1)}s`;
  return `${sign}${Math.floor(a / 60)}:${String(Math.floor(a % 60)).padStart(2, '0')}`;
}

/** 1240 → "1.24 kHz" ; 86 → "86 Hz". */
export function formatFreq(hz, compact = false) {
  if (!hz || !Number.isFinite(hz)) return '—';
  if (hz >= 1000) {
    const k = hz / 1000;
    return `${k >= 10 ? k.toFixed(1) : k.toFixed(2)}${compact ? 'k' : ' kHz'}`;
  }
  return `${Math.round(hz)}${compact ? '' : ' Hz'}`;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** Nom de note musicale le plus proche (A4 = 440 Hz) + écart en cents. */
export function noteName(hz) {
  if (!hz || hz < 16) return { name: '—', cents: 0 };
  const midi = 69 + 12 * Math.log2(hz / 440);
  const n = Math.round(midi);
  return { name: `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`, cents: Math.round((midi - n) * 100) };
}

/** Amplitude linéaire → dBFS. */
export const toDb = (v) => (v > 1e-7 ? 20 * Math.log10(v) : -140);

/** Conversion hex "#rrggbb" ↔ [r,g,b] (0..1). */
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** localStorage protégé : ne plante jamais (navigation privée, stockage bloqué…). */
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

/** Exécute fn au plus une fois toutes les `ms` millisecondes (appel final garanti). */
export function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
