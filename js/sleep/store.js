/**
 * store.js — Nuits enregistrées dans « Bureau/Visual Singer/sommeil » (via server.py).
 */
import { DesktopStore, encodeWav } from '../persist.js';

const asciiName = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 90) || 'son';

export class SleepStore extends DesktopStore {
  async listNights() {
    if (!this.available) return [];
    try { return await (await fetch('api/sleep/nights', { cache: 'no-store' })).json(); } catch { return []; }
  }

  async loadNight(id) {
    if (!this.available) return null;
    try {
      const res = await fetch(`api/sleep/night?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  async saveNight(night) {
    if (!this.available || !night || night.demo) return false;
    try {
      const res = await fetch(`api/sleep/night?id=${encodeURIComponent(night.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(night),
      });
      return res.ok;
    } catch { return false; }
  }

  async deleteNight(id) {
    if (!this.available) return false;
    try {
      const res = await fetch(`api/sleep/night?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.ok ? (await res.json()).trash || true : false;
    } catch { return false; }
  }

  /** Annule une mise à la corbeille (nom renvoyé par deleteNight). */
  async restoreNight(trash) {
    try {
      const res = await fetch('api/sleep/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trash }) });
      return res.ok;
    } catch { return false; }
  }

  /** Extrait WAV d'un événement. Renvoie le chemin relatif (servi sous /data/…) ou ''. */
  async saveClip(nightId, name, samples, sampleRate) {
    if (!this.available || !samples) return '';
    try {
      const res = await fetch(`api/sleep/clip?id=${encodeURIComponent(nightId)}`, {
        method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Clip-Name': asciiName(name) }, body: encodeWav(samples, sampleRate),
      });
      return (await res.json()).file || '';
    } catch { return ''; }
  }

  clipUrl(file) { return file ? `data/${file.split('/').map(encodeURIComponent).join('/')}` : ''; }
}
