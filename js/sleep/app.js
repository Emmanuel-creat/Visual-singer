/**
 * app.js — Application « Sommeil » : enregistrement de la nuit, onglets d'analyse, historique.
 *
 *   SleepMonitor (monitor.js) ─▶ nuit en cours (données brutes + événements)
 *   analysis.js               ─▶ résumé, interprétations, comparaisons
 *   charts.js                 ─▶ graphiques Canvas
 *   SleepStore (store.js)     ─▶ Bureau/Visual Singer/sommeil (via server.py)
 */
import { Settings } from '../settings.js';
import { AudioEngine } from '../audio.js';
import { storage } from '../utils.js';
import { SleepMonitor } from './monitor.js';
import { SleepStore } from './store.js';
import { CATS, EVENT_CATS, CODE_TO_CAT } from './categories.js';
import { summarize, interpret, averages, METRICS, fmtDur, clockAt, num } from './analysis.js';
import { TimeChart, BarChart, LaneChart, rgba } from './charts.js';
import { demoNight } from './demo.js';
import { icon, hydrateIcons } from '../icons.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const hms = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(Math.floor(sec % 60))}`;
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)} %`);
const dateLabel = (ms) => new Date(ms).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const LANE_LABEL = {
  snore: 'Ronflement', pause: 'Pause respiratoire', cough: 'Toux', sneeze: 'Éternuement', speech: 'Paroles',
  vocal: 'Vocalisation', brux: 'Mâchoire', move: 'Mouvement', env: 'Environnement',
};
const SLEEP_CFG_KEY = 'visual-singer.sleep';
const playIco = icon('play', '#3987e5', { tile: false });
/** Couleur de l'icône d'une interprétation (catégorie correspondante). */
const interpColor = (name) => ({ sleep: '#3987e5', compare: '#9085e9' }[name] || Object.values(CATS).find((c) => c.icon === name)?.color || '#3987e5');

/* ------------------------------------------------------------------ État --- */

const settings = new Settings();
const audio = new AudioEngine(settings);
const store = new SleepStore();
const cfg = { clipsPerCategory: 25, stopMicAfter: true, ...(storage.get(SLEEP_CFG_KEY, {}) || {}) };
const monitor = new SleepMonitor(audio, store, cfg);

let summaries = [];        // nuits enregistrées (résumés)
let demo = [];             // nuits de démonstration (complètes, en mémoire)
let current = null;        // nuit complète affichée dans les onglets d'analyse
let currentId = '';
let tab = 'live';
let liveSummary = null;
const charts = {};
let evFilter = 'all';
let hourMetric = 'snoreMin';

/* ------------------------------------------------------------- Démarrage --- */

async function boot() {
  hydrateIcons();
  await store.init();
  $('#storeWarn').hidden = store.available;
  $('#dataDir').textContent = store.available ? `Dossier : ${store.dataDir}\\sommeil` : 'Sauvegarde Bureau indisponible (lancez start-sommeil.bat)';
  $('#clipBudget').value = String(cfg.clipsPerCategory);
  $('#clipBudget').addEventListener('change', (e) => { cfg.clipsPerCategory = Number(e.target.value); storage.set(SLEEP_CFG_KEY, cfg); });

  bindTabs();
  bindLive();
  bindPlayer();
  buildCounters();
  $('#btnDemo').addEventListener('click', loadDemo);
  $('#hourMetric').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (!b) return;
    hourMetric = b.dataset.m;
    for (const x of $$('#hourMetric button')) x.classList.toggle('on', x === b);
    renderSummary();
  });
  $('#nightSelect').addEventListener('change', (e) => selectNight(e.target.value));
  $('#tlReset').addEventListener('click', () => charts.tl?.resetZoom());
  for (const s of ['#cmpA', '#cmpB']) $(s).addEventListener('change', renderCompare);
  $('#trendMetric').innerHTML = METRICS.map((m) => `<option value="${m.key}">${esc(m.label)}</option>`).join('');
  $('#trendMetric').addEventListener('change', renderTrend);

  await refreshNights();
  if (summaries.length) await selectNight(summaries[summaries.length - 1].id);
  renderAll();
  setInterval(tickClock, 1000);
  setInterval(() => { if (monitor.state === 'recording') refreshLive(); }, 10000);
}

/* ---------------------------------------------------------------- Onglets --- */

function bindTabs() {
  for (const b of $$('.s-tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
}

function showTab(name) {
  tab = name;
  for (const b of $$('.s-tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const p of $$('.pane')) p.classList.toggle('on', p.dataset.pane === name);
  renderTab();
}

function renderAll() { renderTab(); renderHistory(); }

function renderTab() {
  const night = shownNight();
  for (const p of $$('.pane')) if (p.dataset.pane !== 'live' && p.dataset.pane !== 'history') p.classList.toggle('empty', !night);
  if (tab === 'live') renderLive();
  else if (tab === 'history') renderHistory();
  else if (night) ({ summary: renderSummary, timeline: renderTimeline, breath: renderBreath, events: renderEvents, env: renderEnv })[tab]?.();
}

/** Nuit affichée : la nuit sélectionnée, ou la nuit en cours si elle est choisie. */
function shownNight() {
  if (currentId === '__live__' && monitor.night) return monitor.night;
  return current;
}
function shownSummary() {
  const n = shownNight();
  if (!n) return null;
  if (n === monitor.night) return liveSummary || (liveSummary = summarize(n));
  return n.summary || (n.summary = summarize(n));
}

/* ----------------------------------------------------------------- Nuits --- */

async function refreshNights() {
  summaries = (await store.listNights()).filter((s) => s && s.id).sort((a, b) => a.start - b.start);
  fillNightSelect();
}

function allSummaries() {
  return [...summaries, ...demo.map((d) => d.summary)].sort((a, b) => a.start - b.start);
}

function fillNightSelect() {
  const sel = $('#nightSelect');
  const opts = [];
  if (monitor.state === 'recording') opts.push(`<option value="__live__">● Nuit en cours</option>`);
  for (const s of [...allSummaries()].reverse()) {
    opts.push(`<option value="${esc(s.id)}">${esc(dateLabel(s.start))} · ${esc(clockAt(s.start, 0))} → ${esc(fmtDur(s.sleepMin))}${s.demo ? ' (démo)' : ''}</option>`);
  }
  sel.innerHTML = opts.join('') || '<option value="">Aucune nuit</option>';
  sel.value = currentId;
}

async function selectNight(id) {
  currentId = id;
  if (id === '__live__') current = null;
  else current = demo.find((d) => d.id === id) || (id ? await store.loadNight(id) : null);
  if (current && !current.summary?.states) current.summary = summarize(current);
  $('#nightSelect').value = id;
  renderTab();
}

function loadDemo() {
  const levels = [0.65, 0.3, 0.5, 0.15, 0.7, 0.45, 0.25];
  demo = levels.map((s, i) => demoNight({ seed: 101 + i * 7, daysAgo: i, snoreLevel: s, startHour: 22.9 + (i % 3) * 0.4, durMin: 430 + (i * 37) % 80 }));
  fillNightSelect();
  selectNight(demo[0].id);
  renderHistory();
}

/* -------------------------------------------------------- Nuit en cours --- */

function bindLive() {
  $('#btnRec').addEventListener('click', async () => {
    if (monitor.state === 'recording') {
      if (!confirm('Terminer l’enregistrement de la nuit ?')) return;
      setRecUi('saving');
      const night = await monitor.stop();
      liveSummary = null;
      await refreshNights();
      if (night) {
        if (!store.available) { demo.push(night); night.summary = summarize(night); }
        await selectNight(night.id);
        showTab('summary');
      }
      setRecUi('idle');
      return;
    }
    if (monitor.state !== 'idle') return;
    setRecUi('loading');
    resetLiveUi();
    await monitor.start();
    setRecUi(monitor.state === 'recording' ? 'recording' : 'idle');
    if (monitor.state === 'recording') { currentId = '__live__'; fillNightSelect(); }
  });

  monitor.on('status', ({ message }) => { $('#btnRecLabel').textContent = message.replace(/…$/, '…'); });
  monitor.on('error', (err) => {
    const e = audio.error;
    alert(e ? `${e.title}\n\n${e.message}\n\n${e.hint}` : `Impossible de démarrer : ${err.message || err}`);
  });
  monitor.on('second', onSecond);
  monitor.on('event', (ev) => onLiveEvent(ev));
  monitor.on('pause', (p) => onLiveEvent({ ...p, cat: 'pause', n: 1 }));
  monitor.on('clip', () => { if (tab === 'events') renderEvents(); });

  $('#btnNightMode').addEventListener('click', () => { $('#nightMode').hidden = false; tickClock(); document.documentElement.requestFullscreen?.().catch(() => {}); });
  $('#nightMode').addEventListener('click', () => { $('#nightMode').hidden = true; if (document.fullscreenElement) document.exitFullscreen(); });
}

function setRecUi(state) {
  const b = $('#btnRec');
  b.classList.toggle('recording', state === 'recording');
  b.classList.toggle('loading', state === 'loading' || state === 'saving');
  $('#btnRecLabel').textContent = { idle: 'Démarrer la nuit', loading: 'Préparation…', recording: 'Terminer la nuit', saving: 'Enregistrement…' }[state];
  $('#recPill').hidden = state !== 'recording';
  if (state === 'recording') $('#liveStart').textContent = clockAt(monitor.night.start, 0);
  fillNightSelect();
}

function resetLiveUi() {
  liveSummary = null;
  $('#liveFeed').innerHTML = '<li class="empty">Rien pour l\'instant.</li>';
  for (const c of $$('.counter b')) c.textContent = '0';
}

function buildCounters() {
  $('#liveCounters').innerHTML = EVENT_CATS.map((c) => `
    <div class="counter" data-cat="${c}" style="--cat:${CATS[c].color}">
      <span class="ci">${icon(CATS[c].icon, CATS[c].color)}</span><b>0</b><span>${esc(LANE_LABEL[c])}</span>
    </div>`).join('');
}

let lastSecond = null;
function onSecond(s) {
  lastSecond = s;
  const lvlPct = Math.max(0, Math.min(1, (s.level + 90) / 70));
  $('#liveMeter').style.transform = `scaleX(${lvlPct.toFixed(3)})`;
  $('#liveFloorMark').style.left = `${Math.max(0, Math.min(1, (s.floor + 90) / 70)) * 100}%`;
  $('#liveLevel').textContent = `${Math.round(s.level)} dB`;
  $('#liveFloor').textContent = `fond ${Math.round(s.floor)} dB`;
  const cat = CODE_TO_CAT[s.dom];
  const label = cat ? (cat === 'breath' ? 'Respiration audible' : LANE_LABEL[cat]) : s.scores ? 'Calme' : '…';
  const now = $('#liveNow');
  if (now.dataset.txt !== label) {
    now.dataset.txt = label;
    now.innerHTML = cat ? icon(CATS[cat].icon, CATS[cat].color) : '';
    now.append(` ${label}`);
  }
}

function onLiveEvent(ev) {
  const counter = $(`.counter[data-cat="${ev.cat}"]`);
  if (counter) {
    const n = monitor.night;
    const v = ev.cat === 'pause' ? n.pauses.length : n.events.filter((e) => e.cat === ev.cat).reduce((a, e) => a + (ev.cat === 'snore' || ev.cat === 'cough' ? e.n : 1), 0);
    counter.querySelector('b').textContent = num(v);
    counter.classList.remove('flash'); void counter.offsetWidth; counter.classList.add('flash');
  }
  const ul = $('#liveFeed');
  ul.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  li.style.setProperty('--cat', CATS[ev.cat].color);
  li.innerHTML = `<span class="ft">${clockAt(monitor.night.start, ev.t0)}</span><span class="fi">${icon(CATS[ev.cat].icon, CATS[ev.cat].color)}</span>
    <span>${esc(LANE_LABEL[ev.cat])}${ev.label ? ` · ${esc(ev.label)}` : ''}</span><span class="fd">${Math.max(1, Math.round((ev.t1 - ev.t0)))} s</span>`;
  ul.prepend(li);
  while (ul.children.length > 80) ul.lastChild.remove();
}

function tickClock() {
  const n = monitor.night;
  const now = new Date();
  $('#nmClock').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (monitor.state === 'recording' && n) {
    const el = hms((Date.now() - n.start) / 1000);
    $('#liveElapsed').textContent = el;
    $('#recPillTime').textContent = el;
    $('#nmSub').textContent = `Enregistrement en cours · ${el}`;
  }
}

function refreshLive() {
  const n = monitor.night;
  if (!n) return;
  liveSummary = summarize(n);
  const st = liveSummary.states;
  $('#liveState').textContent = st.length ? (st[st.length - 1] ? 'Sommeil' : 'Éveil') : '—';
  if (tab === 'live') renderLive();
  else if (currentId === '__live__') renderTab();
}

function renderLive() {
  const n = monitor.night;
  const now = n ? n.lv.length : 0;
  const from = Math.max(0, now - 1800);
  const pts = [];
  if (n) for (let t = from; t < now; t += 5) pts.push([t, Math.max(...n.lv.slice(t, t + 5))]);
  charts.liveLevel ??= new TimeChart($('#liveLevelChart'));
  charts.liveLevel.setData({
    start: (n?.start ?? Date.now()) + from * 1000, end: (n?.start ?? Date.now()) + Math.max(now, from + 60) * 1000,
    yMin: -90, yMax: -20, yFmt: (v) => `${v}`,
    series: [{ name: 'Niveau (dB)', color: '#3987e5', kind: 'area', points: pts.map(([t, v]) => [t - from, v]), fmt: (v) => `${v} dB`, tolerance: 10 }],
  });
  charts.liveLanes ??= new LaneChart($('#liveLanes'));
  if (n) charts.liveLanes.setData(laneData(n, liveSummary || summarize(n)));
}

/* ------------------------------------------------------------- Résumé --- */

function tile(label, value, sub = '') {
  return `<div class="tile"><span>${esc(label)}</span><b>${esc(value)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
}

