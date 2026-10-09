/**
 * monitor.js : Surveillance acoustique d'une nuit.
 *
 * Le traitement est piloté par les blocs audio du worklet (et non par des
 * minuteries), ce qui le rend robuste quand l'onglet passe en arrière-plan.
 *
 *   bloc audio (≈85 ms) ─▶ enveloppe 100 ms ─▶ niveau par seconde
 *                          └─▶ chaque seconde : YAMNet sur les 1,9 s précédentes
 *   seconde ─▶ scores par catégorie ─▶ épisodes (ronflement, toux, paroles…)
 *          └─▶ suivi respiratoire ─▶ pauses suspectes
 *   minute  ─▶ activité, rythme respiratoire (autocorrélation de l'enveloppe)
 *
 * Seuls de courts extraits audio des événements sont conservés.
 */
import { Emitter, clamp } from '../utils.js';
import { loadTf, parseClassMap, resample } from '../recognizer.js';
import { YAMNET_FR } from '../sound-labels.js';
import { CATS, CLASS_TO_CAT, GASP_SNORT } from './categories.js';
import { summarize } from './analysis.js';

const DETECT_CATS = ['snore', 'cough', 'sneeze', 'speech', 'vocal', 'brux', 'move', 'env'];
const PAUSE_MIN = 10;      // s de silence respiratoire pour une pause suspecte
const PAUSE_MAX = 90;      // au-delà : sans doute un réveil / changement de position
const AUTOSAVE_EVERY = 120; // s

