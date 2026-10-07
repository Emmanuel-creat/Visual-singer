/**
 * persist.js — Sauvegarde sur le Bureau via le serveur local (server.py).
 *
 * Si l'application est servie par `python server.py`, les réglages, thèmes,
 * détections et extraits audio sont écrits dans « Bureau/Visual Singer ».
 * Avec un simple `python -m http.server`, l'API est absente : on se replie
 * sur le localStorage du navigateur (aucune erreur bloquante).
 */
import { Emitter, debounce } from './utils.js';

export class DesktopStore extends Emitter {
  constructor() {
    super();
    this.available = false;
    this.dataDir = '';
    this._pendingState = null;
    this._flush = debounce(() => this._sendState(), 800);
  }

  async init() {
    try {
      const res = await fetch('api/info', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const info = await res.json();
      this.available = !!info.ok;
      this.dataDir = info.dataDir || '';
    } catch {
      this.available = false;
    }
    this.emit('status', { available: this.available, dataDir: this.dataDir });
    return this.available;
  }

  async loadState() {
    if (!this.available) return null;
    try { return await (await fetch('api/state', { cache: 'no-store' })).json(); } catch { return null; }
  }

  /** Enregistre (avec un léger délai) l'état complet : { settings, theme, customThemes }. */
  saveState(state) {
    if (!this.available) return;
    this._pendingState = state;
    this._flush();
  }

  async _sendState() {
    const body = JSON.stringify(this._pendingState);
    try { await fetch('api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }); } catch { /* serveur arrêté */ }
  }

  async loadDetections() {
    if (!this.available) return [];
    try { return await (await fetch('api/detections', { cache: 'no-store' })).json(); } catch { return []; }
  }

  async saveDetection(record) {
    if (!this.available) return false;
    try {
      const res = await fetch('api/detection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
      return res.ok;
    } catch { return false; }
  }

  /** Écrit un extrait WAV 16 bits mono. Renvoie le chemin relatif du fichier ou ''. */
  async saveClip(name, samples, sampleRate) {
    if (!this.available || !samples) return '';
    try {
      const res = await fetch('api/clip', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav', 'X-Clip-Name': asciiName(name) },
        body: encodeWav(samples, sampleRate),
      });
      const out = await res.json();
      return out.file || '';
    } catch { return ''; }
  }
}

/** Nom de fichier ASCII (les en-têtes HTTP n'acceptent pas les accents). */
function asciiName(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 90) || 'son';
}

/** Float32 [-1, 1] → fichier WAV PCM 16 bits mono. */
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