function others(s) { return allSummaries().filter((x) => x.id !== s.id && x.final !== false && !!x.demo === !!s.demo); }

function avgSub(key, fmt, s) {
  const o = others(s);
  if (o.length < 1) return '';
  const a = averages(o)[key];
  return a == null ? '' : `moy. ${fmt(a)}`;
}

function renderSummary() {
  const n = shownNight(), s = shownSummary();
  if (!s) return;
  $('#sumHero').textContent = fmtDur(s.sleepMin);
  $('#sumHeroSub').textContent = `${dateLabel(s.start)} · ${clockAt(s.start, 0)} → ${clockAt(s.start, s.recMin * 60)} · ${fmtDur(s.recMin)} d'enregistrement${n.demo ? ' · démonstration' : ''}`;
  const m = (k) => METRICS.find((x) => x.key === k);
  $('#sumTiles').innerHTML = [
    tile('Endormissement', s.onsetClock || '—', s.latencyMin != null ? `après ${fmtDur(s.latencyMin)}` : ''),
    tile('Réveil final', s.wakeClock || '—'),
    tile('Efficacité', pct(s.efficiency), avgSub('efficiency', m('efficiency').fmt, s)),
    tile('Réveils nocturnes', String(s.awakenings.length), `${fmtDur(s.wasoMin)} d'éveil`),
    tile('Ronflement', pct(s.snore.pctSleep), `${num(s.snore.count)} ronflements`),
    tile('Pauses suspectes', num(s.pauses.count), `${num(s.pauses.perHour, 1)} / h`),
    tile('Toux', num(s.byCat.cough.occurrences), `${s.byCat.cough.episodes} épisodes`),
    tile('Mouvements', num(s.movement.perHour, 1) + ' / h', `${s.movement.episodes} au total`),
    tile('Paroles / vocal.', `${s.byCat.speech.episodes} / ${s.byCat.vocal.episodes}`),
    tile('Niveau médian', s.ambient.l50 != null ? `${s.ambient.l50} dB` : '—', `${s.byCat.env.episodes} bruits extérieurs`),
  ].join('');

  // Hypnogramme + niveau.
  charts.sumHypno ??= new TimeChart($('#sumHypno'));
  charts.sumHypno.setData({
    start: s.start, end: s.start + n.lv.length * 1000, yMin: -90, yMax: -20, yFmt: (v) => `${v}`,
    bands: runs(s.states).map(([a, b]) => ({ t0: a * 60, t1: b * 60, color: 'rgba(57,135,229,0.16)' })),
    series: [{ name: 'Niveau médian (dB)', color: '#9085e9', kind: 'line', points: n.minutes.map((mm, i) => [i * 60 + 30, mm.lvl]), fmt: (v) => `${v} dB` }],
  });

  // Heure par heure.
  const color = { snoreMin: CATS.snore.color, move: CATS.move.color, cough: CATS.cough.color, pauses: CATS.pause.color, env: CATS.env.color }[hourMetric];
  const unit = { snoreMin: 'min de ronflement', move: 'mouvements', cough: 'toux', pauses: 'pauses', env: 'bruits' }[hourMetric];
  charts.sumHours ??= new BarChart($('#sumHours'));
  charts.sumHours.setData({
    color, name: unit, fmt: (v) => num(v, hourMetric === 'snoreMin' && v % 1 ? 1 : 0), valueLabels: true,
    bars: s.hours.map((h) => ({ label: h.label, value: h[hourMetric], tipTitle: `${h.label.replace('h', ' h')} – ${String((parseInt(h.label, 10) + 1) % 24).padStart(2, '0')} h` })),
  });

  $('#sumInterp').innerHTML = interpret(s, others(s)).map((it) => `
    <div class="interp-item"><span class="ii">${icon(it.icon, interpColor(it.icon))}</span><div><h4>${esc(it.title)}</h4><p>${esc(it.text)}</p></div></div>`).join('');
}

