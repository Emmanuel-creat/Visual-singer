/**
 * recognizer.js : Identification des sources sonores, 100 % locale (TensorFlow.js).
 *
 * Deux modèles, chargés à la demande depuis /models :
 *   - YAMNet (Google, Apache 2.0) : 521 types de sons (parole, chant, rire, chien,
 *     chat, vache, grenouille, grillon, musique, pluie, moteur…). Entrée 16 kHz.
 *   - BirdNET v2.4 (K. Lisa Yang Center / TU Chemnitz, CC BY-NC-SA 4.0) :
 *     plus de 6 000 espèces d'oiseaux. Entrée 3 s à 48 kHz. Un second petit
 *     modèle estime les espèces probables selon la position et la semaine.
 *
 * Toutes les `interval` secondes, les 3 dernières secondes de signal sont
 * analysées. YAMNet donne la catégorie (humain, animal, oiseau, musique…) ;
 * si un oiseau est probable, BirdNET précise l'espèce.
 *
 * Événements :
 *   'state'     { state, message, progress }
 *   'result'    analyse courante (top des classes, scores par catégorie)
 *   'detection' nouvelle détection (objet mis à jour tant que le son continue)
 *   'update'    détection prolongée / confiance améliorée
 *   'final'     détection terminée ({ detection, audio, sampleRate }) → sauvegarde
 */
import { Emitter, clamp } from './utils.js';
import { CATEGORIES, YAMNET_FR, YAMNET_IGNORED, YAMNET_GENERIC, BIRDNET_SPECIAL, yamnetCategory } from './sound-labels.js';

const WINDOW = 3;            // secondes analysées
const SILENCE_DB = -62;      // en dessous : pas d'analyse

/** Charge TensorFlow.js (script global) une seule fois. */
let tfPromise = null;
export function loadTf() {
  if (window.tf) return Promise.resolve(window.tf);
  tfPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/tf.min.js', import.meta.url).href;
    s.onload = () => resolve(window.tf);
    s.onerror = () => reject(new Error('Impossible de charger vendor/tf.min.js'));
    document.head.appendChild(s);
  });
  return tfPromise;
}

/** Couche personnalisée de BirdNET : spectrogramme mel calculé dans le modèle. */
function registerBirdnetLayer(tf) {
  if (registerBirdnetLayer.done) return;
  class MelSpecLayerSimple extends tf.layers.Layer {
    constructor(config) {
      super(config);
      this.sampleRate = config.sampleRate;
      this.specShape = config.specShape;
      this.frameStep = config.frameStep;
      this.frameLength = config.frameLength;
      this.fmin = config.fmin;
      this.fmax = config.fmax;
      this.melFilterbank = tf.tensor2d(config.melFilterbank);
    }
    build(inputShape) {
      this.magScale = this.addWeight('magnitude_scaling', [], 'float32', tf.initializers.constant({ value: 1.23 }));
      super.build(inputShape);
    }
    computeOutputShape(inputShape) { return [inputShape[0], this.specShape[0], this.specShape[1], 1]; }
    call(inputs) {
      return tf.tidy(() => {
        const x = inputs[0];
        const list = tf.split(x, x.shape[0]);
        const specs = list.map((inp) => {
          let input = inp.squeeze();
          input = tf.sub(input, tf.min(input, -1, true));
          input = tf.div(input, tf.max(input, -1, true).add(0.000001));
          input = tf.mul(tf.sub(input, 0.5), 2.0);
          let spec = tf.signal.stft(input, this.frameLength, this.frameStep, this.frameLength, tf.signal.hannWindow);
          spec = tf.cast(spec, 'float32');
          spec = tf.matMul(spec, this.melFilterbank);
          spec = spec.pow(2.0);
          spec = spec.pow(tf.div(1.0, tf.add(1.0, tf.exp(this.magScale.read()))));
          spec = tf.reverse(spec, -1);
          spec = tf.transpose(spec);
          return spec.expandDims(-1);
        });
        return tf.stack(specs);
      });
    }
    static get className() { return 'MelSpecLayerSimple'; }
  }
  tf.serialization.registerClass(MelSpecLayerSimple);
  registerBirdnetLayer.done = true;
}

