/**
 * revision.js : onglet Révision de Cours.
 *
 *   Fiches      une fiche par chapitre, hiérarchie visuelle identique (en-tête, 1. définitions,
 *               2. mécanismes, 3. points critiques, 4. auto-évaluation), palette pastel fonctionnelle :
 *               bleu poudré = définitions / chiffres / classifications, jaune pastel = mécanismes,
 *               rouge rosé = points critiques, vert sauge = maîtrise (suivi uniquement), fluo = alerte rare.
 *   Flashcards  rappel actif + répétition espacée (boîtes de Leitner : 0, 1, 2, 4, 7 jours).
 *   Questions   questions de révision par section (existantes).
 *   Suivi       liste rouge / orange / verte des chapitres pour prioriser.
 * La progression est enregistrée dans le dossier du cours (revision.json).
 */
import { esc, markdown } from './md.js';

const DAY = 86400000;
const INTERVALS = [0, 0, 1, 2, 4, 7];          // jours avant la prochaine révision, par boîte (1 à 5)
const STATUS = {
  rouge: { label: 'À revoir', hint: 'Pas encore su' },
  orange: { label: 'En cours', hint: 'Partiellement su' },
  vert: { label: 'Maîtrisé', hint: 'Su sans regarder' },
};
const CRIT = { urgence: 'Urgence', contre_indication: 'Contre-indication', piege: 'Piège', exception: 'Exception', critere: 'Critère', seuil: 'Seuil' };
const CARD_TYPE = { definition: 'Définition', critere: 'Critère', liste: 'Liste', classification: 'Classification', distinction: 'Distinction', valeur: 'Valeur', mecanisme: 'Mécanisme' };

let ctx = null;          // { $, api, pid, toast, fmt }
let fiches = [];
let rev = { chapitres: {}, cartes: {}, questions: {} };
let view = 'fiches';
let current = 0;
let deck = [];           // file de la séance de flashcards
let deckPos = 0;
let flipped = false;
let deckFilter = { chap: 'all', mode: 'due' };
let saveT = 0;
const pending = { chapitres: {}, cartes: {}, questions: {} };

const $ = (s, r = document) => r.querySelector(s);
/** Titre seul : sans « Fiche de révision : » ni « Chapitre II - » (la numérotation est affichée à part). */
const cleanTitle = (t) => String(t || '').replace(/^\s*fiche(\s+de\s+r[ée]vision)?\s*[:-]\s*/i, '').replace(/^\s*chapitre\s+[IVXLC\d]+\s*[:.-]\s*/i, '').replace(/^\s*(?:[IVXLC]+|\d+)\s*[.)]\s+/, '').trim();
const tb = (t) => (t == null ? '' : `<button type="button" class="ft" data-t="${ctx.fmt(t)}" title="Écouter ce passage">${ctx.fmt(t)}</button>`);

/* ------------------------------------------------------------------ données */

export function initRevision(c) {
  ctx = c;
  $('#rvViews').addEventListener('click', (e) => { const b = e.target.closest('[data-rv]'); if (b) setView(b.dataset.rv); });
  $('#rvPrint').addEventListener('click', () => printFiches([fiches[current]]));
  $('#rvPrintAll').addEventListener('click', () => printFiches(fiches));
  $('#fList').addEventListener('click', (e) => { const li = e.target.closest('[data-f]'); if (li) { current = Number(li.dataset.f); renderFiches(); $('#fPaper').focus(); } });
  $('#fPaper').addEventListener('click', onPaperClick);
  $('#cardsBox').addEventListener('click', onCardsClick);
  $('#suiviBox').addEventListener('click', onSuiviClick);
  document.addEventListener('keydown', onKey);
}

export function setRevisionData(data, pid) {
  fiches = (data?.fiches || []).map((f) => ({ ...f, titre: cleanTitle(f.titre) }));
  rev = { chapitres: {}, cartes: {}, questions: {}, ...(data?.revision || {}) };
  if (ctx) ctx.pid = pid;
  current = Math.min(current, Math.max(0, fiches.length - 1));
  deck = [];
  render();
}

function save(part, k, v) {
  rev[part][k] = v;
  pending[part][k] = v;
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    const body = { ...pending };
    for (const p of Object.keys(pending)) pending[p] = {};
    try { await ctx.api(`/api/projects/${encodeURIComponent(ctx.pid)}/revision`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { ctx.toast(`Progression non enregistrée : ${e.message}`, true); }
  }, 600);
}

