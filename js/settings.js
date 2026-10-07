/**
 * settings.js — Paramètres centralisés, persistés dans localStorage.
 *
 * Tous les modules lisent leurs réglages ici et écoutent l'événement "change"
 * ({ key, value }) pour réagir à chaud. Les éléments HTML portant
 * l'attribut data-setting="clé" sont reliés automatiquement (voir controls.js).
 */
import { Emitter, storage, debounce } from './utils.js';

const STORAGE_KEY = 'visual-singer.settings.v1';

export const DEFAULTS = Object.freeze({
  // --- Capture / analyse audio ---
  deviceId: '',
  rawInput: true,          // désactive echoCancellation / noiseSuppression / autoGainControl
  fftSize: 4096,
  smoothing: 0.55,         // AnalyserNode.smoothingTimeConstant
  minDb: -95,
  maxDb: -20,

  // --- Zones de fréquences (Hz) ---
  freqMin: 20,
  bassMax: 250,
  midMax: 4000,
  freqMax: 20000,

  // --- Historique ---
  retention: 60,           // secondes conservées (30 / 60 / 300 / 600)
  historyRate: 30,         // tranches d'analyse stockées par seconde

  // --- Vue 3D ---
  window3d: 10,            // secondes visibles sur le terrain (zoom temporel 3D)
  heightScale: 1,
  quality: 'HIGH',         // LOW | MEDIUM | HIGH | ULTRA
  wireframe: true,
  contours: true,
  showLabels: true,
  hudVisible: true,

  // --- Traînées ---
  trailMode: 'medium',     // none | low | medium | high | persistent
  trailLength: 6,          // secondes

  // --- Pics ---
  peakThreshold: 0.65,     // intensité 0..1 déclenchant un pic

  // --- Caméra ---
  autoRotate: false,
  autoRotateSpeed: 0.12,   // rad/s

  // --- Lecture ---
  playbackSpeed: 1,
  timelineZoom: 60,        // secondes visibles sur la timeline (0 = tout)

  // --- Interface ---
  sidebarCollapsed: false,

  // --- Serveur (optionnel) ---
  serverSource: 'simulated', // simulated | websocket | http | json | off
  serverUrl: 'ws://localhost:8765',
  serverInterval: 2000,
});

export class Settings extends Emitter {
  constructor() {
    super();
    const saved = storage.get(STORAGE_KEY, {});
    this.values = { ...DEFAULTS };
    // On ne reprend que les clés connues, avec le bon type.
    for (const [k, v] of Object.entries(saved || {})) {
      if (k in DEFAULTS && typeof v === typeof DEFAULTS[k]) this.values[k] = v;
    }
    this._save = debounce(() => storage.set(STORAGE_KEY, this.values), 250);
  }

  get(key) { return this.values[key]; }

  set(key, value) {
    if (!(key in DEFAULTS)) { console.warn('[settings] clé inconnue', key); return; }
    if (typeof DEFAULTS[key] === 'number') value = Number(value);
    if (typeof DEFAULTS[key] === 'boolean') value = Boolean(value);
    if (this.values[key] === value) return;
    this.values[key] = value;
    this._save();
    this.emit('change', { key, value });
  }

  /** Remet tous les paramètres par défaut. */
  reset() {
    for (const k of Object.keys(DEFAULTS)) this.set(k, DEFAULTS[k]);
  }
}