/** Plages continues de 1 dans un tableau d'états → [[début, fin], …] en minutes. */
function runs(st) {
  const out = [];
  let a = -1;
  st.forEach((v, i) => { if (v && a < 0) a = i; if (!v && a >= 0) { out.push([a, i]); a = -1; } });
  if (a >= 0) out.push([a, st.length]);
  return out;
}

/* --------------------------------------------------------- Chronologie --- */

function laneData(n, s) {
  return {
    start: n.start, end: n.start + Math.max(60, n.lv.length) * 1000,
    states: s.states, level: n.lv,
    lanes: EVENT_CATS.map((c) => ({ key: c, label: LANE_LABEL[c], color: CATS[c].color, items: c === 'pause' ? n.pauses : n.events.filter((e) => e.cat === c) })),
    describe: (it, lane) => [
      { value: `${Math.max(1, Math.round(it.t1 - it.t0))} s`, label: 'durée', color: lane.color },
      ...(it.n > 1 ? [{ value: num(it.n), label: 'occurrences', color: lane.color }] : []),
      ...(it.db != null ? [{ value: `${it.db} dB`, label: 'niveau max', color: lane.color }] : []),
      ...(it.label ? [{ value: it.label, label: '', color: lane.color }] : []),
      ...(it.resume ? [{ value: it.resume, label: 'reprise', color: lane.color }] : []),
      { value: it.clip ? 'cliquer pour écouter' : 'pas d’extrait', label: '', color: 'transparent' },
    ],
    onPick: (it) => pickEvent(n, it),
  };
}