const chapStatus = (i) => rev.chapitres[i] || 'rouge';
const cardsOf = (i) => (fiches[i]?.flashcards || []).map((c) => ({ ...c, fiche: i }));
const allCards = () => fiches.flatMap((_, i) => cardsOf(i));
const cardState = (id) => rev.cartes[id] || null;
const isDue = (c, now = Date.now()) => { const s = cardState(c.id); return !s || s.due <= now; };
const mastered = (c) => (cardState(c.id)?.box || 0) >= 4;

/* ------------------------------------------------------------------- rendu */

function setView(v) {
  view = v;
  for (const b of document.querySelectorAll('#rvViews [data-rv]')) {
    b.classList.toggle('on', b.dataset.rv === v);
    b.setAttribute('aria-pressed', String(b.dataset.rv === v));
  }
  render();
}

export function render() {
  if (!ctx) return;
  const empty = !fiches.length && view !== 'qa';   // les questions par section existent sans fiches
  $('#rvEmpty').hidden = !empty;
  $('#rvPrint').hidden = view !== 'fiches' || empty;
  $('#rvPrintAll').hidden = !fiches.length;
  for (const p of document.querySelectorAll('[data-rvpane]')) p.hidden = empty || p.dataset.rvpane !== view;
  if (empty) return;
  if (view === 'fiches') renderFiches();
  else if (view === 'cards') renderCards();
  else if (view === 'suivi') renderSuivi();
  const due = allCards().filter((c) => isDue(c)).length;
  $('#rvDue').textContent = due ? String(due) : '';
}

/* ------------------------------------------------------------------- fiches */

function renderFiches() {
  $('#fList').innerHTML = fiches.map((f, i) => `<li><button type="button" data-f="${i}" class="${i === current ? 'on' : ''}" ${i === current ? 'aria-current="true"' : ''}>
      <span class="st-dot ${chapStatus(i)}" title="${STATUS[chapStatus(i)].label}"></span><span class="fl-n">${i + 1}</span><span class="fl-t">${esc(f.titre)}</span></button></li>`).join('');
  const f = fiches[current];
  $('#fPaper').innerHTML = f ? ficheHtml(f, current, { interactive: true }) : '';
}

