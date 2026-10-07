/**
 * theme.js — Couleurs personnalisables, presets et thèmes sauvegardés.
 *
 * Les couleurs sont appliquées :
 *  - à l'interface via des variables CSS (--bass, --accent, --bg…)
 *  - au moteur 3D via l'événement "change" (uniforms des shaders)
 */
import { Emitter, storage } from './utils.js';

const CURRENT_KEY = 'visual-singer.theme.current.v2';
const CUSTOM_KEY = 'visual-singer.theme.custom';

/** Éléments colorables, dans l'ordre d'affichage du panneau. */
export const COLOR_KEYS = [
  { key: 'bass', label: 'Graves' },
  { key: 'mid', label: 'Médiums' },
  { key: 'treble', label: 'Aigus' },
  { key: 'peak', label: 'Pics' },
  { key: 'grid', label: 'Grille' },
  { key: 'axis', label: 'Axes' },
  { key: 'trail', label: 'Traînées' },
  { key: 'cursor', label: 'Curseur temporel' },
  { key: 'text', label: 'Texte' },
  { key: 'accent', label: 'Accent' },
  { key: 'bg', label: 'Fond' },
];

export const PRESETS = {
  Graphite:  { bass: '#ff5a4e', mid: '#f2b45a', treble: '#7cc4ff', peak: '#ffffff', grid: '#3a3b40', axis: '#74757b', trail: '#ff8a7a', cursor: '#f5f5f7', text: '#e4e4e7', accent: '#ff4d3d', bg: '#2a2b2f' },
  Midnight:  { bass: '#5b7cfa', mid: '#a78bfa', treble: '#5eead4', peak: '#ffffff', grid: '#262a36', axis: '#6b7280', trail: '#93c5fd', cursor: '#e0e7ff', text: '#e2e5f0', accent: '#6d8bff', bg: '#1c1f27' },
  Ember:     { bass: '#c2410c', mid: '#fb923c', treble: '#fde68a', peak: '#fff7e0', grid: '#3a2a24', axis: '#8a6a5c', trail: '#fdba74', cursor: '#ffedd5', text: '#f1e4dc', accent: '#f97316', bg: '#2a2321' },
  Glacier:   { bass: '#2563eb', mid: '#38bdf8', treble: '#cffafe', peak: '#ffffff', grid: '#2b3640', axis: '#6b8494', trail: '#7dd3fc', cursor: '#e0f7ff', text: '#dbeaf2', accent: '#38bdf8', bg: '#232a31' },
  Jade:      { bass: '#059669', mid: '#34d399', treble: '#bbf7d0', peak: '#f7ffd6', grid: '#26352f', axis: '#5f8574', trail: '#6ee7b7', cursor: '#ecfdf5', text: '#d9efe5', accent: '#10b981', bg: '#212a26' },
  Crimson:   { bass: '#b91c1c', mid: '#f43f5e', treble: '#fecdd3', peak: '#fff1f2', grid: '#3a2628', axis: '#8f5f64', trail: '#fb7185', cursor: '#ffe4e6', text: '#f2dfe1', accent: '#e11d48', bg: '#2a2224' },
  Nebula:    { bass: '#7c3aed', mid: '#c084fc', treble: '#f0abfc', peak: '#fdf4ff', grid: '#2f2740', axis: '#7a6a96', trail: '#d8b4fe', cursor: '#f5ecff', text: '#e6def5', accent: '#a855f7', bg: '#241f2e' },
  Cyberpunk: { bass: '#ff2a6d', mid: '#05d9e8', treble: '#f9f871', peak: '#ffffff', grid: '#1b1235', axis: '#7a5cff', trail: '#d1f7ff', cursor: '#fcee0a', text: '#e0e6ff', accent: '#ff2a6d', bg: '#0d0a16' },
  Monochrome:{ bass: '#6b6b6b', mid: '#a3a3a3', treble: '#e0e0e0', peak: '#ffffff', grid: '#333333', axis: '#737373', trail: '#cfcfcf', cursor: '#ffffff', text: '#e6e6e6', accent: '#d4d4d4', bg: '#262626' },
};

const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

export class ThemeManager extends Emitter {
  constructor() {
    super();
    const saved = storage.get(CURRENT_KEY, null);
    this.colors = { ...PRESETS.Graphite };
    this.presetName = 'Graphite';
    if (saved?.colors) {
      for (const { key } of COLOR_KEYS) if (isHex(saved.colors[key])) this.colors[key] = saved.colors[key];
      this.presetName = saved.name || 'Personnalisé';
    }
    this.custom = storage.get(CUSTOM_KEY, {}) || {};
    this.applyCss();
  }

  _commit() {
    storage.set(CURRENT_KEY, { name: this.presetName, colors: this.colors });
    this.applyCss();
    this.emit('change', this.colors);
  }

  /** Modifie une couleur. */
  set(key, hex) {
    if (!isHex(hex) || this.colors[key] === hex) return;
    this.colors = { ...this.colors, [key]: hex };
    this.presetName = 'Personnalisé';
    this._commit();
  }

  /** Applique un preset intégré ou un thème sauvegardé. */
  apply(name) {
    const src = PRESETS[name] || this.custom[name];
    if (!src) return;
    this.colors = { ...PRESETS.Graphite, ...src };
    this.presetName = name;
    this._commit();
  }

  /** Sauvegarde le thème courant sous un nom (localStorage). */
  saveCustom(name) {
    name = String(name || '').trim().slice(0, 32);
    if (!name) return false;
    this.custom = { ...this.custom, [name]: { ...this.colors } };
    this.presetName = name;
    storage.set(CUSTOM_KEY, this.custom);
    this._commit();
    return true;
  }

  deleteCustom(name) {
    if (!this.custom[name]) return;
    const next = { ...this.custom };
    delete next[name];
    this.custom = next;
    storage.set(CUSTOM_KEY, this.custom);
    this.emit('change', this.colors);
  }

  /** Exporte / importe le thème courant au format JSON. */
  toJSON() { return JSON.stringify({ name: this.presetName, colors: this.colors }, null, 2); }
  fromJSON(text) {
    try {
      const data = JSON.parse(text);
      const colors = data.colors || data;
      let n = 0;
      const next = { ...this.colors };
      for (const { key } of COLOR_KEYS) if (isHex(colors[key])) { next[key] = colors[key]; n++; }
      if (!n) return false;
      this.colors = next;
      this.presetName = data.name || 'Importé';
      this._commit();
      return true;
    } catch { return false; }
  }

  /** Pousse les couleurs dans les variables CSS de :root. */
  applyCss() {
    const root = document.documentElement.style;
    for (const { key } of COLOR_KEYS) root.setProperty(`--${key}`, this.colors[key]);
    root.setProperty('color-scheme', 'dark');
  }
}
