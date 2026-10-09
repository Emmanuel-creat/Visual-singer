/**
 * analysis.js : Statistiques et interprétations d'une nuit (fonctions pures).
 *
 * Le sommeil est estimé par « actigraphie acoustique » : chaque minute reçoit
 * un score d'activité (mouvements, paroles, toux, bruits), lissé sur les
 * minutes voisines (pondération inspirée de Cole-Kripke). Les minutes de
 * ronflement sans agitation sont comptées comme du sommeil.
 * Ce n'est pas une polysomnographie : les heures et durées sont des estimations.
 */
import { CATS, EVENT_CATS } from './categories.js';

const W = [0.0, 1.06, 0.54, 0.58, 0.76, 2.3, 0.74, 0.67]; // poids m-4 … m+2 (index 1..7)
const WAKE_THRESHOLD = 0.55;
const MIN_SLEEP_RUN = 10;   // min de sommeil continu pour l'endormissement
const MIN_WAKE_RUN = 3;     // min d'éveil pour compter un réveil

const pad = (n) => String(n).padStart(2, '0');
export const clockAt = (start, sec) => { const d = new Date(start + sec * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fmtDur = (min) => {
  if (min == null || !Number.isFinite(min)) return '-';
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)} h ${pad(m % 60)}` : `${m} min`;
};
const pct = (x) => `${Math.round(x * 100)} %`;
/** Nombre au format français (virgule décimale, espace des milliers). */
export const num = (v, d = 0) => (v == null || !Number.isFinite(v) ? '-' : v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtSec = (sec) => (sec < 60 ? `${Math.round(sec)} s` : fmtDur(sec / 60));
const percentile = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

/** Activité d'une minute (en « secondes équivalentes »). */
function activity(m) {
  return Math.min(30, m.move + 0.6 * (m.speech + m.vocal + m.cough + m.sneeze) + 0.15 * m.env);
}

/** États par minute : 1 = sommeil, 0 = éveil. */
export function scoreSleep(minutes) {
  const n = minutes.length;
  const A = minutes.map(activity);
  const st = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -4; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += W[k + 5] * A[j];
    }
    s *= 0.04;
    let sleep = s < WAKE_THRESHOLD;
    const m = minutes[i];
    if (m.snore >= 5 && m.move <= 3 && m.speech < 5) sleep = true;
    st[i] = sleep ? 1 : 0;
  }
  // Les toutes premières minutes après le lancement comptent comme éveil
  // tant qu'un vrai bloc de sommeil n'a pas commencé.
  return st;
}

/** Endormissement / réveil final / réveils intermédiaires. */
export function sleepPeriods(st) {
  const n = st.length;
  let onset = -1;
  for (let i = 0; i + MIN_SLEEP_RUN <= n; i++) {
    let ok = true;
    for (let k = 0; k < MIN_SLEEP_RUN; k++) if (!st[i + k]) { ok = false; break; }
    if (ok) { onset = i; break; }
  }
  if (onset < 0) return { onset: -1, wake: -1, awakenings: [], wasoMin: 0, tstMin: 0 };
  let wake = n;
  for (let i = n - 1; i >= onset; i--) if (st[i]) { wake = i + 1; break; }
  const awakenings = [];
  let wasoMin = 0, tstMin = 0, run = 0, runStart = -1;
  for (let i = onset; i < wake; i++) {
    if (st[i]) {
      tstMin++;
      if (run >= MIN_WAKE_RUN) awakenings.push({ start: runStart, dur: run });
      run = 0;
    } else {
      if (run === 0) runStart = i;
      run++; wasoMin++;
    }
  }
  return { onset, wake, awakenings, wasoMin, tstMin };
}

/** Résumé complet d'une nuit (stocké dans summary.json et utilisé par tous les onglets). */
export function summarize(night) {
  const { start, minutes, events, pauses, lv } = night;
  const end = night.end || start + lv.length * 1000;
  const recMin = lv.length / 60;
  const st = scoreSleep(minutes);
  const per = sleepPeriods(st);
  const sleepMin = per.tstMin;
  const sleepH = Math.max(sleepMin / 60, 1e-6);

  // Événements par catégorie.
  const byCat = {};
  for (const c of EVENT_CATS) byCat[c] = { episodes: 0, occurrences: 0, seconds: 0, times: [] };
  for (const e of events) {
    const b = byCat[e.cat];
    if (!b) continue;
    b.episodes++; b.occurrences += e.n; b.seconds += e.t1 - e.t0; b.times.push(e.t0);
  }
  byCat.pause.episodes = pauses.length;
  byCat.pause.occurrences = pauses.length;
  byCat.pause.seconds = pauses.reduce((a, p) => a + p.dur, 0);
  byCat.pause.times = pauses.map((p) => p.t0);

  // Ronflement.
  const snoreSec = minutes.reduce((a, m) => a + m.snore, 0);
  const snoreSleepSec = minutes.reduce((a, m, i) => a + (st[i] ? m.snore : 0), 0);
  const snoreDb = events.filter((e) => e.cat === 'snore').map((e) => e.db);
  const half = Math.floor(minutes.length / 2);
  const snoreFirst = minutes.slice(0, half).reduce((a, m) => a + m.snore, 0);
  const snoreSecond = minutes.slice(half).reduce((a, m) => a + m.snore, 0);

  // Respiration (minutes de sommeil avec respiration audible).
  const breathMin = minutes.filter((m, i) => st[i] && m.rate != null);
  const rates = breathMin.map((m) => m.rate);
  const regs = breathMin.map((m) => m.reg);

  // Heures d'horloge.
  const hours = [];
  const firstHour = new Date(start); firstHour.setMinutes(0, 0, 0);
  for (let h = firstHour.getTime(); h < end; h += 3600e3) {
    const s0 = Math.max(0, (h - start) / 1000), s1 = Math.min(lv.length, (h + 3600e3 - start) / 1000);
    if (s1 <= s0) continue;
    const mins = minutes.slice(Math.floor(s0 / 60), Math.ceil(s1 / 60));
    const inH = (t) => t >= s0 && t < s1;
    const lvH = lv.slice(Math.floor(s0), Math.floor(s1));
    hours.push({
      label: `${pad(new Date(h).getHours())}h`,
      t0: s0, t1: s1,
      sleepMin: mins.reduce((a, m, k) => a + (st[Math.floor(s0 / 60) + k] ? 1 : 0), 0),
      snoreMin: +(mins.reduce((a, m) => a + m.snore, 0) / 60).toFixed(1),
      move: events.filter((e) => e.cat === 'move' && inH(e.t0)).length,
      cough: events.filter((e) => e.cat === 'cough' && inH(e.t0)).reduce((a, e) => a + e.n, 0),
      speech: events.filter((e) => (e.cat === 'speech' || e.cat === 'vocal') && inH(e.t0)).length,
      env: events.filter((e) => e.cat === 'env' && inH(e.t0)).length,
      pauses: pauses.filter((p) => inH(p.t0)).length,
      lvl: percentile(lvH, 0.5),
    });
  }

  // Environnement.
  const envTypes = {};
  for (const e of events.filter((x) => x.cat === 'env')) {
    const k = e.label || 'Autre bruit';
    envTypes[k] ??= { label: k, count: 0, seconds: 0, maxDb: -120 };
    envTypes[k].count++; envTypes[k].seconds += e.t1 - e.t0; envTypes[k].maxDb = Math.max(envTypes[k].maxDb, e.db);
  }
  const loudest = [...events].sort((a, b) => b.db - a.db).slice(0, 5);
  // Bruits suivis d'un réveil dans les 2 minutes.
  const wakeStarts = per.awakenings.map((a) => a.start * 60);
  const disturbing = events.filter((e) => e.cat === 'env' && wakeStarts.some((w) => w - e.t0 >= -30 && w - e.t0 <= 120));

  const s = {
    id: night.id, start, end, final: !!night.end,
    recMin: +recMin.toFixed(1),
    states: Array.from(st),
    onset: per.onset, wake: per.wake,
    onsetClock: per.onset >= 0 ? clockAt(start, per.onset * 60) : null,
    wakeClock: per.onset >= 0 ? clockAt(start, per.wake * 60) : null,
    latencyMin: per.onset >= 0 ? per.onset : null,
    sleepMin, wasoMin: per.wasoMin,
    efficiency: recMin > 0 ? sleepMin / recMin : 0,
    awakenings: per.awakenings,
    byCat,
    snore: {
      seconds: snoreSec, pctSleep: sleepMin ? snoreSleepSec / (sleepMin * 60) : 0,
      count: byCat.snore.occurrences, episodes: byCat.snore.episodes,
      meanDb: snoreDb.length ? Math.round(mean(snoreDb)) : null, maxDb: snoreDb.length ? Math.max(...snoreDb) : null,
      trend: snoreFirst + snoreSecond > 0 ? (snoreSecond - snoreFirst) / (snoreFirst + snoreSecond) : 0,
    },
    pauses: {
      count: pauses.length, perHour: pauses.length / sleepH,
      maxDur: pauses.length ? Math.max(...pauses.map((p) => p.dur)) : 0,
      meanDur: pauses.length ? mean(pauses.map((p) => p.dur)) : 0,
      duringSnore: pauses.filter((p) => p.resume === 'ronflement').length,
      gaspResume: pauses.filter((p) => p.resume.startsWith('halètement')).length,
    },
    breathing: {
      minutes: breathMin.length, coverage: sleepMin ? breathMin.length / sleepMin : 0,
      rate: rates.length ? mean(rates) : null,
      rateSd: rates.length > 1 ? Math.sqrt(mean(rates.map((r) => (r - mean(rates)) ** 2))) : null,
      regularity: regs.length ? mean(regs) : null,
      irregularPct: regs.length ? regs.filter((r) => r < 0.35).length / regs.length : null,
    },
    movement: {
      episodes: byCat.move.episodes, perHour: byCat.move.episodes / sleepH,
      restlessMin: minutes.filter((m) => m.move >= 5).length,
    },
    ambient: {
      l90: percentile(lv, 0.1), l50: percentile(lv, 0.5), l10: percentile(lv, 0.9),
      max: lv.length ? Math.max(...lv) : null,
    },
    envTypes: Object.values(envTypes).sort((a, b) => b.count - a.count),
    loudest: loudest.map((e) => ({ cat: e.cat, label: e.label, t0: e.t0, db: e.db })),
    disturbing: disturbing.map((e) => ({ label: e.label, t0: e.t0, db: e.db })),
    hours,
  };
  s.csv = {
    id: night.id,
    debut: new Date(start).toLocaleString('fr-FR'), fin: new Date(end).toLocaleString('fr-FR'),
    duree_enregistrement_min: Math.round(recMin), endormissement: s.onsetClock || '', reveil: s.wakeClock || '',
    latence_min: s.latencyMin ?? '', sommeil_min: sleepMin, efficacite_pct: Math.round(s.efficiency * 100),
    reveils: per.awakenings.length, eveil_intra_min: per.wasoMin,
    ronflement_pct: Math.round(s.snore.pctSleep * 100), ronflements: s.snore.count,
    pauses_suspectes: s.pauses.count, pauses_par_heure: s.pauses.perHour.toFixed(1).replace('.', ','), pause_max_s: s.pauses.maxDur,
    toux: byCat.cough.occurrences, eternuements: byCat.sneeze.occurrences, paroles: byCat.speech.episodes,
    vocalisations: byCat.vocal.episodes, machoire: byCat.brux.episodes, mouvements: byCat.move.episodes,
    agitation_par_heure: s.movement.perHour.toFixed(1).replace('.', ','), bruits_exterieurs: byCat.env.episodes,
    niveau_median_db: s.ambient.l50 ?? '', rythme_resp_moyen: s.breathing.rate ? s.breathing.rate.toFixed(1).replace('.', ',') : '',
  };
  return s;
}

/* ------------------------------------------------------- Comparaisons --- */

/** Indicateurs comparables entre nuits. `better` : sens favorable (+1 / -1 / 0 = neutre). */
export const METRICS = [
  { key: 'sleepMin', label: 'Sommeil estimé', unit: 'min', fmt: fmtDur, get: (s) => s.sleepMin, better: 1, minAbs: 15 },
  { key: 'efficiency', label: 'Efficacité', unit: '%', fmt: (v) => pct(v), get: (s) => s.efficiency, better: 1, minAbs: 0.04 },
  { key: 'latency', label: "Délai d'endormissement", unit: 'min', fmt: fmtDur, get: (s) => s.latencyMin, better: -1, minAbs: 8 },
  { key: 'awak', label: 'Réveils nocturnes', unit: '', fmt: (v) => num(v), get: (s) => s.awakenings.length, better: -1, minAbs: 2 },
  { key: 'waso', label: 'Éveil pendant la nuit', unit: 'min', fmt: fmtDur, get: (s) => s.wasoMin, better: -1, minAbs: 10 },
  { key: 'snorePct', label: 'Temps de ronflement', unit: '%', fmt: (v) => pct(v), get: (s) => s.snore.pctSleep, better: -1, minAbs: 0.05 },
  { key: 'snoreCount', label: 'Ronflements', unit: '', fmt: (v) => num(v), get: (s) => s.snore.count, better: -1, minAbs: 50 },
  { key: 'pauses', label: 'Pauses suspectes / h', unit: '/h', fmt: (v) => num(v, 1), get: (s) => s.pauses.perHour, better: -1, minAbs: 0.8 },
  { key: 'rate', label: 'Rythme respiratoire', unit: '/min', fmt: (v) => num(v, 1), get: (s) => s.breathing.rate, better: 0, minAbs: 1.5 },
  { key: 'reg', label: 'Régularité respiratoire', unit: '', fmt: (v) => num(v, 2), get: (s) => s.breathing.regularity, better: 1, minAbs: 0.1 },
  { key: 'cough', label: 'Toux', unit: '', fmt: (v) => num(v), get: (s) => s.byCat.cough.occurrences, better: -1, minAbs: 4 },
  { key: 'sneeze', label: 'Éternuements', unit: '', fmt: (v) => num(v), get: (s) => s.byCat.sneeze.occurrences, better: -1, minAbs: 3 },
  { key: 'speech', label: 'Paroles', unit: '', fmt: (v) => num(v), get: (s) => s.byCat.speech.episodes, better: 0, minAbs: 3 },
  { key: 'vocal', label: 'Vocalisations', unit: '', fmt: (v) => num(v), get: (s) => s.byCat.vocal.episodes, better: 0, minAbs: 3 },
  { key: 'brux', label: 'Bruits de mâchoire', unit: '', fmt: (v) => num(v), get: (s) => s.byCat.brux.episodes, better: -1, minAbs: 3 },
  { key: 'move', label: 'Agitation (mouvements / h)', unit: '/h', fmt: (v) => num(v, 1), get: (s) => s.movement.perHour, better: -1, minAbs: 2 },
  { key: 'env', label: 'Bruits extérieurs', unit: '', fmt: (v) => num(v), get: (s) => s.byCat.env.episodes, better: -1, minAbs: 4 },
  { key: 'l50', label: 'Niveau sonore médian', unit: 'dB', fmt: (v) => `${num(v)} dB`, get: (s) => s.ambient.l50, better: -1, minAbs: 3 },
];

/** Moyenne de chaque indicateur sur un ensemble de nuits. */
export function averages(list) {
  const out = {};
  for (const m of METRICS) {
    const vals = list.map((s) => m.get(s)).filter((v) => v != null && Number.isFinite(v));
    out[m.key] = vals.length ? mean(vals) : null;
  }
  return out;
}

/* ---------------------------------------------------- Interprétations --- */

/**
 * Phrases d'interprétation (factuelles, sans conseil) de la nuit `s`,
 * comparée aux autres nuits `others` quand il y en a.
 */
export function interpret(s, others = []) {
  const out = [];
  const avg = others.length ? averages(others) : null;
  const vsAvg = (key, value, fmt, unitWord = '') => {
    if (!avg || avg[key] == null || value == null) return '';
    const d = value - avg[key];
    if (!/[1-9]/.test(String(fmt(Math.abs(d))))) return ' Comme la moyenne des autres nuits.';
    return ` ${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}${unitWord} par rapport à la moyenne des ${others.length} autres nuits.`;
  };
  const at = (sec) => clockAt(s.start, sec);
  const listTimes = (times, max = 6) => times.slice(0, max).map(at).join(', ') + (times.length > max ? '…' : '');

  // Sommeil.
  if (s.onset >= 0) {
    out.push({
      icon: 'sleep', title: 'Sommeil',
      text: `Endormissement estimé à ${s.onsetClock}, ${fmtDur(s.latencyMin)} après le début de l'enregistrement ; réveil final vers ${s.wakeClock}. `
        + `Sommeil estimé : ${fmtDur(s.sleepMin)} sur ${fmtDur(s.recMin)} d'enregistrement (efficacité ${pct(s.efficiency)}).`
        + vsAvg('sleepMin', s.sleepMin, fmtDur)
        + (s.awakenings.length
          ? ` ${s.awakenings.length} réveil${s.awakenings.length > 1 ? 's' : ''} nocturne${s.awakenings.length > 1 ? 's' : ''} (${s.awakenings.map((a) => `${at(a.start * 60)} · ${a.dur} min`).join(', ')}), ${fmtDur(s.wasoMin)} d'éveil au total.`
          : ' Aucun réveil de plus de 3 minutes détecté.'),
    });
  } else {
    out.push({ icon: 'sleep', title: 'Sommeil', text: `Pas de période de sommeil continue (≥ ${MIN_SLEEP_RUN} min) identifiée sur ${fmtDur(s.recMin)} d'enregistrement.` });
  }

  // Ronflements.
  if (s.snore.count) {
    const peakHour = [...s.hours].sort((a, b) => b.snoreMin - a.snoreMin)[0];
    const trend = s.snore.trend > 0.25 ? ' Plus présents en seconde partie de nuit.' : s.snore.trend < -0.25 ? ' Plus présents en première partie de nuit.' : ' Répartis sur toute la nuit.';
    out.push({
      icon: 'snore', title: 'Ronflements',
      text: `${num(s.snore.count)} ronflements en ${s.snore.episodes} épisode${s.snore.episodes > 1 ? 's' : ''}, soit ${pct(s.snore.pctSleep)} du temps de sommeil (${fmtSec(s.snore.seconds)} cumulées). `
        + `Heure la plus chargée : ${peakHour ? peakHour.label.replace('h', ' h') : '-'} (${num(peakHour?.snoreMin ?? 0)} min de ronflement). Intensité moyenne ${s.snore.meanDb} dB, maximum ${s.snore.maxDb} dB.`
        + trend + vsAvg('snorePct', s.snore.pctSleep, (v) => `${Math.round(v * 100)}`, ' pts'),
    });
  } else {
    out.push({ icon: 'snore', title: 'Ronflements', text: 'Aucun ronflement détecté.' });
  }

  // Pauses respiratoires.
  if (s.pauses.count) {
    out.push({
      icon: 'pause', title: 'Pauses respiratoires suspectes',
      text: `${s.pauses.count} interruption${s.pauses.count > 1 ? 's' : ''} du bruit respiratoire de 10 s ou plus (${num(s.pauses.perHour, 1)} par heure de sommeil), `
        + `durée moyenne ${Math.round(s.pauses.meanDur)} s, maximum ${s.pauses.maxDur} s. `
        + `${s.pauses.duringSnore} reprise${s.pauses.duringSnore > 1 ? 's' : ''} par un ronflement, ${s.pauses.gaspResume} par un halètement ou reniflement.`
        + vsAvg('pauses', s.pauses.perHour, (v) => num(v, 1), '/h'),
    });
  } else {
    out.push({ icon: 'pause', title: 'Pauses respiratoires suspectes', text: 'Aucune interruption respiratoire suspecte détectée acoustiquement.' });
  }

  // Respiration.
  if (s.breathing.rate) {
    out.push({
      icon: 'breath', title: 'Respiration',
      text: `Rythme estimé ${num(s.breathing.rate, 1)} respirations/min (écart-type ${num(s.breathing.rateSd ?? 0, 1)}), mesuré sur ${pct(s.breathing.coverage)} du sommeil, là où la respiration est audible. `
        + `Régularité moyenne ${num(s.breathing.regularity, 2)} (0 = irrégulière, 1 = parfaitement régulière) ; ${pct(s.breathing.irregularPct)} des minutes mesurées sont irrégulières.`,
    });
  } else {
    out.push({ icon: 'breath', title: 'Respiration', text: 'Respiration trop peu audible pour estimer un rythme (micro trop loin ou respiration silencieuse).' });
  }

  // Toux, éternuements, paroles, vocalisations, mâchoire.
  const c = s.byCat;
  const misc = [];
  if (c.cough.episodes) misc.push(`toux : ${c.cough.occurrences} en ${c.cough.episodes} épisode${c.cough.episodes > 1 ? 's' : ''} (${listTimes(c.cough.times)})`);
  if (c.sneeze.episodes) misc.push(`éternuements : ${c.sneeze.occurrences} (${listTimes(c.sneeze.times)})`);
  if (c.speech.episodes) misc.push(`paroles : ${c.speech.episodes} épisode${c.speech.episodes > 1 ? 's' : ''} (${listTimes(c.speech.times)})`);
  if (c.vocal.episodes) misc.push(`gémissements / vocalisations : ${c.vocal.episodes} (${listTimes(c.vocal.times)})`);
  if (c.brux.episodes) misc.push(`bruits de mâchoire : ${c.brux.episodes} épisode${c.brux.episodes > 1 ? 's' : ''}, ${fmtSec(c.brux.seconds)} au total`);
  const miscText = misc.length ? `${misc.join(' ; ')}.` : 'Aucune toux, aucun éternuement, aucune parole ni vocalisation détectés.';
  out.push({ icon: 'speech', title: 'Toux, paroles et autres sons', text: miscText.charAt(0).toUpperCase() + miscText.slice(1) });

  // Mouvements.
  const busiest = [...s.hours].sort((a, b) => b.move - a.move)[0];
  out.push({
    icon: 'move', title: 'Mouvements',
    text: `${s.movement.episodes} épisodes de mouvement (${num(s.movement.perHour, 1)} par heure de sommeil), ${s.movement.restlessMin} minute${s.movement.restlessMin > 1 ? 's' : ''} agitée${s.movement.restlessMin > 1 ? 's' : ''}.`
      + (busiest?.move ? ` Heure la plus agitée : ${busiest.label.replace('h', ' h')} (${busiest.move} mouvements).` : '')
      + vsAvg('move', s.movement.perHour, (v) => num(v, 1), '/h'),
  });

  // Environnement.
  const types = s.envTypes.slice(0, 4).map((e) => `${e.label} ×${e.count}`).join(', ');
  out.push({
    icon: 'env', title: 'Environnement',
    text: `Niveau ambiant médian ${s.ambient.l50 ?? '-'} dB (fond ${s.ambient.l90 ?? '-'} dB, pics fréquents ${s.ambient.l10 ?? '-'} dB, maximum ${s.ambient.max ?? '-'} dB). `
      + (c.env.episodes ? `${c.env.episodes} bruit${c.env.episodes > 1 ? 's' : ''} environnant${c.env.episodes > 1 ? 's' : ''} : ${types}.` : 'Aucun bruit environnant marquant.')
      + (s.disturbing.length ? ` ${s.disturbing.length === 1 ? "L'un d'eux précède" : `${s.disturbing.length} d'entre eux précèdent`} de peu un réveil (${s.disturbing.slice(0, 3).map((d) => `${d.label} à ${at(d.t0)}`).join(', ')}).` : ''),
  });

  // Écarts marquants avec les autres nuits.
  if (avg && others.length >= 2) {
    const diffs = [];
    for (const m of METRICS) {
      const v = m.get(s), a = avg[m.key];
      if (v == null || a == null || !m.better) continue;
      const rel = a !== 0 ? (v - a) / Math.abs(a) : v ? 1 : 0;
      if (Math.abs(rel) >= 0.3 && Math.abs(v - a) >= (m.minAbs ?? 0)) diffs.push({ m, v, a, rel });
    }
    diffs.sort((x, y) => Math.abs(y.rel) - Math.abs(x.rel));
    if (diffs.length) {
      out.push({
        icon: 'compare', title: 'Écarts avec les nuits précédentes',
        text: diffs.slice(0, 5).map(({ m, v, a, rel }) => `${m.label} : ${m.fmt(v)} contre ${m.fmt(a)} en moyenne (${rel > 0 ? '+' : '−'}${Math.round(Math.abs(rel) * 100)} %)`).join(' ; ') + '.',
      });
    }
  }
  return out;
}

export { CATS };
