/**
 * audio.js — Capture microphone + analyse FFT temps réel (Web Audio API).
 *
 * Chaîne audio :
 *   [Micro | Synthé démo] → Gain(entrée) ─┬→ AnalyserNode → Gain(0) → destination
 *                                          └→ AudioWorklet (signal brut → reconnaissance)
 * Le gain nul garde le graphe "tiré" par la destination sans jamais
 * renvoyer le son vers les haut-parleurs (pas de larsen).
 *
 * À chaque appel de analyze(), le moteur produit une "frame" d'analyse
 * réutilisée (aucune allocation par image) :
 *   time, bands[BANDS], bass, mid, treble, intensity, rmsDb,
 *   peak, peakDb, dominantFrequency, clipping
 */
import { Emitter, clamp, toDb } from './utils.js';

/** Nombre de bandes logarithmiques conservées par tranche d'analyse. */
export const BANDS = 128;

export class AudioEngine extends Emitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.state = 'idle';        // idle | requesting | active | error
    this.source = null;         // 'mic' | 'demo' | null
    this.error = null;          // { code, title, message, hint }
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.sourceNode = null;
    this.demo = null;
    this.deviceLabel = '';
    this.clipUntil = 0;
    // Tampon circulaire du signal brut (alimente la reconnaissance des sons).
    this.ring = null;
    this.ringPos = 0;
    this.ringFilled = 0;
    this.lastBlockAt = 0;

    this.frame = {
      time: 0,
      bands: new Uint8Array(BANDS),
      bass: 0, mid: 0, treble: 0,
      intensity: 0, rmsDb: -140,
      peak: 0, peakDb: -140,
      dominantFrequency: 0,
      clipping: false,
    };

    settings.on('change', ({ key }) => {
      if (!this.analyser) return;
      if (key === 'fftSize') this._applyAnalyserSettings();
      if (key === 'smoothing' || key === 'minDb' || key === 'maxDb') this._applyAnalyserSettings();
      if (key === 'freqMin' || key === 'freqMax') this._buildBandTables();
      if (key === 'rawInput' && this.source === 'mic') this.connectMicrophone();
    });
  }

  get active() { return this.state === 'active'; }
  get sampleRate() { return this.ctx?.sampleRate ?? 0; }
  get fftSize() { return this.analyser?.fftSize ?? this.settings.get('fftSize'); }

  _setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('state', { state, source: this.source, error });
  }

  /** Crée (une seule fois) le contexte audio et l'analyseur. */
  async _ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.input = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      const silent = this.ctx.createGain();
      silent.gain.value = 0;
      this.input.connect(this.analyser);
      this.analyser.connect(silent).connect(this.ctx.destination);
      this._applyAnalyserSettings();
      this.ring = new Float32Array(Math.ceil(this.ctx.sampleRate * 8));
      try {
        await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
        this.tap = new AudioWorkletNode(this.ctx, 'vs-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
        this.tap.port.onmessage = (e) => this._onBlock(e.data);
        this.input.connect(this.tap);
        this.tap.connect(silent);
      } catch (err) {
        console.warn('[audio] AudioWorklet indisponible : reconnaissance désactivée', err);
      }
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Bloc de signal brut reçu du worklet → tampon circulaire. */
  _onBlock(block) {
    if (this.state !== 'active') return;
    const r = this.ring, n = block.length;
    const first = Math.min(n, r.length - this.ringPos);
    r.set(block.subarray(0, first), this.ringPos);
    if (first < n) r.set(block.subarray(first), 0);
    this.ringPos = (this.ringPos + n) % r.length;
    this.ringFilled = Math.min(r.length, this.ringFilled + n);
    this.lastBlockAt = performance.now();
  }

  /** Copie des `seconds` dernières secondes de signal brut (null si pas assez de données). */
  getRecent(seconds) {
    if (!this.ring) return null;
    const len = Math.round(seconds * this.ctx.sampleRate);
    if (this.ringFilled < len || len > this.ring.length) return null;
    const out = new Float32Array(len);
    const start = (this.ringPos - len + this.ring.length) % this.ring.length;
    const first = Math.min(len, this.ring.length - start);
    out.set(this.ring.subarray(start, start + first), 0);
    if (first < len) out.set(this.ring.subarray(0, len - first), first);
    return out;
  }

  _applyAnalyserSettings() {
    const s = this.settings;
    const a = this.analyser;
    a.fftSize = s.get('fftSize');
    a.smoothingTimeConstant = clamp(s.get('smoothing'), 0, 0.99);
    const minDb = Math.min(s.get('minDb'), s.get('maxDb') - 10);
    a.minDecibels = minDb;
    a.maxDecibels = s.get('maxDb');
    this.freqBytes = new Uint8Array(a.frequencyBinCount);
    this.timeData = new Float32Array(a.fftSize);
    this._buildBandTables();
    this.emit('config', { sampleRate: this.sampleRate, fftSize: a.fftSize });
  }

  /**
   * Pré-calcule la correspondance bandes log ↔ bins FFT.
   * Les bandes plus étroites qu'un bin (graves) sont interpolées,
   * les autres prennent le maximum des bins couverts.
   */
  _buildBandTables() {
    const sr = this.sampleRate || 48000;
    const fft = this.analyser ? this.analyser.fftSize : 4096;
    const binHz = sr / fft;
    const nBins = fft / 2;
    const fmin = Math.max(10, this.settings.get('freqMin'));
    const fmax = Math.min(sr / 2, Math.max(fmin * 2, this.settings.get('freqMax')));
    this.fmin = fmin;
    this.fmax = fmax;
    this.binHz = binHz;
    this.bandFreq = new Float32Array(BANDS);
    this.bandLo = new Uint16Array(BANDS);
    this.bandHi = new Uint16Array(BANDS);
    this.bandCenterBin = new Float32Array(BANDS);
    this.bandInterp = new Uint8Array(BANDS);
    const ratio = Math.log(fmax / fmin);
    for (let b = 0; b < BANDS; b++) {
      const f = fmin * Math.exp((ratio * b) / (BANDS - 1));
      const fLo = fmin * Math.exp((ratio * (b - 0.5)) / (BANDS - 1));
      const fHi = fmin * Math.exp((ratio * (b + 0.5)) / (BANDS - 1));
      this.bandFreq[b] = f;
      const lo = fLo / binHz, hi = fHi / binHz;
      this.bandCenterBin[b] = clamp(f / binHz, 0, nBins - 2);
      this.bandInterp[b] = hi - lo < 1.5 ? 1 : 0;
      this.bandLo[b] = clamp(Math.floor(lo), 0, nBins - 1);
      this.bandHi[b] = clamp(Math.ceil(hi), 0, nBins - 1);
    }
    this.binMin = clamp(Math.floor(fmin / binHz), 1, nBins - 2);
    this.binMax = clamp(Math.ceil(fmax / binHz), 2, nBins - 2);
  }

  /** Indice de bande (fractionnaire) d'une fréquence. */
  freqToBand(f) {
    if (!f) return 0;
    return clamp(((BANDS - 1) * Math.log(f / this.fmin)) / Math.log(this.fmax / this.fmin), 0, BANDS - 1);
  }

  /** Liste les entrées audio (libellés disponibles après autorisation). */
  async listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'audioinput');
    } catch { return []; }
  }

  /** Demande l'accès au micro et le branche sur l'analyseur. */
  async connectMicrophone() {
    if (!window.isSecureContext) return this._fail({ name: 'InsecureContext' });
    if (!navigator.mediaDevices?.getUserMedia) return this._fail({ name: 'Unsupported' });

    this._setState('requesting');
    const raw = this.settings.get('rawInput');
    const deviceId = this.settings.get('deviceId');
    const audio = {
      echoCancellation: !raw,
      noiseSuppression: !raw,
      autoGainControl: !raw,
      channelCount: { ideal: 1 },
    };
    if (deviceId) audio.deviceId = { exact: deviceId };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (err) {
      // Périphérique mémorisé débranché : on retente avec l'entrée par défaut.
      if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        this.settings.set('deviceId', '');
        return this.connectMicrophone();
      }
      return this._fail(err);
    }

    try {
      await this._ensureContext();
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      return this._fail({ name: 'AudioContextError', message: err.message });
    }

    this._teardownSource();
    this.stream = stream;
    this.sourceNode = this.ctx.createMediaStreamSource(stream);
    this.sourceNode.connect(this.input);
    const track = stream.getAudioTracks()[0];
    this.deviceLabel = track?.label || 'Microphone';
    track?.addEventListener('ended', () => {
      if (this.stream === stream) this._fail({ name: 'TrackEnded' });
    });
    this.source = 'mic';
    this._buildBandTables();
    this._setState('active');
    this.emit('devices', await this.listDevices());
  }

  /** Signal synthétique (batterie + basse + voix formantique) pour tester sans micro. */
  async startDemo() {
    try {
      await this._ensureContext();
    } catch (err) {
      return this._fail({ name: 'AudioContextError', message: err.message });
    }
    this._teardownSource();
    this.demo = new DemoSynth(this.ctx, this.input);
    this.source = 'demo';
    this.deviceLabel = 'Signal de démonstration';
    this._buildBandTables();
    this._setState('active');
  }

  /**
   * Lit un fichier audio (enregistrement d'oiseau, etc.) à travers l'analyse et la reconnaissance.
   * Le son est aussi joué sur les haut-parleurs.
   */
  async playFile(file) {
    try {
      await this._ensureContext();
    } catch (err) {
      return this._fail({ name: 'AudioContextError', message: err.message });
    }
    let buffer;
    try {
      buffer = await this.ctx.decodeAudioData(await file.arrayBuffer());
    } catch {
      return this._fail({ name: 'DecodeError', message: file.name });
    }
    this._teardownSource();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.input);
    src.connect(this.ctx.destination);
    src.onended = () => { if (this.fileNode === src) this.stop(); };
    src.start();
    this.fileNode = src;
    this.source = 'file';
    this.deviceLabel = file.name;
    this._buildBandTables();
    this._setState('active');
  }

  /** Coupe la source courante (l'historique est conservé). */
  stop() {
    this._teardownSource();
    this.source = null;
    this._setState('idle');
  }

  _teardownSource() {
    this.ringFilled = 0;
    if (this.sourceNode) { try { this.sourceNode.disconnect(); } catch { /* déjà déconnecté */ } }
    this.sourceNode = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.demo) this.demo.stop();
    this.demo = null;
    if (this.fileNode) {
      const n = this.fileNode;
      this.fileNode = null;
      try { n.stop(); n.disconnect(); } catch { /* déjà arrêté */ }
    }
  }

  _fail(err) {
    this._teardownSource();
    this.source = null;
    const info = describeAudioError(err);
    console.warn('[audio]', info.code, err);
    this._setState('error', info);
  }

  /**
   * Analyse l'instant présent. Renvoie la frame (objet réutilisé) ou null.
   * @param {number} time  temps de session en secondes
   */
  analyze(time) {
    if (this.state !== 'active' || !this.analyser) return null;
    const a = this.analyser;
    const f = this.frame;
    const fb = this.freqBytes;
    const td = this.timeData;
    a.getByteFrequencyData(fb);
    a.getFloatTimeDomainData(td);
    f.time = time;

    // --- Domaine temporel : RMS, crête, saturation ---
    let sum = 0, pk = 0;
    for (let i = 0; i < td.length; i++) {
      const v = td[i];
      sum += v * v;
      const av = v < 0 ? -v : v;
      if (av > pk) pk = av;
    }
    const rms = Math.sqrt(sum / td.length);
    f.rmsDb = toDb(rms);
    f.peak = Math.min(1, pk);
    f.peakDb = toDb(pk);
    const now = performance.now();
    if (pk >= 0.995) this.clipUntil = now + 1500;
    f.clipping = now < this.clipUntil;
    f.intensity = clamp((f.rmsDb + 60) / 60, 0, 1);

    // --- Bandes logarithmiques ---
    const bands = f.bands;
    const lo = this.bandLo, hi = this.bandHi, interp = this.bandInterp, cb = this.bandCenterBin;
    for (let b = 0; b < BANDS; b++) {
      let v;
      if (interp[b]) {
        const c = cb[b], i0 = c | 0, fr = c - i0;
        v = fb[i0] * (1 - fr) + fb[i0 + 1] * fr;
      } else {
        v = 0;
        for (let i = lo[b]; i <= hi[b]; i++) if (fb[i] > v) v = fb[i];
      }
      bands[b] = v;
    }

    // --- Niveaux par zone (moyenne des bandes log de la zone) ---
    const bassMax = this.settings.get('bassMax');
    const midMax = this.settings.get('midMax');
    let sb = 0, nb = 0, sm = 0, nm = 0, st = 0, nt = 0;
    const bf = this.bandFreq;
    for (let b = 0; b < BANDS; b++) {
      const fr = bf[b];
      if (fr < bassMax) { sb += bands[b]; nb++; } else if (fr < midMax) { sm += bands[b]; nm++; } else { st += bands[b]; nt++; }
    }
    f.bass = nb ? sb / nb / 255 : 0;
    f.mid = nm ? sm / nm / 255 : 0;
    f.treble = nt ? st / nt / 255 : 0;

    // --- Fréquence dominante (max + interpolation parabolique) ---
    let mi = -1, mv = 0;
    for (let i = this.binMin; i <= this.binMax; i++) if (fb[i] > mv) { mv = fb[i]; mi = i; }
    if (mi > 0 && mv > 24) {
      const y0 = fb[mi - 1], y1 = fb[mi], y2 = fb[mi + 1];
      const den = y0 - 2 * y1 + y2;
      const p = den !== 0 ? clamp((0.5 * (y0 - y2)) / den, -0.5, 0.5) : 0;
      f.dominantFrequency = (mi + p) * this.binHz;
    } else {
      f.dominantFrequency = 0;
    }
    return f;
  }
}