function renderTimeline() {
  const n = shownNight(), s = shownSummary();
  charts.tl ??= new LaneChart($('#tlChart'));
  charts.tl.setData(laneData(n, s));
}

function pickEvent(n, it) {
  const cat = it.cat || 'pause';
  const c = CATS[cat];
  const box = $('#tlDetail');
  box.innerHTML = `<span class="se-cat">${icon(c.icon, c.color)}</span>
    <div><b>${esc(LANE_LABEL[cat])}${it.label ? ` · ${esc(it.label)}` : ''}</b>
    <div class="se-meta">${clockAt(n.start, it.t0)} · ${Math.max(1, Math.round(it.t1 - it.t0))} s${it.n > 1 ? ` · ${it.n} occurrences` : ''}${it.db != null ? ` · ${it.db} dB` : ''}${it.resume ? ` · reprise : ${esc(it.resume)}` : ''}</div></div>
    ${it.clip ? '' : '<span class="muted">Pas d’extrait audio pour cet événement.</span>'}`;
  if (it.clip) playClip(it.clip, `${LANE_LABEL[cat]}${it.label ? ` · ${it.label}` : ''}`, clockAt(n.start, it.t0), c.color);
}

/* ------------------------------------------------- Ronflements & respiration --- */

function renderBreath() {
  const n = shownNight(), s = shownSummary();
  $('#brTiles').innerHTML = [
    tile('Temps de ronflement', pct(s.snore.pctSleep), fmtDur(s.snore.seconds / 60) + ' cumulées'),
    tile('Ronflements', num(s.snore.count), `${s.snore.episodes} épisodes`),
    tile('Intensité moyenne', s.snore.meanDb != null ? `${s.snore.meanDb} dB` : '—', s.snore.maxDb != null ? `max ${s.snore.maxDb} dB` : ''),
    tile('Pauses suspectes', num(s.pauses.count), `${num(s.pauses.perHour, 1)} par heure de sommeil`),
    tile('Pause la plus longue', s.pauses.count ? `${s.pauses.maxDur} s` : '—', s.pauses.count ? `moyenne ${Math.round(s.pauses.meanDur)} s` : ''),
    tile('Rythme respiratoire', s.breathing.rate ? `${num(s.breathing.rate, 1)} /min` : '—', s.breathing.rate ? `mesuré sur ${pct(s.breathing.coverage)} du sommeil` : 'respiration peu audible'),
    tile('Régularité', s.breathing.regularity != null ? num(s.breathing.regularity, 2) : '—', s.breathing.irregularPct != null ? `${pct(s.breathing.irregularPct)} de minutes irrégulières` : ''),
  ].join('');
  const end = n.start + n.lv.length * 1000;
  const bands = runs(s.states).map(([a, b]) => ({ t0: a * 60, t1: b * 60, color: 'rgba(228,228,231,0.04)' }));
  charts.brSnore ??= new TimeChart($('#brSnore'));
  charts.brSnore.setData({ start: n.start, end, yMin: 0, yMax: 60, yFmt: (v) => `${v}`, bands,
    series: [{ name: 's de ronflement / min', color: CATS.snore.color, kind: 'area', points: n.minutes.map((m, i) => [i * 60 + 30, m.snore]), fmt: (v) => `${v} s` }] });
  const sn = n.events.filter((e) => e.cat === 'snore');
  charts.brSnoreDb ??= new TimeChart($('#brSnoreDb'));
  charts.brSnoreDb.setData({ start: n.start, end, yMin: -80, yMax: -20, yFmt: (v) => `${v}`, bands,
    series: [{ name: 'Niveau max de l’épisode', color: CATS.snore.color, kind: 'dots', dots: true, points: sn.map((e) => [(e.t0 + e.t1) / 2, e.db]), fmt: (v) => `${v} dB`, tolerance: 300 }] });
  const rates = n.minutes.map((m, i) => [i * 60 + 30, m.rate]);
  const rv = rates.map((r) => r[1]).filter((v) => v != null);
  charts.brRate ??= new TimeChart($('#brRate'));
  charts.brRate.setData({ start: n.start, end, yMin: rv.length ? Math.max(0, Math.floor(Math.min(...rv) - 2)) : 0, yMax: rv.length ? Math.ceil(Math.max(...rv) + 2) : 30, yFmt: (v) => `${v}`, bands,
    series: [{ name: 'respirations / min', color: '#199e70', kind: 'line', points: rates, fmt: (v) => num(v, 1) }] });
  charts.brReg ??= new TimeChart($('#brReg'));
  charts.brReg.setData({ start: n.start, end, yMin: 0, yMax: 1, yTicks: [0, 0.25, 0.5, 0.75, 1], yFmt: (v) => num(v, 2), bands,
    series: [{ name: 'régularité', color: '#9085e9', kind: 'line', points: n.minutes.map((m, i) => [i * 60 + 30, m.reg]), fmt: (v) => num(v, 2) }] });

  const t = $('#brPauses');
  t.innerHTML = `<thead><tr><th>Heure</th><th class="num">Durée</th><th>Reprise</th><th class="num">Niveau à la reprise</th><th>Extrait</th></tr></thead><tbody>${
    n.pauses.length ? n.pauses.map((p, i) => `<tr><td>${clockAt(n.start, p.t0)}</td><td class="num">${p.dur} s</td><td>${esc(p.resume)}</td><td class="num">${p.db ?? '—'} dB</td>
      <td>${p.clip ? `<button class="play" data-pause="${i}">${playIco} Écouter</button>` : '<span class="muted">—</span>'}</td></tr>`).join('')
      : '<tr><td colspan="5" class="muted">Aucune pause respiratoire suspecte.</td></tr>'}</tbody>`;
  t.onclick = (e) => {
    const b = e.target.closest('[data-pause]');
    if (!b) return;
    const p = n.pauses[Number(b.dataset.pause)];
    playClip(p.clip, `Pause de ${p.dur} s`, clockAt(n.start, p.t0), CATS.pause.color);
  };
}

