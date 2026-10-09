/**
 * app.js — Point d'entrée : instancie les modules et pilote la boucle d'animation.
 *
 *   AudioEngine ──frame──▶ AudioHistory ──▶ Visualizer (3D)
 *        │                     │        └─▶ Timeline (2D)
 *        └─ PeakDetector ──────┘
 *   Transport (curseur temporel) ─▶ quel instant afficher
 *   ServerConnector (indépendant) ─▶ barre supérieure / panneau serveur
 *   Recognizer (BirdNET + YAMNet) ─▶ IdentifyPanel, 3D, timeline, Bureau
 *   DesktopStore ─▶ « Bureau/Visual Singer » (via server.py)
 *   UI (controls.js) ─▶ DOM, paramètres, couleurs, raccourcis
 */
import { Settings } from './settings.js';
import { ThemeManager } from './theme.js';
import { AudioEngine, PeakDetector, BANDS } from './audio.js';
import { AudioHistory } from './history.js';
import { Transport } from './transport.js';
import { Visualizer, TRAIL_MODES } from './visualizer.js';
import { Timeline } from './timeline.js';
import { ServerConnector } from './server.js';
import { UI } from './controls.js';
import { Recognizer } from './recognizer.js';
import { IdentifyPanel } from './identify-panel.js';
import { DesktopStore } from './persist.js';
import { CATEGORIES } from './sound-labels.js';
import { icon, hydrateIcons } from './icons.js';
import { initShell } from './shell.js';
import { clamp, damp, debounce } from './utils.js';