/**
 * Détection des pics : déclenchement au franchissement du seuil,
 * puis suivi du maximum tant que le signal reste au-dessus (hystérésis).
 */
export class PeakDetector {
  constructor() {
    this.current = null;
    this.armed = true;
    this.lastTime = -Infinity;
  }

  reset() { this.current = null; this.armed = true; this.lastTime = -Infinity; }

  /** @returns {object|null} le pic nouvellement créé, sinon null */
  update(frame, threshold, history, engine) {
    const v = frame.intensity;
    const release = threshold * 0.88;
    let created = null;
    const p = this.current;
    if (p) {
      if (v > p.intensity) {
        p.time = frame.time;
        p.intensity = v;
        p.db = frame.rmsDb;
        p.peakDb = frame.peakDb;
        if (frame.dominantFrequency) p.freq = frame.dominantFrequency;
        p.band = engine.freqToBand(p.freq);
        p.h = frame.bands[Math.round(p.band)] / 255;
      }
      if (v < release || frame.time - p.start > 2) {
        p.open = false;
        this.current = null;
        this.armed = v < release;
      }
    } else if (this.armed && v >= threshold && frame.time - this.lastTime > 0.35) {
      const band = engine.freqToBand(frame.dominantFrequency);
      created = {
        id: Math.random().toString(36).slice(2, 9),
        start: frame.time,
        time: frame.time,
        intensity: v,
        db: frame.rmsDb,
        peakDb: frame.peakDb,
        freq: frame.dominantFrequency,
        band,
        h: frame.bands[Math.round(band)] / 255,
        open: true,
      };
      this.current = created;
      this.armed = false;
      this.lastTime = frame.time;
      history.addPeak(created);
    }
    if (!this.current && !this.armed && v < release) this.armed = true;
    return created;
  }
}