/* ------------------------------------------------------------- Événements --- */

function renderEvents() {
  const n = shownNight();
  const all = [...n.events, ...n.pauses.map((p) => ({ ...p, cat: 'pause', n: 1 }))].sort((a, b) => a.t0 - b.t0);
  const counts = Object.fromEntries(EVENT_CATS.map((c) => [c, all.filter((e) => e.cat === c).length]));
  $('#evFilters').innerHTML = `<button data-f="all" class="${evFilter === 'all' ? 'on' : ''}">Tous <small>${all.length}</small></button>`
    + EVENT_CATS.filter((c) => counts[c]).map((c) => `<button data-f="${c}" class="${evFilter === c ? 'on' : ''}" style="--cat:${CATS[c].color}"><i></i>${esc(LANE_LABEL[c])} <small>${counts[c]}</small></button>`).join('');
  $('#evFilters').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { evFilter = b.dataset.f; renderEvents(); } };
  const rows = all.filter((e) => evFilter === 'all' || e.cat === evFilter);
  const t = $('#evTable');
  t.innerHTML = `<thead><tr><th>Heure</th><th>Type</th><th>Détail</th><th class="num">Durée</th><th class="num">Occurrences</th><th class="num">Niveau max</th><th class="num">Confiance</th><th>Extrait</th></tr></thead><tbody>${
    rows.map((e, i) => `<tr><td>${clockAt(n.start, e.t0)}</td>
      <td><span class="cat" style="--cat:${CATS[e.cat].color}"><i></i>${esc(LANE_LABEL[e.cat])}</span></td>
      <td>${esc(e.label || e.resume || '')}</td>
      <td class="num">${Math.max(1, Math.round(e.t1 - e.t0))} s</td><td class="num">${e.n ?? 1}</td>
      <td class="num">${e.db != null ? `${e.db} dB` : '—'}</td><td class="num">${e.peak ? pct(e.peak) : '—'}</td>
      <td>${e.clip ? `<button class="play" data-i="${i}">${playIco} Écouter</button>` : '<span class="muted">—</span>'}</td></tr>`).join('')
    || '<tr><td colspan="8" class="muted">Aucun événement.</td></tr>'}</tbody>`;
  t.onclick = (ev) => {
    const b = ev.target.closest('[data-i]');
    if (!b) return;
    const e = rows[Number(b.dataset.i)];
    playClip(e.clip, `${LANE_LABEL[e.cat]}${e.label ? ` · ${e.label}` : ''}`, clockAt(n.start, e.t0), CATS[e.cat].color);
  };
}

