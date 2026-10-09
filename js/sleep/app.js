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
import { TimeChart, BarChart, LaneChart, ringGauge, hbarList, calendarHeat, qualityLegend } from './charts.js';
import { qColor, qLabel, lin, METRIC_Q, SERIES_Q } from './quality.js';
import { demoNight } from './demo.js';
import { icon, hydrateIcons } from '../icons.js';
import { initShell, bindTabs as shellTabs, hashParams, setHashParam, toast, confirmDialog } from '../shell.js';

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
const TAB_LABEL = { live: 'Nuit en cours', summary: 'Résumé', timeline: 'Chronologie', breath: 'Ronflements et respiration', events: 'Événements', env: 'Environnement', history: 'Historique' };
let tabs = null;
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
  for (const el of $$('[data-qlegend]')) qualityLegend(el);
  await store.init();
  $('#storeWarn').hidden = store.available;
  $('#dataDir').textContent = store.available ? `Dossier : ${store.dataDir}\\sommeil` : 'Sauvegarde Bureau indisponible (lancez start-sommeil.bat)';
  $('#clipBudget').value = String(cfg.clipsPerCategory);
  $('#clipBudget').addEventListener('change', (e) => { cfg.clipsPerCategory = Number(e.target.value); storage.set(SLEEP_CFG_KEY, cfg); });

  initShell({
    beforeQuit: async () => {
      if (monitor.state === 'recording') { await monitor.stop(); }
    },
    shortcuts: [['← / → (onglets)', 'Section précédente / suivante'], ['Retour du navigateur', 'Section ou nuit précédente']],
  });
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
  $('#nightSelect').addEventListener('change', (e) => { selectNight(e.target.value); setHashParam('nuit', e.target.value); });
  window.addEventListener('hashchange', () => {
    const id = hashParams().get('nuit');
    if (id && id !== currentId && [...$('#nightSelect').options].some((o) => o.value === id)) selectNight(id);
  });
  $('#tlReset').addEventListener('click', () => charts.tl?.resetZoom());
  for (const s of ['#cmpA', '#cmpB']) $(s).addEventListener('change', renderCompare);
  $('#trendMetric').innerHTML = METRICS.map((m) => `<option value="${m.key}">${esc(m.label)}</option>`).join('');
  $('#trendMetric').addEventListener('change', renderTrend);

  await refreshNights();
  const want = hashParams().get('nuit');
  if (want && summaries.some((x) => x.id === want)) await selectNight(want);
  else if (summaries.length) await selectNight(summaries[summaries.length - 1].id);
  tabs.select(hashParams().get('onglet') || 'live', { push: false });
  renderAll();
  setInterval(tickClock, 1000);
  setInterval(() => { if (monitor.state === 'recording') refreshLive(); }, 10000);
}

/* ---------------------------------------------------------------- Onglets --- */

function bindTabs() {
  tabs = shellTabs($('.s-tabs'), (name) => {
    tab = name;
    for (const p of $$('.pane')) p.classList.toggle('on', p.dataset.pane === name);
    renderTab();
  }, { param: 'onglet' });
}

/** Change d'onglet (entrée dans l'historique du navigateur : le bouton Retour revient en arrière). */
function showTab(name) { tabs.select(name); }

/** Fil d'Ariane : Sommeil › Nuit › Onglet. */
function renderCrumbs() {
  const night = shownNight();
  const analysis = tab !== 'live' && tab !== 'history';
  const items = ['<li><a href="index.html">Accueil</a></li>', '<li><button type="button" data-crumb="live">Sommeil</button></li>'];
  if (analysis && night) items.push(`<li><button type="button" data-crumb="history">${esc(night === monitor.night ? 'Nuit en cours' : `Nuit du ${dateLabel(night.start)}`)}</button></li>`);
  items.push(`<li><span aria-current="page">${esc(TAB_LABEL[tab] || '')}</span></li>`);
  const ol = $('#crumbs');
  ol.innerHTML = items.join('');
  ol.onclick = (e) => { const b = e.target.closest('[data-crumb]'); if (b) showTab(b.dataset.crumb); };
}