/** HTML d'une fiche (écran ou impression). */
export function ficheHtml(f, i, { interactive = false } = {}) {
  const st = chapStatus(i);
  const block = (cls, num, title, body) => (body ? `<section class="fb ${cls}"><h3><span class="fb-n">${num}</span>${title}</h3>${body}</section>` : '');
  const defs = (f.definitions || []).length
    ? `<dl class="f-defs">${f.definitions.map((d) => `<div><dt>${esc(d.terme)}</dt><dd>${esc(d.definition)} ${interactive ? tb(d.t) : ''}</dd></div>`).join('')}</dl>` : '';
  const nums = (f.chiffres || []).length
    ? `<table class="f-nums"><caption>Chiffres et valeurs</caption><tbody>${f.chiffres.map((c) => `<tr><th scope="row">${esc(c.valeur)}</th><td>${esc(c.signification)} ${interactive ? tb(c.t) : ''}</td></tr>`).join('')}</tbody></table>` : '';
  const classList = (f.classifications || []).filter((c) => c.elements?.length);
  const classes = classList.length ? `<div class="f-classes">${classList.map((c) => `<div class="f-class"><h4>${esc(c.titre)}</h4><ul>${c.elements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div>` : '';
  const meca = (f.mecanismes || []).map((m) => `<div class="f-meca"><h4>${esc(m.titre)} ${interactive ? tb(m.t) : ''}</h4>
      <ol class="chain${(m.etapes || []).every((s) => s.length <= 48) ? ' h' : ''}">${(m.etapes || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>`).join('');
  const alerts = f.a_ne_pas_oublier || [];
  const alert = alerts.length ? `<div class="f-alert"><strong>À ne pas oublier</strong><ul>${alerts.map((x) => `<li><mark>${esc(x)}</mark></li>`).join('')}</ul></div>` : '';
  const crit = (f.points_critiques || []).length
    ? `<ul class="f-crit">${f.points_critiques.map((c) => `<li><span class="tag-c ${c.type}">${CRIT[c.type] || esc(c.type)}</span><span>${esc(c.texte)} ${interactive ? tb(c.t) : ''}</span></li>`).join('')}</ul>` : '';
  const comp = f.comparatif ? `<section class="fb fb-comp"><h3>${esc(f.comparatif.titre || 'Tableau comparatif')}</h3><div class="tw"><table class="f-comp">
      <thead><tr><th scope="col">Critère</th>${f.comparatif.colonnes.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${f.comparatif.lignes.map((l) => `<tr><th scope="row">${esc(l.critere)}</th>${f.comparatif.colonnes.map((_, k) => `<td>${esc(l.valeurs?.[k] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>` : '';
  const evalQ = (f.auto_evaluation || []);
  const evalHtml = evalQ.length ? `<ol class="f-eval">${evalQ.map((q, k) => {
    const key = `${i}-${k}`;
    const res = rev.questions[key];
    return `<li class="${res || ''}"><p class="q">${esc(q.question)}</p>${interactive
      ? `<details><summary>Afficher la réponse</summary><p class="a">${esc(q.reponse)} ${tb(q.t)}</p>
          <div class="qr"><button type="button" data-q="${key}" data-r="ko">À revoir</button><button type="button" data-q="${key}" data-r="ok">Je savais</button></div></details>`
      : ''}</li>`;
  }).join('')}</ol>${interactive ? '' : `<p class="f-answers"><strong>Réponses.</strong> ${evalQ.map((q, k) => `${k + 1}. ${esc(q.reponse)}`).join(' · ')}</p>`}` : '';
  const ncards = (f.flashcards || []).length;
  const done = cardsOf(i).filter(mastered).length;

  return `<article class="fiche" aria-labelledby="fiche-t-${i}">
    <header class="f-head">
      <div class="f-meta"><span>Chapitre ${i + 1} / ${fiches.length}</span>${interactive ? `<span>${ctx.fmt(f.start)} à ${ctx.fmt(f.end)}</span>` : ''}${ncards ? `<span>${done} / ${ncards} flashcards maîtrisées</span>` : ''}</div>
      <h2 id="fiche-t-${i}">${esc(f.titre)}</h2>
      <p class="f-obj"><strong>Objectif</strong> ${esc(f.objectif)}</p>
      ${(f.idees_essentielles || []).length ? `<ol class="f-key">${f.idees_essentielles.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
      ${interactive ? `<div class="f-status" role="group" aria-label="État de maîtrise du chapitre">${Object.entries(STATUS).map(([k, v]) => `<button type="button" class="${k}${st === k ? ' on' : ''}" aria-pressed="${st === k}" data-status="${k}" title="${v.hint}">${v.label}</button>`).join('')}</div>`
        : `<span class="f-stamp ${st}">${STATUS[st].label}</span>`}
    </header>
    ${block('fb-def', '1', 'Définitions et bases', defs + nums + classes)}
    ${block('fb-meca', '2', 'Mécanismes et raisonnement', meca)}
    ${block('fb-crit', '3', 'Points critiques et exceptions', alert + crit)}
    ${comp}
    ${block('fb-eval', '4', 'Auto-évaluation', evalHtml + (interactive && evalQ.length ? '<p class="f-tip">Répondez de mémoire avant d’afficher la réponse.</p>' : ''))}
    ${interactive && ncards ? `<footer class="f-foot"><button type="button" class="btn btn-ghost" data-train="${i}">Réviser les ${ncards} flashcards de ce chapitre</button></footer>` : ''}
  </article>`;
}

function onPaperClick(e) {
  const s = e.target.closest('[data-status]');
  if (s) { save('chapitres', current, s.dataset.status); renderFiches(); return; }
  const q = e.target.closest('[data-q]');
  if (q) { save('questions', q.dataset.q, q.dataset.r); q.closest('li').className = q.dataset.r; return; }
  const tr = e.target.closest('[data-train]');
  if (tr) { deckFilter = { chap: tr.dataset.train, mode: 'all' }; deck = []; setView('cards'); }
}

/* --------------------------------------------------------------- impression */

function printFiches(list) {
  list = list.filter(Boolean);
  if (!list.length) return;
  let root = $('#printRoot');
  if (!root) { root = document.createElement('div'); root.id = 'printRoot'; document.body.append(root); }
  root.innerHTML = list.map((f) => ficheHtml(f, fiches.indexOf(f))).join('');
  document.body.classList.add('printing-fiches');
  const done = () => { document.body.classList.remove('printing-fiches'); root.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}

/* --------------------------------------------------------------- flashcards */

function buildDeck() {
  const now = Date.now();
  let cards = deckFilter.chap === 'all' ? allCards() : cardsOf(Number(deckFilter.chap));
  if (deckFilter.mode === 'due') cards = cards.filter((c) => isDue(c, now));
  // Les cartes jamais vues et les plus en retard d'abord, sans regrouper un même chapitre.
  cards.sort((a, b) => (cardState(a.id)?.due || 0) - (cardState(b.id)?.due || 0) || Math.random() - 0.5);
  deck = cards;
  deckPos = 0;
  flipped = false;
}

function renderCards() {
  if (!deck.length || deckPos > deck.length) buildDeck();
  const total = allCards().length;
  const dueAll = allCards().filter((c) => isDue(c)).length;
  const opts = `<option value="all">Tous les chapitres</option>${fiches.map((f, i) => `<option value="${i}"${String(i) === String(deckFilter.chap) ? ' selected' : ''}>${i + 1}. ${esc(f.titre)}</option>`).join('')}`;
  const card = deck[deckPos];
  const st = card ? cardState(card.id) : null;
  $('#cardsBox').innerHTML = `
    <div class="cards-bar">
      <label>Chapitre <select data-cf="chap">${opts}</select></label>
      <div class="seg" role="group" aria-label="Cartes à réviser">
        <button type="button" data-mode="due" class="${deckFilter.mode === 'due' ? 'on' : ''}" aria-pressed="${deckFilter.mode === 'due'}">À réviser aujourd'hui</button>
        <button type="button" data-mode="all" class="${deckFilter.mode === 'all' ? 'on' : ''}" aria-pressed="${deckFilter.mode === 'all'}">Toutes</button>
      </div>
      <span class="muted">${dueAll} carte(s) à réviser sur ${total}</span>
    </div>
    ${card ? `
    <div class="fc-progress" aria-hidden="true"><i style="width:${(deckPos / deck.length) * 100}%"></i></div>
    <p class="fc-count">Carte ${deckPos + 1} / ${deck.length} · ${esc(fiches[card.fiche]?.titre || '')}</p>
    <button type="button" class="fc ${flipped ? 'flipped' : ''}" data-flip aria-live="polite" aria-label="${flipped ? 'Réponse' : 'Question'} : ${esc(flipped ? card.verso : card.recto)}">
      <span class="fc-type">${CARD_TYPE[card.type] || 'Question'}${st ? ` · boîte ${st.box}` : ' · nouvelle'}</span>
      <span class="fc-q">${esc(card.recto)}</span>
      ${flipped ? `<span class="fc-a">${esc(card.verso)}</span>` : '<span class="fc-hint">Répondez de mémoire, puis Espace ou clic pour retourner la carte</span>'}
    </button>
    <div class="fc-actions" ${flipped ? '' : 'hidden'}>
      <button type="button" class="r-ko" data-grade="0"><kbd>1</kbd> À revoir</button>
      <button type="button" class="r-mid" data-grade="1"><kbd>2</kbd> Hésitant</button>
      <button type="button" class="r-ok" data-grade="2"><kbd>3</kbd> Su</button>
    </div>
    ${card.t != null ? `<p class="fc-src">Source : ${tb(card.t)}</p>` : ''}`
    : `<div class="fc-done"><h3>${deckFilter.mode === 'due' ? 'Aucune carte à réviser pour le moment' : 'Séance terminée'}</h3>
        <p>${nextDueText()}</p>
        <button type="button" class="btn btn-ghost" data-mode="all">Réviser toutes les cartes quand même</button></div>`}`;
}

function nextDueText() {
  const future = allCards().map((c) => cardState(c.id)?.due).filter((d) => d && d > Date.now()).sort((a, b) => a - b);
  if (!future.length) return 'Toutes les cartes ont été vues.';
  const d = new Date(future[0]);
  return `Prochaine révision : ${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}. Les cartes sues reviennent après 1, 2, 4 puis 7 jours.`;
}

/** Note : 0 à revoir (boîte 1, revient dans la séance), 1 hésitant (même boîte), 2 su (boîte suivante). */
function grade(g) {
  const card = deck[deckPos];
  if (!card) return;
  const prev = cardState(card.id) || { box: 1, seen: 0, ok: 0 };
  const box = g === 0 ? 1 : g === 1 ? Math.max(1, prev.box) : Math.min(5, prev.box + (prev.seen ? 1 : 2));
  const due = Date.now() + (g === 0 ? 0 : Math.max(INTERVALS[box], g === 1 ? 0.5 : 1)) * DAY;
  save('cartes', card.id, { box, due, seen: prev.seen + 1, ok: prev.ok + (g === 2 ? 1 : 0), last: Date.now() });
  if (g === 0) deck.splice(Math.min(deck.length, deckPos + 4), 0, card);   // rappel dans la même séance
  deckPos += 1;
  flipped = false;
  if (deckPos >= deck.length) { deck = []; deckPos = 0; deckFilter.mode = 'due'; buildDeckDone(); return; }
  renderCards();
  $('#cardsBox .fc')?.focus();
}

function buildDeckDone() {
  ctx.toast('Séance terminée. Les cartes reviendront selon leur boîte.');
  buildDeck();
  renderCards();
}

function onCardsClick(e) {
  if (e.target.closest('[data-flip]')) { flipped = !flipped; renderCards(); $('#cardsBox .fc')?.focus(); return; }
  const g = e.target.closest('[data-grade]');
  if (g) { grade(Number(g.dataset.grade)); return; }
  const m = e.target.closest('[data-mode]');
  if (m) { deckFilter.mode = m.dataset.mode; buildDeck(); renderCards(); return; }
  const sel = e.target.closest('select[data-cf]');
  if (sel && !sel._bound) { sel._bound = true; sel.addEventListener('change', () => { deckFilter.chap = sel.value; buildDeck(); renderCards(); }); }
}

function onKey(e) {
  if (view !== 'cards' || $('#cardsBox').closest('[hidden]') || e.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
  if (!$('#cardsBox .fc')) return;
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); flipped = !flipped; renderCards(); $('#cardsBox .fc')?.focus(); }
  else if (flipped && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); grade(Number(e.key) - 1); }
}

/* -------------------------------------------------------------------- suivi */

function renderSuivi() {
  const rows = fiches.map((f, i) => {
    const cards = cardsOf(i);
    const m = cards.filter(mastered).length;
    const due = cards.filter((c) => isDue(c)).length;
    const qs = (f.auto_evaluation || []).map((_, k) => rev.questions[`${i}-${k}`]);
    const qok = qs.filter((x) => x === 'ok').length;
    return { i, f, st: chapStatus(i), m, n: cards.length, due, qok, qn: qs.length };
  });
  const order = { rouge: 0, orange: 1, vert: 2 };
  rows.sort((a, b) => order[a.st] - order[b.st] || (a.n ? a.m / a.n : 0) - (b.n ? b.m / b.n : 0));
  const count = (k) => rows.filter((r) => r.st === k).length;
  $('#suiviBox').innerHTML = `
    <div class="suivi-sum">${Object.entries(STATUS).map(([k, v]) => `<div class="ss ${k}"><b>${count(k)}</b><span>${v.label}</span></div>`).join('')}</div>
    <p class="muted">Ordre de révision conseillé : chapitres à revoir, puis en cours, puis maîtrisés ; à statut égal, ceux dont les flashcards sont le moins sues.</p>
    <table class="tbl suivi-tbl"><thead><tr><th scope="col">Priorité</th><th scope="col">Chapitre</th><th scope="col">État</th><th scope="col" class="num">Flashcards sues</th><th scope="col" class="num">À réviser</th><th scope="col" class="num">Auto-évaluation</th><th scope="col"></th></tr></thead>
    <tbody>${rows.map((r, k) => `<tr class="${r.st}">
      <td class="num">${k + 1}</td><td><button type="button" class="link" data-open="${r.i}">${r.i + 1}. ${esc(r.f.titre)}</button></td>
      <td><div class="f-status mini" role="group" aria-label="État du chapitre ${r.i + 1}">${Object.entries(STATUS).map(([s, v]) => `<button type="button" class="${s}${r.st === s ? ' on' : ''}" aria-pressed="${r.st === s}" data-set="${r.i}" data-s="${s}">${v.label}</button>`).join('')}</div></td>
      <td class="num"><span class="mbar" aria-hidden="true"><i style="width:${r.n ? (r.m / r.n) * 100 : 0}%"></i></span> ${r.m} / ${r.n}</td>
      <td class="num">${r.due}</td><td class="num">${r.qn ? `${r.qok} / ${r.qn}` : '-'}</td>
      <td>${r.n ? `<button type="button" class="btn btn-ghost" data-train="${r.i}">Réviser</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
}

function onSuiviClick(e) {
  const s = e.target.closest('[data-set]');
  if (s) { save('chapitres', Number(s.dataset.set), s.dataset.s); renderSuivi(); return; }
  const o = e.target.closest('[data-open]');
  if (o) { current = Number(o.dataset.open); setView('fiches'); return; }
  const tr = e.target.closest('[data-train]');
  if (tr) { deckFilter = { chap: tr.dataset.train, mode: 'all' }; deck = []; setView('cards'); }
}

export { markdown };