/**
 * Rééchantillonnage simple : moyenne par intervalle (sous-échantillonnage, anti-repliement
 * grossier) ou interpolation linéaire (sur-échantillonnage).
 */
export function resample(input, from, to, outLen = Math.round((input.length * to) / from)) {
  const out = new Float32Array(outLen);
  const ratio = from / to;
  if (ratio > 1) {
    for (let i = 0; i < outLen; i++) {
      const a = i * ratio, b = Math.min(input.length, a + ratio);
      let s = 0, n = 0;
      for (let j = Math.floor(a); j < b; j++) { s += input[j]; n++; }
      out[i] = n ? s / n : 0;
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const x = i * ratio, i0 = Math.floor(x), k = x - i0;
      const a = input[Math.min(i0, input.length - 1)], b = input[Math.min(i0 + 1, input.length - 1)];
      out[i] = a + (b - a) * k;
    }
  }
  return out;
}

/** Semaine BirdNET (1..48, 4 par mois). */
export function birdnetWeek(date = new Date()) {
  return date.getMonth() * 4 + Math.min(4, Math.floor((date.getDate() - 1) / 7) + 1);
}

export class Recognizer extends Emitter {
  /**
   * @param {AudioEngine} audio
   * @param {Settings} settings
   * @param {() => number} clock  temps de session (s)
   */
  constructor(audio, settings, clock) {
    super();
    this.audio = audio;
    this.settings = settings;
    this.clock = clock;
    this.state = 'off';          // off | loading | ready | error
    this.message = '';
    this.busy = false;
    this.detections = [];        // journal de la session (plus récente en dernier)
    this.current = null;         // dernière analyse
    this.locationMask = null;    // Float32Array(6522) des probabilités de présence
    this.timer = 0;
    settings.on('change', ({ key }) => {
      if (key === 'recogEnabled') settings.get('recogEnabled') ? this.start() : this.stop();
      if (key === 'recogInterval' && this.timer) { this.stop(); this.start(); }
      if (['useLocation', 'latitude', 'longitude'].includes(key)) this._updateLocationMask();
    });
  }

  _setState(state, message = '', progress = null) {
    this.state = state;
    this.message = message;
    this.emit('state', { state, message, progress });
  }

  /** Charge les modèles (une seule fois). */
  async load() {
    if (this.state === 'ready' || this._loading) return this._loading;
    this._loading = (async () => {
      try {
        this._setState('loading', 'Chargement de TensorFlow.js…', 0);
        const tf = await loadTf();
        this.tf = tf;
        try { await tf.setBackend('webgl'); } catch { await tf.setBackend('cpu'); }
        await tf.ready();
        const base = new URL('../models/', import.meta.url).href;

        this._setState('loading', 'Chargement de YAMNet (sons généraux)…', 0.05);
        this.yamnet = await tf.loadGraphModel(`${base}yamnet/model.json`, {
          onProgress: (p) => this._setState('loading', 'Chargement de YAMNet (sons généraux)…', 0.05 + p * 0.2),
        });
        const csv = await (await fetch(`${base}yamnet/yamnet_class_map.csv`)).text();
        this.yamnetNames = parseClassMap(csv);

        this._setState('loading', 'Chargement de BirdNET (espèces d’oiseaux)…', 0.25);
        registerBirdnetLayer(tf);
        this.birdnet = await tf.loadLayersModel(`${base}birdnet/model.json`, {
          onProgress: (p) => this._setState('loading', 'Chargement de BirdNET (espèces d’oiseaux)…', 0.25 + p * 0.65),
        });
        const en = await (await fetch(`${base}birdnet/labels.json`)).json();
        const frText = await (await fetch(`${base}birdnet/labels_fr.txt`)).text();
        const fr = frText.split(/\r?\n/);
        this.birdLabels = en.map((l, i) => {
          const [sci, common] = splitLabel(l);
          const frCommon = fr[i] ? splitLabel(fr[i])[1] : common;
          const special = BIRDNET_SPECIAL[sci];
          return {
            sci, en: common,
            fr: special ? special.fr : frCommon,
            category: special ? special.category : sci === common ? 'animal' : 'bird',
            special: !!special,
          };
        });

        this._setState('loading', 'Préparation des modèles (première exécution)…', 0.92);
        tf.tidy(() => {
          this.yamnet.predict(tf.zeros([16000]));
          this.birdnet.predict(tf.zeros([1, 144000]));
        });
        await this._updateLocationMask();
        this._setState('ready', 'Prêt', 1);
      } catch (err) {
        console.error('[recognizer]', err);
        this._setState('error', `Échec du chargement : ${err.message || err}`);
        this._loading = null;
        throw err;
      }
    })();
    return this._loading;
  }