function renderAll() { renderTab(); renderHistory(); }

function renderTab() {
  const night = shownNight();
  renderCrumbs();
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
      const ok = await confirmDialog({ title: 'Terminer l’enregistrement de la nuit ?', message: `Durée enregistrée : ${$('#liveElapsed').textContent}. La nuit sera analysée puis enregistrée sur le Bureau ; l’enregistrement ne peut pas être prolongé ensuite.`, confirmLabel: 'Terminer et analyser' });
      if (!ok.ok) return;
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
    confirmDialog({ title: e ? e.title : 'Impossible de démarrer l’enregistrement', message: e ? `${e.message} ${e.hint || ''}` : String(err.message || err), confirmLabel: 'Compris', cancelLabel: 'Fermer' });
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
    series: [{ name: 'Niveau (dB)', kind: 'area', quality: SERIES_Q.level, points: pts.map(([t, v]) => [t - from, v]), fmt: (v) => `${v} dB`, tolerance: 10 }],
  });
  charts.liveLanes ??= new LaneChart($('#liveLanes'));
  if (n) charts.liveLanes.setData(laneData(n, liveSummary || summarize(n)));
}

/* ------------------------------------------------------------- Résumé --- */

function tile(label, value, sub = '', q = null) {
  const status = q != null ? `<small class="qs"><i style="background:${qColor(q)};box-shadow:0 0 8px ${qColor(q, 0.6)}"></i>${qLabel(q)}</small>` : '';
  return `<div class="tile${q != null ? ' has-q' : ''}" ${q != null ? `style="--qc:${qColor(q, 0.55)}"` : ''}><span>${esc(label)}</span><b>${esc(value)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}${status}</div>`;
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
    tile('Endormissement', s.onsetClock || '—', s.latencyMin != null ? `après ${fmtDur(s.latencyMin)}` : '', METRIC_Q.latency(s.latencyMin)),
    tile('Réveil final', s.wakeClock || '—'),
    tile('Efficacité', pct(s.efficiency), avgSub('efficiency', m('efficiency').fmt, s), METRIC_Q.efficiency(s.efficiency)),
    tile('Réveils nocturnes', String(s.awakenings.length), `${fmtDur(s.wasoMin)} d'éveil`, METRIC_Q.awak(s.awakenings.length)),
    tile('Ronflement', pct(s.snore.pctSleep), `${num(s.snore.count)} ronflements`, METRIC_Q.snorePct(s.snore.pctSleep)),
    tile('Pauses suspectes', num(s.pauses.count), `${num(s.pauses.perHour, 1)} / h`, METRIC_Q.pauses(s.pauses.perHour)),
    tile('Toux', num(s.byCat.cough.occurrences), `${s.byCat.cough.episodes} épisodes`, METRIC_Q.cough(s.byCat.cough.occurrences)),
    tile('Mouvements', num(s.movement.perHour, 1) + ' / h', `${s.movement.episodes} au total`, METRIC_Q.move(s.movement.perHour)),
    tile('Paroles / vocal.', `${s.byCat.speech.episodes} / ${s.byCat.vocal.episodes}`, '', METRIC_Q.speech(s.byCat.speech.episodes + s.byCat.vocal.episodes)),
    tile('Niveau médian', s.ambient.l50 != null ? `${s.ambient.l50} dB` : '—', `${s.byCat.env.episodes} bruits extérieurs`, METRIC_Q.l50(s.ambient.l50)),
  ].join('');

  renderRings(s);

  // Hypnogramme : vert = sommeil, rouge = éveil.
  charts.sumHypno ??= new TimeChart($('#sumHypno'));
  const marks = [];
  if (s.onset >= 0) marks.push({ t: s.onset * 60, v: 1, text: `endormi ${s.onsetClock}` });
  if (s.onset >= 0 && s.wake < s.states.length) marks.push({ t: s.wake * 60, v: 1, text: `réveil ${s.wakeClock}` });
  charts.sumHypno.setData({
    start: s.start, end: s.start + n.lv.length * 1000, yMin: -0.08, yMax: 1.3, yTicks: [0, 1], yFmt: (v) => (v >= 0.5 ? 'Sommeil' : 'Éveil'),
    marks,
    series: [{ name: 'État estimé', kind: 'step', quality: SERIES_Q.sleepState, points: [...s.states.map((v, i) => [i * 60, v]), [s.states.length * 60, s.states[s.states.length - 1] ?? 0]], tolerance: 60 }],
  });

  // Heure par heure.
  const unit = { snoreMin: 'min de ronflement', move: 'mouvements', cough: 'toux', pauses: 'pauses', env: 'bruits' }[hourMetric];
  charts.sumHours ??= new BarChart($('#sumHours'));
  charts.sumHours.setData({
    quality: SERIES_Q.hour[hourMetric], name: unit, fmt: (v) => num(v, hourMetric === 'snoreMin' && v % 1 ? 1 : 0),
    bars: s.hours.map((h) => ({ label: h.label, value: h[hourMetric], tipTitle: `${h.label.replace('h', ' h')} – ${String((parseInt(h.label, 10) + 1) % 24).padStart(2, '0')} h` })),
  });

  $('#sumInterp').innerHTML = interpret(s, others(s)).map((it) => `
    <div class="interp-item"><span class="ii">${icon(it.icon, interpColor(it.icon))}</span><div><h4>${esc(it.title)}</h4><p>${esc(it.text)}</p></div></div>`).join('');
}