/* ---------------------------------------------------------- Environnement --- */

function renderEnv() {
  const n = shownNight(), s = shownSummary();
  $('#envTiles').innerHTML = [
    tile('Bruit de fond (L90)', s.ambient.l90 != null ? `${s.ambient.l90} dB` : '—', 'niveau dépassé 90 % du temps'),
    tile('Niveau médian (L50)', s.ambient.l50 != null ? `${s.ambient.l50} dB` : '—'),
    tile('Pics fréquents (L10)', s.ambient.l10 != null ? `${s.ambient.l10} dB` : '—', 'dépassé 10 % du temps'),
    tile('Maximum', s.ambient.max != null ? `${s.ambient.max} dB` : '—'),
    tile('Bruits environnants', num(s.byCat.env.episodes), fmtDur(s.byCat.env.seconds / 60) + ' cumulées'),
    tile('Suivis d’un réveil', num(s.disturbing.length), s.disturbing.length ? s.disturbing.slice(0, 2).map((d) => `${d.label} ${clockAt(s.start, d.t0)}`).join(', ') : 'aucun'),
  ].join('');
  charts.envLevel ??= new TimeChart($('#envLevel'));
  const leg = $('#envLevel').previousElementSibling;
  leg.innerHTML = `Niveau sonore ambiant par minute <span class="legend"><i style="background:#3987e5"></i>médian <i style="background:#d95926"></i>maximum</span>`;
  charts.envLevel.setData({
    start: n.start, end: n.start + n.lv.length * 1000, yMin: -90, yMax: -10, yFmt: (v) => `${v}`,
    series: [
      { name: 'médian', color: '#3987e5', kind: 'line', points: n.minutes.map((m, i) => [i * 60 + 30, m.lvl]), fmt: (v) => `${v} dB` },
      { name: 'maximum', color: '#d95926', kind: 'line', points: n.minutes.map((m, i) => [i * 60 + 30, m.max]), fmt: (v) => `${v} dB` },
    ],
  });
  charts.envTypes ??= new BarChart($('#envTypes'));
  const types = s.envTypes.slice(0, 10);
  charts.envTypes.setData({
    color: '#8a8c93', name: 'occurrences', valueLabels: true, fmt: (v) => num(v),
    bars: types.length ? types.map((e) => ({ label: e.label.length > 10 ? `${e.label.slice(0, 9)}…` : e.label, value: e.count, tipTitle: e.label,
      tip: [{ value: num(e.count), label: 'occurrences', color: '#8a8c93' }, { value: `${e.seconds} s`, label: 'durée cumulée', color: '#8a8c93' }, { value: `${e.maxDb} dB`, label: 'niveau max', color: '#8a8c93' }] }))
      : [{ label: 'aucun', value: 0 }],
  });
  const loud = n.events.filter((e) => e.cat === 'env').sort((a, b) => b.db - a.db).slice(0, 15);
  const t = $('#envLoud');
  t.innerHTML = `<thead><tr><th>Heure</th><th>Type</th><th class="num">Niveau</th><th>Extrait</th></tr></thead><tbody>${
    loud.map((e, i) => `<tr><td>${clockAt(n.start, e.t0)}</td><td><span class="cat" style="--cat:${CATS[e.cat].color}"><i></i>${esc(e.label || LANE_LABEL[e.cat])}</span></td>
      <td class="num">${e.db} dB</td><td>${e.clip ? `<button class="play" data-i="${i}">${playIco}</button>` : '<span class="muted">—</span>'}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">Aucun bruit environnant.</td></tr>'}</tbody>`;
  t.onclick = (ev) => {
    const b = ev.target.closest('[data-i]');
    if (!b) return;
    const e = loud[Number(b.dataset.i)];
    playClip(e.clip, e.label || LANE_LABEL[e.cat], clockAt(n.start, e.t0), CATS[e.cat].color);
  };
}