async function boot() {
  hydrateIcons();
  // Sauvegarde sur le Bureau (si l'appli est servie par server.py).
  const store = new DesktopStore();
  await store.init();
  const saved = await store.loadState();

  const settings = new Settings(saved?.settings);
  const theme = new ThemeManager(saved);
  const history = new AudioHistory(BANDS, settings.get('retention'), settings.get('historyRate'));
  const audio = new AudioEngine(settings);
  const peaks = new PeakDetector();
  const transport = new Transport(history);
  transport.speed = settings.get('playbackSpeed');

  let viz;
  try {
    viz = new Visualizer(document.getElementById('gl'), document.getElementById('labels'));
  } catch (err) {
    showFatal('WebGL indisponible', "La carte graphique ou le navigateur ne permet pas d'afficher la 3D (WebGL2). Activez l'accélération matérielle puis rechargez la page.", err);
    return;
  }
  const timeline = new Timeline(document.getElementById('timeline'), history, transport, settings);
  const server = new ServerConnector(settings);
  const ui = new UI({ settings, theme, audio, history, transport, viz, timeline, server });
  initShell({
    beforeQuit: async () => { try { audio.stop(); } catch { /* déjà arrêté */ } },
    shortcuts: [
      ['Espace', 'Lecture / pause'], ['L', 'Retour au direct'],
      ['← / →', 'Reculer / avancer de 1 s (Maj : 5 s)'], ['J / K', 'Retour arrière / avance rapide'],
      ['[ / ]', 'Vitesse de lecture'], ['1 2 3 4', 'Vues dessus · face · côté · 3D'], ['R', 'Réinitialiser la caméra'],
      ['V', 'Vue caméra suivante'], ['A', 'Rotation automatique'], ['T', 'Mode de traînée suivant'],
      ['H', 'Afficher / masquer les mesures'], ['B', 'Panneau latéral'], ['C / S', 'Couleurs / paramètres'], ['F', 'Plein écran'],
    ],
  });

  /* ------------------------- Identification des sons ------------------------- */

  let t0 = null; // horloge de session : démarre à la première connexion audio
  const sessionTime = () => (t0 === null ? 0 : (performance.now() - t0) / 1000);
  const recognizer = new Recognizer(audio, settings, sessionTime);
  const identify = new IdentifyPanel({ recognizer, transport, settings, store });
  viz.setDetections(recognizer.detections);
  timeline.detections = recognizer.detections;

  // Sauvegarde des réglages et thèmes sur le Bureau.
  const saveState = () => store.saveState({
    app: 'Visual Singer', savedAt: new Date().toISOString(),
    settings: settings.values,
    theme: { name: theme.presetName, colors: theme.colors },
    customThemes: theme.custom,
  });
  settings.on('change', saveState);
  theme.on('change', saveState);

  // Chaque détection terminée → journal CSV/JSON + extrait WAV sur le Bureau.
  recognizer.on('final', async ({ detection: d, audio: samples, sampleRate }) => {
    if (!store.available || !settings.get('saveDetections')) return;
    const at = new Date(d.wallTime);
    const hhmmss = at.toTimeString().slice(0, 8);
    let clip = '';
    if (settings.get('saveClips') && samples) {
      clip = await store.saveClip(`${hhmmss.replace(/:/g, '')}_${CATEGORIES[d.category]?.label || d.category}_${d.label}`, samples, sampleRate);
    }
    d.clip = clip;
    await store.saveDetection({
      heure: hhmmss, wallTime: d.wallTime,
      category: d.category, categorie: CATEGORIES[d.category]?.label || d.category,
      label: d.label, sci: d.sci, en: d.en,
      confidence: +d.confidence.toFixed(3), duration: +(d.end - d.start + 0.0).toFixed(1), hits: d.hits,
      source: d.source, clip, alternatives: d.alternatives,
    });
  });

  const storeNote = document.getElementById('storeNote');
  document.getElementById('dataDir').textContent = store.available ? store.dataDir : 'navigateur uniquement';
  document.getElementById('dataDir').title = store.dataDir;
  storeNote.textContent = store.available
    ? 'Les réglages, thèmes, détections et extraits sont enregistrés dans ce dossier.'
    : "Sauvegarde Bureau indisponible : lancez l'appli avec « python server.py » (ou start.bat) au lieu de « python -m http.server ».";
  if (store.available) identify.setPast(await store.loadDetections());

  // L'analyse démarre dès que l'audio est actif (si l'option est cochée).
  audio.on('state', ({ state }) => {
    if (state === 'active' && settings.get('recogEnabled')) recognizer.start();
    else if (state !== 'active') recognizer.closeAll();
  });

  // Source identifiée dans le HUD.
  const hudSrc = document.getElementById('hudSrc');
  const hudSrcConf = document.getElementById('hudSrcConf');
  setInterval(() => {
    const d = identify.currentSource();
    const c = d && CATEGORIES[d.category];
    const txt = d ? d.label : recognizer.running ? '…' : '—';
    if (hudSrc.dataset.txt !== txt) {
      hudSrc.dataset.txt = txt;
      hudSrc.innerHTML = d ? `${icon(c.icon, c.color)} ` : '';
      hudSrc.append(txt);
    }
    hudSrc.style.setProperty('--src', c ? c.color : '');
    hudSrcConf.textContent = d ? `${Math.round(d.confidence * 100)}%` : '';
  }, 250);

  /* ---------------------------- Réglages → modules ---------------------------- */

  const applyFreqLayout = () => {
    const sr = audio.sampleRate || 48000;
    const fmin = Math.max(10, settings.get('freqMin'));
    const fmax = Math.min(sr / 2, Math.max(fmin * 2, settings.get('freqMax')));
    viz.setFreqLayout({
      fmin, fmax,
      bassMax: clamp(settings.get('bassMax'), fmin * 1.1, fmax / 1.2),
      midMax: clamp(settings.get('midMax'), settings.get('bassMax') * 1.1, fmax / 1.05),
    });
  };
  viz.setTheme(theme.colors);
  timeline.setTheme(theme.colors);
  viz.setQuality(settings.get('quality'));
  viz.setWireframe(settings.get('wireframe'));
  viz.setContours(settings.get('contours'));
  viz.setHeightScale(settings.get('heightScale'));
  viz.setDecibels(settings.get('minDb'), settings.get('maxDb'));
  viz.setShowLabels(settings.get('showLabels'));
  viz.orbit.autoRotate = settings.get('autoRotate');
  viz.orbit.autoSpeed = settings.get('autoRotateSpeed');
  applyFreqLayout();

  theme.on('change', (c) => { viz.setTheme(c); timeline.setTheme(c); });
  audio.on('config', applyFreqLayout);

  const reconnectServer = debounce(() => server.connect(), 600);
  settings.on('change', ({ key, value }) => {
    switch (key) {
      case 'retention': case 'historyRate':
        history.configure(settings.get('retention'), settings.get('historyRate')); break;
      case 'quality': viz.setQuality(value); break;
      case 'wireframe': viz.setWireframe(value); break;
      case 'contours': viz.setContours(value); break;
      case 'heightScale': viz.setHeightScale(value); break;
      case 'showLabels': viz.setShowLabels(value); break;
      case 'minDb': case 'maxDb': viz.setDecibels(settings.get('minDb'), settings.get('maxDb')); break;
      case 'freqMin': case 'freqMax': case 'bassMax': case 'midMax': applyFreqLayout(); break;
      case 'autoRotate': viz.orbit.autoRotate = value; break;
      case 'autoRotateSpeed': viz.orbit.autoSpeed = value; break;
      case 'playbackSpeed': transport.setSpeed(value); break;
      case 'serverSource': server.connect(); break;
      case 'serverUrl': case 'serverInterval': reconnectServer(); break;
      default: break;
    }
  });

  audio.on('state', ({ state }) => {
    if (state === 'active' && t0 === null) t0 = performance.now();
    if (state === 'active') peaks.reset();
  });

  server.connect();

  /* ------------------------------- Boucle -------------------------------- */

  const shownFrame = { time: 0, bands: new Uint8Array(BANDS), bass: 0, mid: 0, treble: 0, intensity: 0, rmsDb: -140, peak: 0, peakDb: -140, dominantFrequency: 0, clipping: false };
  const zones = { bass: 0, mid: 0, treble: 0 };
  const trail = { strength: 0, fade: 0, length: 0 };
  let last = performance.now();
  let lastPush = -Infinity;
  let viewOffset = 0;
  let fps = 60;

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0.0001, (now - last) / 1000));
    last = now;
    fps += (1 / dt - fps) * 0.05;

    const session = t0 === null ? 0 : (now - t0) / 1000;
    const rate = settings.get('historyRate');

    // 1) Analyse + enregistrement à cadence fixe.
    let live = null;
    if (audio.active) {
      live = audio.analyze(session);
      if (live && session - lastPush >= 1 / rate - 0.004) {
        history.push(live);
        lastPush = session;
        const p = peaks.update(live, settings.get('peakThreshold'), history, audio);
        if (p) {
          ui.addPeak(p);
          if (transport.isLive) viz.triggerPulse();
        }
      }
    }

    // 2) Instant "direct" légèrement retardé pour toujours interpoler entre deux tranches.
    const liveTime = history.length ? clamp(session - 1 / rate, history.oldestTime, history.latestTime) : 0;
    transport.update(dt, liveTime);
    const cursor = transport.cursor;

    // 3) Fenêtre 3D : en direct le curseur est au bord ; en relecture il se décale pour montrer l'avant/après.
    const win = settings.get('window3d');
    viewOffset += ((transport.isLive ? 0 : 0.3) - viewOffset) * damp(5, dt);
    const we = cursor + win * viewOffset;
    const ws = we - win;

    // 4) État affiché (direct = analyse la plus fraîche, sinon interpolation de l'historique).
    const shown = transport.isLive && live ? live : history.sample(cursor, shownFrame) ? shownFrame : null;
    zones.bass = shown ? shown.bass : 0;
    zones.mid = shown ? shown.mid : 0;
    zones.treble = shown ? shown.treble : 0;

    const mode = TRAIL_MODES[settings.get('trailMode')] || TRAIL_MODES.medium;
    trail.strength = mode.strength;
    trail.fade = mode.fade;
    trail.length = mode.length === Infinity ? Infinity : mode.length === 0 ? 0 : settings.get('trailLength');

    viz.update(dt, { history, cursor, ws, we, trail, zones, live: transport.isLive });
    viz.render();
    timeline.draw({ liveTime, ws, we });
    ui.tick({ shown, live, cursor, liveTime, fps, dt });
  }
  requestAnimationFrame(frame);

  // Accès console pour le débogage / extensions.
  window.visualSinger = { settings, theme, audio, history, transport, viz, timeline, server, ui, recognizer, identify, store };
}

function showFatal(title, message, err) {
  console.error(err);
  const ov = document.getElementById('overlay');
  ov.dataset.state = 'error';
  document.getElementById('errTitle').textContent = title;
  document.getElementById('errMessage').textContent = message;
  document.getElementById('errHint').textContent = 'Chrome / Edge : Paramètres → Système → « Utiliser l\'accélération graphique ».';
  document.getElementById('errCode').textContent = String(err?.message || err);
}

boot().catch((err) => showFatal('Erreur de démarrage', "L'application n'a pas pu démarrer.", err));