const pad = (n) => String(n).padStart(2, '0');
export function nightId(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

export class SleepMonitor extends Emitter {
  constructor(audio, store, settings) {
    super();
    this.audio = audio;
    this.store = store;
    this.settings = settings;
    this.state = 'idle';          // idle | loading | recording
    this.night = null;
    this.busy = false;
    this._onBlock = (b) => this._block(b);
  }

  /* ------------------------------------------------------------ Modèle --- */

  async loadModel() {
    if (this.yamnet) return;
    this.emit('status', { message: 'Chargement de TensorFlow.js…' });
    const tf = await loadTf();
    this.tf = tf;
    try { await tf.setBackend('webgl'); } catch { await tf.setBackend('cpu'); }
    await tf.ready();
    const base = new URL('../../models/yamnet/', import.meta.url).href;
    this.emit('status', { message: 'Chargement du modèle de classification des sons…' });
    this.yamnet = await tf.loadGraphModel(`${base}model.json`);
    this.names = parseClassMap(await (await fetch(`${base}yamnet_class_map.csv`)).text());
    tf.tidy(() => this.yamnet.predict(tf.zeros([16000])));
  }

  /* ---------------------------------------------------- Début / fin --- */

  async start() {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    this.emit('state', this.state);
    try {
      await this.loadModel();
      // Micro par défaut ; une source déjà active (fichier, démo) est acceptée pour les tests.
      if (!this.audio.active) await this.audio.connectMicrophone();
      if (!this.audio.active) throw new Error(this.audio.error?.message || 'Microphone indisponible');
    } catch (err) {
      this.state = 'idle';
      this.emit('state', this.state);
      this.emit('error', err);
      return;
    }
    const sr = this.audio.sampleRate;
    const now = new Date();
    this.night = {
      id: nightId(now), version: 1, app: 'Visual Singer - Sommeil',
      start: now.getTime(), end: null, sampleRate: sr,
      lv: [], sc: [], ss: [], minutes: [], events: [], pauses: [], summary: null,
    };
    // Accumulateurs.
    this.chunkLen = Math.round(sr / 10);
    this.acc = 0; this.accN = 0;
    this.env10 = [];              // enveloppe 100 ms de la minute en cours (dB)
    this.secChunks = [];          // énergies des 10 derniers blocs de 100 ms
    this.t = 0;                   // secondes écoulées
    this.open = {};               // épisodes ouverts par catégorie
    this.prevActive = {};
    this.floorWin = [];           // niveaux des 5 dernières minutes (plancher de bruit)
    this.floor = -70;
    this.resp = { last: -1e9, silent: 0, valid: false, snoreHist: [], breathHist: [] };
    this.clipBudget = Object.fromEntries(Object.keys(CATS).map((k) => [k, this.settings.clipsPerCategory]));
    this.minuteAcc = this._newMinute();
    this.queued = 0;
    this.chain = Promise.resolve();
    this.pendingClips = new Set();
    this.state = 'recording';
    this.audio.on('block', this._onBlock);
    this._wakeLock();
    this.emit('state', this.state);
    this.emit('night', this.night);
  }

  async stop() {
    if (this.state !== 'recording') return;
    this.audio.off('block', this._onBlock);
    await this.chain;                       // termine les secondes en file d'attente
    for (const cat of Object.keys(this.open)) this._closeEpisode(cat);
    this.night.end = Date.now();
    this._closeMinute();
    await Promise.allSettled([...this.pendingClips]);   // chemins des extraits inclus dans la sauvegarde finale
    this.night.summary = summarize(this.night);
    this.state = 'idle';
    this._releaseWake();
    const saved = await this._save();
    this.emit('state', this.state);
    this.emit('finished', { night: this.night, saved });
    if (this.settings.stopMicAfter) this.audio.stop();
    return this.night;
  }

  async _save() {
    if (!this.night) return false;
    this.night.summary = summarize(this.night);
    return this.store.saveNight(this.night);
  }

  async _wakeLock() {
    try {
      this.wake = await navigator.wakeLock?.request('screen');
      if (!this._visHandler) {
        this._visHandler = () => { if (document.visibilityState === 'visible' && this.state === 'recording') this._wakeLock(); };
        document.addEventListener('visibilitychange', this._visHandler);
      }
    } catch { /* non supporté ou refusé */ }
  }

  _releaseWake() { try { this.wake?.release(); } catch { /* ignore */ } this.wake = null; }

  /* ------------------------------------------------------ Signal brut --- */

  _block(block) {
    for (let i = 0; i < block.length; i++) {
      this.acc += block[i] * block[i];
      if (++this.accN >= this.chunkLen) {
        const ms = this.acc / this.accN;
        this.acc = 0; this.accN = 0;
        const db = 10 * Math.log10(ms + 1e-12);
        this.env10.push(db);
        this.secChunks.push(ms);
        if (this.secChunks.length >= 10) {
          const mean = this.secChunks.reduce((a, b) => a + b, 0) / this.secChunks.length;
          this.secChunks.length = 0;
          this._second(10 * Math.log10(mean + 1e-12));
        }
      }
    }
  }

  /* ------------------------------------------------------- Secondes --- */

  _second(level) {
    const t = this.t++;
    const n = this.night;
    n.lv.push(Math.round(clamp(level, -120, 0)));
    // Plancher de bruit : 10e percentile des 5 dernières minutes.
    this.floorWin.push(level);
    if (this.floorWin.length > 300) this.floorWin.shift();
    if (t % 15 === 0) {
      const s = [...this.floorWin].sort((a, b) => a - b);
      this.floor = s[Math.floor(s.length * 0.1)] ?? level;
    }
    // Les secondes sont traitées strictement dans l'ordre (file d'attente) ;
    // si la classification prend du retard, les secondes suivantes passent sans.
    const raw = this.queued < 3 ? this.audio.getRecent(1.92) : null;
    this.queued = (this.queued || 0) + 1;
    this.chain = (this.chain || Promise.resolve()).then(async () => {
      let scores = null;
      if (raw && this.yamnet) {
        try { scores = await this._classify(raw); } catch (err) { console.warn('[sommeil] classification', err); }
      }
      if (this.state !== 'recording') return;
      this._process(t, level, scores);
      if (t % 60 === 59) this._closeMinute();
      if (t > 0 && t % AUTOSAVE_EVERY === 0) this._save();
    }).finally(() => { this.queued--; });
  }

  async _classify(raw) {
    const tf = this.tf;
    const x = resample(raw, this.audio.sampleRate, 16000);
    const out = tf.tidy(() => {
      const o = this.yamnet.predict(tf.tensor1d(x));
      return (Array.isArray(o) ? o[0] : o).max(0);
    });
    const scores = await out.data();
    out.dispose();
    return scores;
  }

  /** Traitement d'une seconde : catégories, épisodes, respiration. */
  _process(t, level, scores) {
    const n = this.night;
    const rise = level - this.floor;
    const cat = {};
    let envLabel = -1, envScore = 0, gasp = 0;
    if (scores) {
      for (let i = 0; i < scores.length; i++) {
        const c = CLASS_TO_CAT[i];
        if (!c) continue;
        if (scores[i] > (cat[c] || 0)) cat[c] = scores[i];
        if (c === 'env' && scores[i] > envScore) { envScore = scores[i]; envLabel = i; }
      }
      gasp = Math.max(scores[GASP_SNORT[0]], scores[GASP_SNORT[1]]);
    }
    // Catégories actives cette seconde.
    const active = {};
    let dom = 0, domScore = 0, domRatio = 0;
    for (const c of DETECT_CATS) {
      const def = CATS[c];
      const s = cat[c] || 0;
      if (s >= def.thr && rise >= def.rise) {
        active[c] = s;
        const ratio = s / def.thr;
        if (ratio > domRatio) { domRatio = ratio; dom = def.code; domScore = s; }
      }
    }
    const breath = (cat.breath || 0) >= CATS.breath.thr;
    if (!dom && breath) { dom = CATS.breath.code; domScore = cat.breath; }
    n.sc.push(dom);
    n.ss.push(Math.round(domScore * 100));

    // Épisodes.
    for (const c of DETECT_CATS) {
      if (active[c] !== undefined) this._feedEpisode(c, t, active[c], level, c === 'env' ? envLabel : -1);
      else if (this.open[c] && t - this.open[c].t1 > CATS[c].gap) this._closeEpisode(c);
      this.prevActive[c] = active[c] !== undefined;
    }

    // Minute en cours.
    const m = this.minuteAcc;
    m.lv.push(level);
    for (const c of DETECT_CATS) if (active[c] !== undefined) m[c]++;
    if (breath) m.breath++;

    this._respiration(t, active, breath, gasp, level);
    this.emit('second', { t, level, floor: this.floor, dom, domScore, active, scores: !!scores });
  }

  _feedEpisode(c, t, score, level, label) {
    let e = this.open[c];
    if (!e) {
      e = this.open[c] = {
        id: `${c}-${t}`, cat: c, t0: t, t1: t, n: 0, peak: 0, db: -120, labels: {}, audio: null,
      };
      this.emit('event-start', e);
    }
    e.t1 = t;
    if (!this.prevActive[c]) e.n++;   // nouvelle occurrence (ex. un ronflement, une quinte)
    if (label >= 0) e.labels[label] = (e.labels[label] || 0) + 1;
    if (level > e.db) e.db = level;
    if (score > e.peak) {
      e.peak = score;
      if (this.clipBudget[c] > 0 && CATS[c].clipLen) e.audio = this.audio.getRecent(CATS[c].clipLen);
    }
  }

  _closeEpisode(c) {
    const e = this.open[c];
    if (!e) return;
    delete this.open[c];
    let label = '';
    if (c === 'env') {
      const best = Object.entries(e.labels).sort((a, b) => b[1] - a[1])[0];
      if (best) label = YAMNET_FR[best[0]] || this.names?.[best[0]] || '';
    }
    const ev = { id: e.id, cat: c, t0: e.t0, t1: e.t1 + 1, n: Math.max(1, e.n), peak: +e.peak.toFixed(2), db: Math.round(e.db), label, clip: '' };
    this.night.events.push(ev);
    this.emit('event', ev);
    if (e.audio && this.clipBudget[c] > 0) {
      this.clipBudget[c]--;
      this._saveClip(ev, e.audio, `${fmtT(this.night.start, ev.t0)}_${CATS[c].label}${label ? `_${label}` : ''}`);
    }
  }

  _saveClip(target, samples, name) {
    const job = this.store.saveClip(this.night.id, name, samples, this.audio.sampleRate).then((file) => {
      if (file) { target.clip = file; this.emit('clip', target); }
    }).finally(() => this.pendingClips.delete(job));
    this.pendingClips.add(job);
    return job;
  }

  /**
   * Pauses respiratoires suspectes : dans un contexte de ronflement ou de
   * respiration audible, un silence respiratoire d'au moins 10 s suivi
   * d'une reprise (souvent bruyante : halètement, reniflement, ronflement).
   */
  _respiration(t, active, breath, gasp, level) {
    const r = this.resp;
    const snoring = active.snore !== undefined;
    const respSound = snoring || breath || gasp >= 0.15;
    const otherNoise = ['move', 'speech', 'vocal', 'cough', 'sneeze', 'env'].some((c) => active[c] !== undefined);
    r.snoreHist.push(snoring ? 1 : 0);
    r.breathHist.push(breath ? 1 : 0);
    if (r.snoreHist.length > 90) { r.snoreHist.shift(); r.breathHist.shift(); }
    const context = r.snoreHist.reduce((a, b) => a + b, 0) >= 8 || r.breathHist.reduce((a, b) => a + b, 0) >= 25;

    if (respSound) {
      if (r.valid && r.silent >= PAUSE_MIN && r.silent <= PAUSE_MAX && r.context) {
        const p = {
          id: `pause-${t}`, t0: t - r.silent, t1: t, dur: r.silent,
          resume: gasp >= 0.15 ? 'halètement / reniflement' : snoring ? 'ronflement' : 'respiration',
          db: Math.round(level), clip: '',
        };
        this.night.pauses.push(p);
        this.emit('pause', p);
        if (this.clipBudget.pause > 0) {
          this.clipBudget.pause--;
          const audio = this.audio.getRecent(Math.min(28, p.dur + 5));
          if (audio) this._saveClip(p, audio, `${fmtT(this.night.start, p.t0)}_Pause_${p.dur}s`);
        }
      }
      r.last = t; r.silent = 0; r.valid = true; r.context = context;
    } else if (otherNoise) {
      r.valid = false; r.silent = 0;     // un bruit masque la respiration : pas de conclusion
    } else if (r.valid) {
      r.silent++;
      if (r.silent > PAUSE_MAX) r.valid = false;
    }
  }

  /* -------------------------------------------------------- Minutes --- */

  _newMinute() {
    return { lv: [], snore: 0, breath: 0, cough: 0, sneeze: 0, speech: 0, vocal: 0, brux: 0, move: 0, env: 0 };
  }

  _closeMinute() {
    const m = this.minuteAcc;
    if (!m.lv.length) return;
    const env = this.env10.splice(0, this.env10.length);
    const breathing = (m.breath + m.snore >= 20) ? breathRate(env) : null;
    const sorted = [...m.lv].sort((a, b) => a - b);
    const out = {
      i: this.night.minutes.length,
      snore: m.snore, breath: m.breath, cough: m.cough, sneeze: m.sneeze, speech: m.speech,
      vocal: m.vocal, brux: m.brux, move: m.move, env: m.env,
      lvl: Math.round(sorted[Math.floor(sorted.length / 2)]),
      max: Math.round(sorted[sorted.length - 1]),
      floor: Math.round(this.floor),
      rate: breathing ? +breathing.rate.toFixed(1) : null,
      reg: breathing ? +breathing.reg.toFixed(2) : null,
    };
    this.night.minutes.push(out);
    this.minuteAcc = this._newMinute();
    this.emit('minute', out);
  }
}

/**
 * Rythme respiratoire à partir de l'enveloppe 100 ms d'une minute :
 * autocorrélation entre 1,5 s et 10 s (6 à 40 respirations/min).
 */
export function breathRate(env) {
  const n = env.length;
  if (n < 300) return null;
  const mean = env.reduce((a, b) => a + b, 0) / n;
  const x = env.map((v) => v - mean);
  let e0 = 0;
  for (const v of x) e0 += v * v;
  if (e0 <= 1e-6) return null;
  let best = 0, bestLag = 0;
  const r = [];
  for (let lag = 12; lag <= 100; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    r[lag] = s / e0;
  }
  for (let lag = 15; lag <= 99; lag++) {
    if (r[lag] > r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] > best) { best = r[lag]; bestLag = lag; }
  }
  if (best < 0.2 || !bestLag) return null;
  return { rate: 600 / bestLag, reg: Math.min(1, best) };
}

/** "02h14m30" pour nommer les extraits. */
function fmtT(start, t) {
  const d = new Date(start + t * 1000);
  return `${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}`;
}