  async start() {
    if (this.timer) return;
    try { await this.load(); } catch { return; }
    if (!this.settings.get('recogEnabled')) return;
    const ms = Math.max(500, this.settings.get('recogInterval') * 1000);
    this.timer = setInterval(() => this.tick(), ms);
    this.emit('state', { state: this.state, message: 'Analyse en cours', progress: 1, running: true });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    this.closeAll();
    this.emit('state', { state: this.state, message: this.state === 'ready' ? 'En pause' : this.message, progress: 1, running: false });
  }

  get running() { return !!this.timer; }

  /** Probabilités de présence des espèces selon la position et la semaine (modèle BirdNET « meta »). */
  async _updateLocationMask() {
    if (!this.tf || !this.settings.get('useLocation')) { this.locationMask = null; return; }
    const lat = this.settings.get('latitude'), lon = this.settings.get('longitude');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { this.locationMask = null; return; }
    try {
      this.meta ??= await this.tf.loadGraphModel(new URL('../models/birdnet/mdata/model.json', import.meta.url).href);
      const out = this.tf.tidy(() => this.meta.predict(this.tf.tensor([[lat, lon, birdnetWeek()]])));
      this.locationMask = await out.data();
      out.dispose();
      this.emit('location', { species: this.locationMask.filter((p) => p >= 0.03).length });
    } catch (err) {
      console.warn('[recognizer] filtre géographique indisponible', err);
      this.locationMask = null;
    }
  }

  /** Analyse des 3 dernières secondes. */
  async tick() {
    if (this.busy || this.state !== 'ready' || !this.audio.active) { this._closeStale(); return; }
    const sr = this.audio.sampleRate;
    const raw = this.audio.getRecent(WINDOW);
    if (!raw) return;
    let sum = 0;
    for (let i = 0; i < raw.length; i++) sum += raw[i] * raw[i];
    const db = 10 * Math.log10(sum / raw.length + 1e-12);
    const t = this.clock();
    if (db < SILENCE_DB) {
      this.current = { time: t, silent: true, db, top: [], categories: {}, bird: [] };
      this.emit('result', this.current);
      this._closeStale();
      return;
    }
    this.busy = true;
    const tf = this.tf;
    try {
      // --- YAMNet ---
      const x16 = resample(raw, sr, 16000);
      const scoresT = tf.tidy(() => {
        const out = this.yamnet.predict(tf.tensor1d(x16));
        const s = Array.isArray(out) ? out[0] : out;
        return tf.add(s.mean(0), s.max(0)).div(2);
      });
      const scores = await scoresT.data();
      scoresT.dispose();

      const cats = { human: 0, animal: 0, bird: 0, music: 0, nature: 0, other: 0 };
      for (let i = 0; i < scores.length; i++) {
        if (YAMNET_IGNORED.has(i)) continue;
        const c = yamnetCategory(i);
        if (scores[i] > cats[c]) cats[c] = scores[i];
      }
      const order = [...scores.keys()].filter((i) => !YAMNET_IGNORED.has(i)).sort((a, b) => scores[b] - scores[a]);
      const top = order.slice(0, 5).map((i) => this._yamnetEntry(i, scores[i]));

      // --- BirdNET (si un oiseau est plausible ou si l'analyse est forcée) ---
      let bird = [];
      const birdGate = this.settings.get('birdAlways') || cats.bird >= 0.06 || cats.animal >= 0.2;
      if (birdGate) bird = await this._runBirdnet(raw, sr);

      this.current = { time: t, db, top, categories: cats, bird, silent: false };
      this.emit('result', this.current);
      this._decide(t, raw, sr, top, bird);
    } catch (err) {
      console.error('[recognizer] analyse', err);
    } finally {
      this.busy = false;
    }
  }