/**
 * Moyenne glissante (±half minutes) sur les valeurs disponibles : relie les
 * petits trous des minutes où la respiration n'est pas audible.
 */
function rolling(values, half = 3) {
  return values.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = i - half; k <= i + half; k++) if (values[k] != null) { sum += values[k]; n++; }
    return n >= 2 ? sum / n : null;
  });
}

/** Jauges circulaires des indicateurs clés. */
function renderRings(s) {
  const box = $('#sumRings');
  const defs = [
    { value: Math.min(1, s.sleepMin / 480), q: METRIC_Q.sleepMin(s.sleepMin), center: fmtDur(s.sleepMin), label: 'sommeil', sub: 'objectif 8 h' },
    { value: s.efficiency, q: METRIC_Q.efficiency(s.efficiency), center: pct(s.efficiency), label: 'efficacité', sub: `${fmtDur(s.wasoMin)} d'éveil` },
    { value: s.snore.pctSleep, q: METRIC_Q.snorePct(s.snore.pctSleep), center: pct(s.snore.pctSleep), label: 'ronflement', sub: `${num(s.snore.count)} ronflements` },
    { value: Math.min(1, s.pauses.perHour / 15), q: METRIC_Q.pauses(s.pauses.perHour), center: num(s.pauses.perHour, 1), label: 'pauses / h', sub: `max ${s.pauses.maxDur || 0} s` },
    { value: s.breathing.regularity ?? 0, q: s.breathing.regularity != null ? METRIC_Q.reg(s.breathing.regularity) : null, center: s.breathing.regularity != null ? num(s.breathing.regularity, 2) : '—', label: 'régularité resp.', sub: s.breathing.rate ? `${num(s.breathing.rate, 1)} resp./min` : 'peu audible' },
    { value: Math.min(1, s.movement.perHour / 25), q: METRIC_Q.move(s.movement.perHour), center: num(s.movement.perHour, 1), label: 'mouvements / h', sub: `${s.movement.restlessMin} min agitées` },
  ];
  if (box.children.length !== defs.length) box.innerHTML = defs.map(() => '<div class="ring-card"></div>').join('');
  defs.forEach((d, i) => ringGauge(box.children[i], d));
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
    tile('Temps de ronflement', pct(s.snore.pctSleep), fmtDur(s.snore.seconds / 60) + ' cumulées', METRIC_Q.snorePct(s.snore.pctSleep)),
    tile('Ronflements', num(s.snore.count), `${s.snore.episodes} épisodes`, METRIC_Q.snoreCount(s.snore.count)),
    tile('Intensité moyenne', s.snore.meanDb != null ? `${s.snore.meanDb} dB` : '—', s.snore.maxDb != null ? `max ${s.snore.maxDb} dB` : ''),
    tile('Pauses suspectes', num(s.pauses.count), `${num(s.pauses.perHour, 1)} par heure de sommeil`, METRIC_Q.pauses(s.pauses.perHour)),
    tile('Pause la plus longue', s.pauses.count ? `${s.pauses.maxDur} s` : '—', s.pauses.count ? `moyenne ${Math.round(s.pauses.meanDur)} s` : ''),
    tile('Rythme respiratoire', s.breathing.rate ? `${num(s.breathing.rate, 1)} /min` : '—', s.breathing.rate ? `mesuré sur ${pct(s.breathing.coverage)} du sommeil` : 'respiration peu audible', s.breathing.rate ? METRIC_Q.rate(s.breathing.rate) : null),
    tile('Régularité', s.breathing.regularity != null ? num(s.breathing.regularity, 2) : '—', s.breathing.irregularPct != null ? `${pct(s.breathing.irregularPct)} de minutes irrégulières` : '', s.breathing.regularity != null ? METRIC_Q.reg(s.breathing.regularity) : null),
  ].join('');
  const end = n.start + n.lv.length * 1000;
  charts.brSnore ??= new TimeChart($('#brSnore'));
  charts.brSnore.setData({ start: n.start, end, yMin: 0, yMax: 60, yFmt: (v) => `${v}`,
    series: [{ name: 's de ronflement / min', kind: 'bars', quality: SERIES_Q.snoreSecPerMin, points: n.minutes.map((m, i) => [i * 60 + 30, m.snore || null]), fmt: (v) => `${v} s`, tolerance: 60 }] });
  const sn = n.events.filter((e) => e.cat === 'snore');
  charts.brSnoreDb ??= new TimeChart($('#brSnoreDb'));
  const loudSn = sn.length ? sn.reduce((a, e) => (e.db > a.db ? e : a)) : null;
  charts.brSnoreDb.setData({ start: n.start, end, yMin: -80, yMax: -20, yFmt: (v) => `${v}`,
    marks: loudSn ? [{ t: (loudSn.t0 + loudSn.t1) / 2, v: loudSn.db, text: `max ${loudSn.db} dB` }] : [],
    series: [{ name: 'Niveau max de l’épisode', kind: 'dots', quality: SERIES_Q.snoreDb, points: sn.map((e) => [(e.t0 + e.t1) / 2, e.db]), fmt: (v) => `${v} dB`, tolerance: 300 }] });
  const rates = rolling(n.minutes.map((m) => m.rate)).map((v, i) => [i * 60 + 30, v == null ? null : +v.toFixed(1)]);
  const rv = rates.map((r) => r[1]).filter((v) => v != null);
  charts.brRate ??= new TimeChart($('#brRate'));
  const rMax = rates.filter((r) => r[1] != null).reduce((a, r) => (!a || r[1] > a[1] ? r : a), null);
  const rMin = rates.filter((r) => r[1] != null).reduce((a, r) => (!a || r[1] < a[1] ? r : a), null);
  charts.brRate.setData({ start: n.start, end, yMin: rv.length ? Math.max(0, Math.floor(Math.min(...rv) - 2)) : 0, yMax: rv.length ? Math.ceil(Math.max(...rv) + 3) : 30, yFmt: (v) => `${v}`,
    marks: rMax ? [{ t: rMax[0], v: rMax[1], text: `max ${num(rMax[1], 1)}` }, { t: rMin[0], v: rMin[1], text: `min ${num(rMin[1], 1)}` }] : [],
    series: [{ name: 'respirations / min', kind: 'area', quality: SERIES_Q.rate, points: rates, fmt: (v) => num(v, 1) }] });
  charts.brReg ??= new TimeChart($('#brReg'));
  charts.brReg.setData({ start: n.start, end, yMin: 0, yMax: 1.1, yTicks: [0, 0.25, 0.5, 0.75, 1], yFmt: (v) => num(v, 2),
    series: [{ name: 'régularité', kind: 'area', quality: SERIES_Q.reg, points: rolling(n.minutes.map((m) => m.reg)).map((v, i) => [i * 60 + 30, v]), fmt: (v) => num(v, 2) }] });

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
  $('#evFilters').innerHTML = `<button data-f="all" aria-pressed="${evFilter === 'all'}" class="${evFilter === 'all' ? 'on' : ''}">Tous <small>${all.length}</small></button>`
    + EVENT_CATS.filter((c) => counts[c]).map((c) => `<button data-f="${c}" aria-pressed="${evFilter === c}" class="${evFilter === c ? 'on' : ''}" style="--cat:${CATS[c].color}"><i></i>${esc(LANE_LABEL[c])} <small>${counts[c]}</small></button>`).join('');
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
  $('#btnEvCsv').onclick = () => downloadCsv(`sommeil_evenements_${new Date(n.start).toISOString().slice(0, 10)}${evFilter === 'all' ? '' : `_${evFilter}`}.csv`,
    ['heure', 'type', 'detail', 'duree_s', 'occurrences', 'niveau_max_db', 'confiance'],
    rows.map((e) => [clockAt(n.start, e.t0), LANE_LABEL[e.cat], e.label || e.resume || '', Math.max(1, Math.round(e.t1 - e.t0)), e.n ?? 1, e.db ?? '', e.peak != null ? e.peak.toFixed(2) : '']));
  t.onclick = (ev) => {
    const b = ev.target.closest('[data-i]');
    if (!b) return;
    const e = rows[Number(b.dataset.i)];
    playClip(e.clip, `${LANE_LABEL[e.cat]}${e.label ? ` · ${e.label}` : ''}`, clockAt(n.start, e.t0), CATS[e.cat].color);
  };
}