/** Traduit une erreur getUserMedia / Web Audio en message clair pour l'utilisateur. */
export function describeAudioError(err) {
  const name = err?.name || 'Error';
  switch (name) {
    case 'InsecureContext':
      return {
        code: name,
        title: 'Contexte non sécurisé',
        message: "Le navigateur bloque le microphone lorsque la page est ouverte en file:// ou via une adresse non sécurisée.",
        hint: 'Lancez un petit serveur local : python -m http.server 8080 puis ouvrez http://localhost:8080',
      };
    case 'Unsupported':
      return {
        code: name,
        title: 'Navigateur non compatible',
        message: "Ce navigateur ne propose pas l'API getUserMedia.",
        hint: 'Utilisez une version récente de Chrome, Edge ou Firefox.',
      };
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        code: name,
        title: 'Accès au microphone refusé',
        message: "L'autorisation d'utiliser le microphone a été refusée (par vous, le navigateur ou le système).",
        hint: "Cliquez sur l'icône de cadenas/micro dans la barre d'adresse, autorisez le microphone puis réessayez. Sous Windows, vérifiez aussi Paramètres → Confidentialité → Microphone.",
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        code: name,
        title: 'Aucun microphone détecté',
        message: "Aucune entrée audio n'a été trouvée sur cet ordinateur.",
        hint: 'Branchez un microphone (ou activez-le dans le système) puis réessayez, ou lancez le mode démo.',
      };
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        code: name,
        title: 'Microphone indisponible',
        message: 'Le microphone est détecté mais ne peut pas être lu : il est peut-être utilisé par une autre application.',
        hint: 'Fermez les logiciels qui utilisent le micro (Discord, OBS, visio…) puis réessayez.',
      };
    case 'OverconstrainedError':
      return {
        code: name,
        title: 'Configuration non supportée',
        message: "Le périphérique choisi ne supporte pas la configuration demandée.",
        hint: 'Choisissez une autre entrée dans les paramètres audio.',
      };
    case 'DecodeError':
      return {
        code: name,
        title: 'Fichier illisible',
        message: `Impossible de décoder « ${err.message} ».`,
        hint: 'Formats acceptés : WAV, MP3, OGG, FLAC, M4A (selon le navigateur).',
      };
    case 'TrackEnded':
      return {
        code: name,
        title: 'Microphone déconnecté',
        message: "Le flux audio s'est interrompu (périphérique débranché ou désactivé).",
        hint: 'Rebranchez le microphone puis reconnectez-le.',
      };
    case 'AudioContextError':
      return {
        code: name,
        title: 'Moteur audio indisponible',
        message: `Impossible de démarrer le moteur Web Audio${err.message ? ` : ${err.message}` : ''}.`,
        hint: 'Rechargez la page. Si le problème persiste, essayez un autre navigateur.',
      };
    default:
      return {
        code: name,
        title: 'Erreur microphone',
        message: err?.message || 'Une erreur inattendue est survenue.',
        hint: 'Rechargez la page puis réessayez.',
      };
  }
}