  _yamnetEntry(i, score) {
    return {
      source: 'yamnet', index: i, score,
      label: YAMNET_FR[i] || this.yamnetNames[i] || `#${i}`,
      en: this.yamnetNames[i] || '',
      category: yamnetCategory(i),
    };
  }

  async _runBirdnet(raw, sr) {
    const tf = this.tf;
    const x48 = resample(raw, sr, 48000, 144000);
    const outT = tf.tidy(() => this.birdnet.predict(tf.tensor2d(x48, [1, 144000])));
    const out = await outT.data();
    outT.dispose();
    // Le modèle renvoie des logits : conversion en probabilités (sigmoïde).
    let isProb = true;
    for (let i = 0; i < out.length; i += 97) if (out[i] < 0 || out[i] > 1) { isProb = false; break; }
    const mask = this.locationMask;
    const res = [];
    for (let i = 0; i < out.length; i++) {
      const p = isProb ? out[i] : 1 / (1 + Math.exp(-clamp(out[i], -15, 15)));
      if (p < 0.08) continue;
      const lab = this.birdLabels[i];
      if (mask && !lab.special && mask[i] < 0.03) continue;
      res.push({ source: 'birdnet', index: i, score: p, label: lab.fr, en: lab.en, sci: lab.sci, category: lab.category, special: lab.special });
    }
    return res.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  /** Choisit la source la plus probable et alimente le journal des détections. */
  _decide(t, raw, sr, top, bird) {
    const birdMin = this.settings.get('birdMinConf');
    const soundMin = this.settings.get('soundMinConf');
    let best = null;
    const species = bird.find((b) => !b.special && b.score >= birdMin);
    if (species) best = species;
    else {
      // Classe YAMNet la plus probable, en préférant une classe précise à une classe générique.
      const cands = top.filter((c) => c.score >= soundMin);
      best = cands.find((c) => !YAMNET_GENERIC.has(c.index) && c.score >= cands[0]?.score * 0.6) || cands[0] || null;
      const special = bird.find((b) => b.special && b.score >= birdMin);
      if (!best && special) best = special;
    }
    this._closeStale(t);
    if (!best) return;

    const key = `${best.source}:${best.index}`;
    const open = this.detections.find((d) => d.open && d.key === key);
    if (open) {
      open.end = t;
      open.hits++;
      if (best.score > open.confidence) {
        open.confidence = best.score;
        open.audio = raw;
        open.sampleRate = sr;
      }
      this.emit('update', open);
      return;
    }
    const d = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      key,
      start: Math.max(0, t - WINDOW),
      end: t,
      wallTime: new Date().toISOString(),
      category: best.category,
      label: best.label,
      en: best.en,
      sci: best.sci || '',
      source: best.source,
      confidence: best.score,
      hits: 1,
      open: true,
      audio: raw,
      sampleRate: sr,
      alternatives: (best.source === 'birdnet' ? bird : top).filter((c) => c !== best).slice(0, 3)
        .map((c) => ({ label: c.label, score: +c.score.toFixed(3), sci: c.sci || '' })),
    };
    this.detections.push(d);
    if (this.detections.length > 500) this.detections.shift();
    this.emit('detection', d);
  }

  /** Clôt les détections qui ne sont plus entendues → événement 'final' (sauvegarde). */
  _closeStale(t = this.clock()) {
    const gap = this.settings.get('recogInterval') * 2.2 + 0.5;
    for (const d of this.detections) if (d.open && t - d.end > gap) this._close(d);
  }

  /** Clôt toutes les détections en cours (source audio coupée, pause…). */
  closeAll() { for (const d of this.detections) if (d.open) this._close(d); }

  _close(d) {
    d.open = false;
    const { audio, sampleRate } = d;
    d.audio = null;
    this.emit('final', { detection: d, audio, sampleRate });
  }
}

function splitLabel(l) {
  const i = l.indexOf('_');
  return i < 0 ? [l, l] : [l.slice(0, i), l.slice(i + 1)];
}

export function parseClassMap(csv) {
  const names = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+),[^,]*,(.*)$/);
    if (m) names[Number(m[1])] = m[2].replace(/^"|"$/g, '');
  }
  return names;
}

export { CATEGORIES };