/* ------------------------------------------------------------- Historique --- */

function renderHistory() {
  const list = allSummaries();
  const t = $('#histTable');
  t.innerHTML = `<thead><tr><th>Nuit</th><th class="num">Enregistré</th><th class="num">Sommeil</th><th class="num">Efficacité</th><th>Endorm.</th><th>Réveil</th>
    <th class="num">Ronflement</th><th class="num">Pauses / h</th><th class="num">Toux</th><th class="num">Mouv. / h</th><th class="num">Bruits</th><th></th></tr></thead><tbody>${
    [...list].reverse().map((s) => `<tr class="${s.id === currentId ? 'sel' : ''}">
      <td><span class="linkish" data-open="${esc(s.id)}">${esc(dateLabel(s.start))} · ${clockAt(s.start, 0)}</span>${s.demo ? '<span class="demo-tag">démo</span>' : ''}</td>
      <td class="num">${fmtDur(s.recMin)}</td><td class="num">${fmtDur(s.sleepMin)}</td><td class="num">${pct(s.efficiency)}</td>
      <td>${s.onsetClock || '—'}</td><td>${s.wakeClock || '—'}</td>
      <td class="num">${pct(s.snore.pctSleep)}</td><td class="num">${num(s.pauses.perHour, 1)}</td><td class="num">${num(s.byCat.cough.occurrences)}</td>
      <td class="num">${num(s.movement.perHour, 1)}</td><td class="num">${num(s.byCat.env.episodes)}</td>
      <td>${s.demo ? '' : `<button class="play" data-del="${esc(s.id)}" title="Déplacer dans la corbeille (sommeil/_corbeille)">${icon('trash', '#e66767', { tile: false })}</button>`}</td></tr>`).join('')
    || '<tr><td colspan="12" class="muted">Aucune nuit enregistrée pour l’instant. Lancez « Démarrer la nuit » ce soir, ou chargez les nuits de démonstration.</td></tr>'}</tbody>`;
  t.onclick = async (e) => {
    const o = e.target.closest('[data-open]');
    if (o) { await selectNight(o.dataset.open); showTab('summary'); return; }
    const d = e.target.closest('[data-del]');
    if (d && confirm('Déplacer cette nuit dans la corbeille (Bureau/Visual Singer/sommeil/_corbeille) ?')) {
      await store.deleteNight(d.dataset.del);
      if (currentId === d.dataset.del) { current = null; currentId = ''; }
      await refreshNights();
      renderHistory();
    }
  };
  const opts = [...list].reverse().map((s) => `<option value="${esc(s.id)}">${esc(dateLabel(s.start))}${s.demo ? ' (démo)' : ''}</option>`).join('');
  for (const [sel, idx] of [['#cmpA', 0], ['#cmpB', 1]]) {
    const el = $(sel), prev = el.value;
    el.innerHTML = opts;
    el.value = prev && list.some((s) => s.id === prev) ? prev : [...list].reverse()[idx]?.id || '';
  }
  renderTrend();
  renderCompare();
}