/* ------------------------------------------------------------------------ */
/*  Synthé de démonstration : boucle rythmique + basse + voix formantique   */
/* ------------------------------------------------------------------------ */
class DemoSynth {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.42;
    this.out.connect(dest);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.bpm = 118;
    this.step = 0;
    this.next = ctx.currentTime + 0.06;
    this.timer = setInterval(() => this._schedule(), 25);
  }

  stop() {
    clearInterval(this.timer);
    try { this.out.disconnect(); } catch { /* ignore */ }
  }

  _schedule() {
    const ahead = this.ctx.currentTime + 0.15;
    const stepDur = 60 / this.bpm / 4;
    // Onglet en arrière-plan : on rattrape sans tout jouer d'un coup.
    if (this.next < this.ctx.currentTime - 0.5) this.next = this.ctx.currentTime + 0.02;
    while (this.next < ahead) {
      this._play(this.step, this.next, stepDur);
      this.next += stepDur;
      this.step++;
    }
  }

  _play(s, t, sd) {
    const i = s % 16;
    const bar = Math.floor(s / 16);
    const section = Math.floor(bar / 4) % 4;          // 0-1 : complet, 2 : breakdown, 3 : montée
    const breakdown = section === 2;
    if (!breakdown && i % 4 === 0) this._kick(t, 0.9);
    if (section !== 2 && (i === 4 || i === 12)) this._snare(t);
    if (i % 2 === 1 || section === 3) this._hat(t, i % 4 === 2 ? 0.22 : 0.1);
    if (i === 0 && bar % 4 === 0) this._crash(t);
    const roots = [55, 43.65, 65.41, 49];
    if (!breakdown && i % 2 === 0) this._bass(t, roots[bar % 4] * (i % 8 === 6 ? 2 : 1), sd * 1.8);
    const melody = [69, 72, 76, 74, 72, 69, 67, 69, 72, 76, 79, 77, 76, 74, 72, 71];
    if (i % 4 === 0) {
      const n = melody[(bar % 4) * 4 + i / 4] + (section === 3 ? 12 : 0);
      this._voice(t, 440 * Math.pow(2, (n - 69) / 12), sd * 3.8);
    }
  }

  _env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  _noiseSrc(t, dur) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    n.start(t, Math.random() * 0.5);
    n.stop(t + dur);
    return n;
  }

  _kick(t, v) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    this._env(g, t, v, 0.004, 0.38);
    o.connect(g).connect(this.out);
    o.start(t); o.stop(t + 0.45);
  }

  _snare(t) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.6;
    const g = this.ctx.createGain();
    this._env(g, t, 0.55, 0.002, 0.2);
    this._noiseSrc(t, 0.25).connect(f).connect(g).connect(this.out);
    const o = this.ctx.createOscillator();
    o.type = 'triangle'; o.frequency.value = 190;
    const g2 = this.ctx.createGain();
    this._env(g2, t, 0.35, 0.002, 0.09);
    o.connect(g2).connect(this.out);
    o.start(t); o.stop(t + 0.12);
  }

  _hat(t, v) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 7500;
    const g = this.ctx.createGain();
    this._env(g, t, v, 0.001, 0.05);
    this._noiseSrc(t, 0.08).connect(f).connect(g).connect(this.out);
  }

  _crash(t) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 4500;
    const g = this.ctx.createGain();
    this._env(g, t, 0.5, 0.003, 1.6);
    this._noiseSrc(t, 1.7).connect(f).connect(g).connect(this.out);
  }

  _bass(t, freq, dur) {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = freq;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(180, t + dur);
    const g = this.ctx.createGain();
    this._env(g, t, 0.45, 0.01, dur);
    o.connect(f).connect(g).connect(this.out);
    o.start(t); o.stop(t + dur + 0.05);
  }

  /** Voix chantée simplifiée : dent de scie + vibrato → 3 formants (voyelle "a"). */
  _voice(t, freq, dur) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = freq;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.4;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(freq * 0.018, t + dur * 0.6);
    lfo.connect(depth).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.05);
    g.gain.setValueAtTime(0.32, t + dur * 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const [fc, q, amp] of [[750, 8, 1], [1150, 9, 0.7], [2700, 10, 0.35]]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = fc; bp.Q.value = q;
      const ga = ctx.createGain(); ga.gain.value = amp * 2.2;
      o.connect(bp).connect(ga).connect(g);
    }
    g.connect(this.out);
    o.start(t); lfo.start(t);
    o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
  }
}
