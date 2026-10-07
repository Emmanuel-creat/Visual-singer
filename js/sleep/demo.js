/**
 * demo.js — Génère une nuit synthétique réaliste (données uniquement, sans audio)
 * pour découvrir l'interface et tester les statistiques.
 */
import { CATS } from './categories.js';
import { summarize } from './analysis.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const ENV_LABELS = ['Voiture qui passe', 'Porte', 'Chien', 'Moto', 'Bruit de circulation', 'Sirène', 'Pas, marche', 'Télévision'];

/**
 * @param {object} o  { startHour, durMin, seed, snoreLevel (0..1), daysAgo }
 */
export function demoNight({ startHour = 23.3, durMin = 465, seed = 7, snoreLevel = 0.6, daysAgo = 0 } = {}) {
  const r = rng(seed);
  const d = new Date();
  d.setDate(d.getDate() - daysAgo - (d.getHours() < 12 ? 1 : 0));
  d.setHours(Math.floor(startHour), Math.round((startHour % 1) * 60), 0, 0);
  const start = d.getTime();
  const N = durMin * 60;
  const lv = new Array(N), sc = new Array(N).fill(0), ss = new Array(N).fill(0);
  const events = [], pauses = [];
  for (let t = 0; t < N; t++) lv[t] = Math.round(-67 + (r() - 0.5) * 3);

  const add = (cat, t0, len, db, n = 1, label = '') => {
    if (t0 < 0 || t0 + len >= N) return;
    for (let t = t0; t < t0 + len; t++) {
      lv[t] = Math.max(lv[t], Math.round(db - r() * 6));
      sc[t] = CATS[cat].code; ss[t] = Math.round(40 + r() * 50);
    }
    events.push({ id: `${cat}-${t0}`, cat, t0, t1: t0 + len, n, peak: +(0.4 + r() * 0.5).toFixed(2), db: Math.round(db), label, clip: '' });
  };

  const onset = 15 + Math.floor(r() * 15);
  const finalWake = durMin - 6 - Math.floor(r() * 8);
  const awakenings = [Math.floor(durMin * (0.35 + r() * 0.1)), Math.floor(durMin * (0.72 + r() * 0.08))];

  // Endormissement : agitation, télévision, paroles.
  for (let m = 0; m < onset; m++) {
    if (r() < 0.55) add('move', m * 60 + Math.floor(r() * 50), 2 + Math.floor(r() * 5), -45);
    if (m < onset * 0.6 && r() < 0.25) add('env', m * 60 + Math.floor(r() * 40), 8 + Math.floor(r() * 12), -48, 1, 'Télévision');
    if (r() < 0.12) add('speech', m * 60 + Math.floor(r() * 40), 3 + Math.floor(r() * 4), -44);
  }
  // Nuit.
  for (let m = onset; m < finalWake; m++) {
    const awake = awakenings.some((a) => m >= a && m < a + 4 + Math.floor(r() * 3));
    const t = m * 60;
    if (awake) {
      if (r() < 0.8) add('move', t + Math.floor(r() * 40), 3 + Math.floor(r() * 6), -43);
      if (r() < 0.2) add('cough', t + 20 + Math.floor(r() * 20), 2, -38, 2);
      continue;
    }
    const night = (m - onset) / (finalWake - onset);
    // Ronflements : surtout en milieu de nuit.
    const snoreP = snoreLevel * Math.exp(-((night - 0.5) ** 2) / 0.06);
    if (r() < snoreP) {
      const len = 40 + Math.floor(r() * 20);
      const db = -44 + snoreLevel * 10 + r() * 5;
      add('snore', t, len, db, Math.round(len / 4));
      // Respiration régulière audible entre les ronflements.
      if (r() < 0.12 * snoreLevel && night > 0.3 && night < 0.7) {
        const dur = 10 + Math.floor(r() * 16);
        const p0 = t + 15;
        for (let k = p0; k < p0 + dur; k++) { lv[k] = -69; sc[k] = 0; ss[k] = 0; }
        pauses.push({ id: `pause-${p0}`, t0: p0, t1: p0 + dur, dur, resume: r() < 0.5 ? 'halètement / reniflement' : 'ronflement', db: Math.round(db + 4), clip: '' });
      }
    } else if (r() < 0.5) {
      for (let k = t; k < t + 60; k++) if (!sc[k] && r() < 0.6) { sc[k] = CATS.breath.code; ss[k] = 25; lv[k] = Math.max(lv[k], -62); }
    }
    if (r() < 0.035 + 0.04 * night) add('move', t + Math.floor(r() * 50), 2 + Math.floor(r() * 4), -46);
    if (r() < 0.006) add('cough', t + Math.floor(r() * 50), 2 + Math.floor(r() * 3), -37, 1 + Math.floor(r() * 3));
    if (r() < 0.002) add('sneeze', t + Math.floor(r() * 50), 1, -35);
    if (r() < 0.004) add('speech', t + Math.floor(r() * 50), 3 + Math.floor(r() * 5), -47);
    if (r() < 0.005) add('vocal', t + Math.floor(r() * 50), 2 + Math.floor(r() * 3), -50);
    if (night > 0.6 && r() < 0.012) add('brux', t + Math.floor(r() * 50), 4 + Math.floor(r() * 8), -55, 3);
    if (r() < 0.01) add('env', t + Math.floor(r() * 50), 3 + Math.floor(r() * 10), -40 - r() * 12, 1, ENV_LABELS[Math.floor(r() * 7)]);
  }
  // Réveil.
  for (let m = finalWake; m < durMin; m++) {
    if (r() < 0.7) add('move', m * 60 + Math.floor(r() * 40), 3 + Math.floor(r() * 6), -42);
    if (r() < 0.3) add('speech', m * 60 + Math.floor(r() * 40), 4, -42);
  }
  events.sort((a, b) => a.t0 - b.t0);

  // Agrégats par minute, comme le moniteur.
  const minutes = [];
  for (let m = 0; m < durMin; m++) {
    const o = { i: m, snore: 0, breath: 0, cough: 0, sneeze: 0, speech: 0, vocal: 0, brux: 0, move: 0, env: 0 };
    const lvs = lv.slice(m * 60, m * 60 + 60);
    for (let k = m * 60; k < m * 60 + 60; k++) {
      const cat = Object.keys(CATS).find((c) => CATS[c].code === sc[k]);
      if (cat && o[cat] !== undefined) o[cat]++;
    }
    const sorted = [...lvs].sort((a, b) => a - b);
    o.lvl = sorted[30]; o.max = sorted[59]; o.floor = sorted[6];
    const audible = o.snore + o.breath >= 20;
    o.rate = audible ? +(13 + (r() - 0.5) * 3 + (o.snore ? 1 : 0)).toFixed(1) : null;
    o.reg = audible ? +(0.45 + r() * 0.4 - (pauses.some((p) => p.t0 >= m * 60 && p.t0 < m * 60 + 60) ? 0.3 : 0)).toFixed(2) : null;
    minutes.push(o);
  }

  const night = {
    id: `demo-${new Date(start).toISOString().slice(0, 10)}`, version: 1, demo: true,
    app: 'Visual Singer — Sommeil', start, end: start + N * 1000, sampleRate: 48000,
    lv, sc, ss, minutes, events, pauses, summary: null,
  };
  night.summary = summarize(night);
  night.summary.demo = true;
  return night;
}