function renderTrend() {
  const list = allSummaries();
  const m = METRICS.find((x) => x.key === $('#trendMetric').value) || METRICS[0];
  charts.trend ??= new BarChart($('#trendChart'));
  // Valeurs dans une unité lisible sur l'axe : heures pour les durées, points de % pour les ratios.
  const conv = m.fmt === fmtDur ? (v) => v / 60 : m.unit === '%' ? (v) => v * 100 : (v) => v;
  const axisFmt = m.fmt === fmtDur ? (v) => `${num(v, 1)} h` : m.unit === '%' ? (v) => `${num(v)} %` : (v) => num(v, v % 1 ? 1 : 0);
  charts.trend.setData({
    color: '#3987e5', name: m.label, valueLabels: list.length <= 14, fmt: axisFmt,
    bars: list.map((s) => ({ label: new Date(s.start).toLocaleDateString('fr-FR', { day: 'numeric', month: 'numeric' }), value: conv(m.get(s) ?? 0), tipTitle: dateLabel(s.start),
      tip: [{ value: m.get(s) == null ? '—' : m.fmt(m.get(s)), label: m.label, color: '#3987e5' }] })),
  });
}

function renderCompare() {
  const list = allSummaries();
  const a = list.find((s) => s.id === $('#cmpA').value), b = list.find((s) => s.id === $('#cmpB').value);
  const t = $('#cmpTable');
  if (!a || !b) { t.innerHTML = '<tbody><tr><td class="muted">Il faut au moins deux nuits.</td></tr></tbody>'; return; }
  t.innerHTML = `<thead><tr><th>Indicateur</th><th class="num">${esc(dateLabel(a.start))}</th><th class="num">${esc(dateLabel(b.start))}</th><th class="num">Écart</th></tr></thead><tbody>${
    METRICS.map((m) => {
      const va = m.get(a), vb = m.get(b);
      let diff = '—', cls = '';
      if (va != null && vb != null) {
        const d = va - vb;
        diff = d === 0 ? '=' : `${d > 0 ? '+' : '−'}${m.fmt(Math.abs(d))}`;
        if (m.better && d !== 0) cls = (d > 0) === (m.better > 0) ? 'better' : 'worse';
      }
      return `<tr><td>${esc(m.label)}</td><td class="num">${va == null ? '—' : esc(m.fmt(va))}</td><td class="num">${vb == null ? '—' : esc(m.fmt(vb))}</td><td class="num ${cls}">${esc(diff)}</td></tr>`;
    }).join('')}</tbody>`;
}

/* ---------------------------------------------------------------- Lecteur --- */

function bindPlayer() {
  $('#plClose').addEventListener('click', () => { $('#plAudio').pause(); $('#player').hidden = true; });
}

function playClip(file, title, sub, color) {
  if (!file) return;
  const a = $('#plAudio');
  a.src = store.clipUrl(file);
  $('#plTitle').textContent = title;
  $('#plSub').textContent = sub;
  $('#plDot').style.background = color;
  $('#player').hidden = false;
  a.play().catch(() => {});
}

boot();
window.visualSingerSleep = { monitor, store, audio, demoNight, summarize };