/** Téléchargement CSV (séparateur « ; », BOM UTF-8 pour Excel). */
function downloadCsv(name, head, rows) {
  const cell = (v) => { const x = String(v ?? ''); return /[;"\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const text = '\ufeff' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`${rows.length} ligne(s) exportée(s) : ${name}`, { type: 'ok' });
}

/* ---------------------------------------------------------- Environnement --- */

function renderEnv() {
  const n = shownNight(), s = shownSummary();
  $('#envTiles').innerHTML = [
    tile('Bruit de fond (L90)', s.ambient.l90 != null ? `${s.ambient.l90} dB` : '—', 'niveau dépassé 90 % du temps'),
    tile('Niveau médian (L50)', s.ambient.l50 != null ? `${s.ambient.l50} dB` : '—', '', METRIC_Q.l50(s.ambient.l50)),
    tile('Pics fréquents (L10)', s.ambient.l10 != null ? `${s.ambient.l10} dB` : '—', 'dépassé 10 % du temps'),
    tile('Maximum', s.ambient.max != null ? `${s.ambient.max} dB` : '—'),
    tile('Bruits environnants', num(s.byCat.env.episodes), fmtDur(s.byCat.env.seconds / 60) + ' cumulées', METRIC_Q.env(s.byCat.env.episodes)),
    tile('Suivis d’un réveil', num(s.disturbing.length), s.disturbing.length ? s.disturbing.slice(0, 2).map((d) => `${d.label} ${clockAt(s.start, d.t0)}`).join(', ') : 'aucun'),
  ].join('');
  charts.envLevel ??= new TimeChart($('#envLevel'));
  const leg = $('#envLevel').previousElementSibling;
  leg.innerHTML = 'Niveau sonore ambiant par minute <span class="legend"><i class="qgrad"></i>maximum (couleur = calme → bruyant) <i style="background:#3987e5"></i>médian</span>';
  charts.envLevel.setData({
    start: n.start, end: n.start + n.lv.length * 1000, yMin: -90, yMax: -10, yFmt: (v) => `${v}`,
    series: [
      { name: 'maximum', kind: 'bars', base: -90, quality: SERIES_Q.level, points: n.minutes.map((m, i) => [i * 60 + 30, m.max]), fmt: (v) => `${v} dB`, tolerance: 60 },
      { name: 'médian', color: '#3987e5', kind: 'line', points: n.minutes.map((m, i) => [i * 60 + 30, m.lvl]), fmt: (v) => `${v} dB`, tolerance: 60 },
    ],
  });
  const types = s.envTypes.slice(0, 10);
  const maxCount = Math.max(1, ...types.map((e) => e.count));
  hbarList($('#envTypes'), types.map((e) => ({
    label: e.label, value: e.count, max: maxCount, q: lin(e.count, 8, 0),
    text: `${num(e.count)} × · ${e.seconds} s · max ${e.maxDb} dB`,
  })));
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
    if (!d) return;
    const label = dateLabel(summaries.find((x) => x.id === d.dataset.del)?.start || Date.now());
    const ok = await confirmDialog({ title: `Supprimer la nuit du ${label} ?`, message: 'La nuit est déplacée dans Bureau/Visual Singer/sommeil/_corbeille (récupérable). Vous pourrez annuler juste après.', confirmLabel: 'Mettre à la corbeille', danger: true });
    if (!ok.ok) return;
    d.disabled = true;
    const trashed = await store.deleteNight(d.dataset.del);
    if (!trashed) { d.disabled = false; toast('Suppression impossible : le serveur local ne répond pas.', { type: 'err' }); return; }
    if (currentId === d.dataset.del) { current = null; currentId = ''; }
    await refreshNights();
    renderHistory();
    toast(`Nuit du ${label} mise à la corbeille`, {
      action: typeof trashed === 'string' ? { label: 'Annuler', run: async () => {
        if (await store.restoreNight(trashed)) { await refreshNights(); renderHistory(); toast('Nuit restaurée', { type: 'ok' }); }
        else toast('Restauration impossible (voir le dossier _corbeille).', { type: 'err' });
      } } : null,
    });
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
  const unconv = m.fmt === fmtDur ? (v) => v * 60 : m.unit === '%' ? (v) => v / 100 : (v) => v;
  const mq = METRIC_Q[m.key];
  charts.trend.setData({
    quality: mq ? (v) => mq(unconv(v)) : null, color: '#3987e5', name: m.label, fmt: axisFmt, highlight: false,
    bars: list.map((s) => ({ label: new Date(s.start).toLocaleDateString('fr-FR', { day: 'numeric', month: 'numeric' }), value: conv(m.get(s) ?? 0), tipTitle: dateLabel(s.start),
      tip: [{ value: m.get(s) == null ? '—' : m.fmt(m.get(s)), label: `${m.label}${mq && m.get(s) != null ? ` · ${qLabel(mq(m.get(s)))}` : ''}`, color: mq && m.get(s) != null ? qColor(mq(m.get(s))) : '#3987e5' }] })),
  });
  calendarHeat($('#calendar'), {
    selected: currentId,
    items: list.map((s) => ({ id: s.id, start: s.start, q: mq && m.get(s) != null ? mq(m.get(s)) : null, text: `${dateLabel(s.start)} · ${m.label} : ${m.get(s) == null ? '—' : m.fmt(m.get(s))}` })),
    onPick: async (id) => { await selectNight(id); showTab('summary'); },
  });
  $('#calendarHint').textContent = `Couleur : ${m.label.toLowerCase()}. Cliquer sur une nuit pour l'ouvrir.`;
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
