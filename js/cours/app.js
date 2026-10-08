/**
 * app.js — Interface « Cours » : projets, traitement, lecture synchronisée,
 * résumés, notions, croisement audio ↔ support, révision, recherche, chat, export.
 *
 * Le moteur (Python, cours_engine/) écoute sur http://127.0.0.1:8091.
 */
import { icon, hydrateIcons } from '../icons.js';
import { markdown, esc, highlight } from './md.js';
import { qColor, qLabel, lin } from '../sleep/quality.js';
import { qualityLegend } from '../sleep/charts.js';
import { storage } from '../utils.js';

const API = location.port === '8091' ? '' : 'http://127.0.0.1:8091';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SPK = ['#c4851a', '#3987e5', '#14a88a', '#d55181', '#9085e9', '#e0384a', '#8a8c93'];
const UNIT_LABEL = { slide: 'Diapositive', page: 'Page', section: 'Section' };

const S = {
  system: null, projects: [], pid: null, project: null, data: null,
  tab: 'read', media: null, cur: -1, pinnedUnit: null, shownUnit: null, words: new Map(),
  chat: [], pollT: 0,
};

/* ------------------------------------------------------------- utilitaires */

export function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
const parseT = (s) => { const p = String(s).split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
const tBtn = (t) => (t == null ? '' : `<button class="link-t" data-t="${fmt(t)}">${fmt(t)}</button>`);
const fileUrl = (rel) => `${API}/api/projects/${encodeURIComponent(S.pid)}/file/${rel.split('/').map(encodeURIComponent).join('/')}`;
const sizeMb = (b) => `${(b / 1048576).toFixed(b > 1e9 ? 0 : 1)} Mo`;

async function api(path, opts = {}) {
  const r = await fetch(API + path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (r.headers.get('content-type') || '').includes('json') ? r.json() : r;
}
const jsonOpts = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function toast(msg, bad = false) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    Object.assign(el.style, { position: 'fixed', left: '50%', bottom: '1.4rem', translate: '-50% 0', padding: '0.6rem 1rem', borderRadius: '12px',
      background: 'var(--raised)', boxShadow: '6px 6px 16px var(--sh-dark)', fontSize: '0.78rem', zIndex: 50, transition: 'opacity .3s', maxWidth: '90vw' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.style.color = bad ? '#ff8a96' : 'var(--text)';
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 3800);
}

/* ------------------------------------------------------------------ démarrage */

async function boot() {
  hydrateIcons();
  for (const el of $$('[data-qlegend]')) qualityLegend(el);
  bindUi();
  try {
    await loadSystem();
  } catch {
    $('#sysPill').innerHTML = '<i style="background:#e0384a"></i><b>Moteur arrêté</b> — lancez start-cours.bat';
    $('#app').classList.add('no-project');
    $('#emptyState p').textContent = "Le moteur d'analyse ne répond pas. Lancez start-cours.bat (ou : cours_engine\\.venv\\Scripts\\python cours_engine\\run.py), puis rechargez la page.";
    return;
  }
  await loadProjects();
  const want = location.hash.slice(1) || storage.get('vs.cours.last', null);
  if (want && S.projects.some((p) => p.id === want)) await openProject(want);
  else $('#app').classList.add('no-project');
  setInterval(loadSystem, 15000);
}

async function loadSystem() {
  const s = await api('/api/system');
  S.system = s;
  const hw = s.hardware;
  const llmOk = s.llm.running;
  $('#sysPill').innerHTML = `<b>${esc(hw.gpu ? hw.gpu.replace('NVIDIA GeForce ', '') : 'CPU')}</b>${hw.gpu ? ` ${hw.vram_gb} Go` : ''} · ${hw.ram_gb} Go RAM`
    + `<i style="background:${llmOk ? '#14a88a' : '#e0384a'}"></i>${llmOk ? esc(s.llm.quality_ready ? s.llm.quality : (s.llm.models[0] || 'LLM')) : 'Ollama arrêté'}`;
  $('#sysPill').title = `${hw.cpu}\n${hw.threads} threads · CUDA ${hw.torch_cuda ? 'oui' : 'non'} (capacité ${hw.compute_capability || '—'})\n`
    + `LLM qualité : ${s.recommend.llm_quality}${s.llm.quality_ready ? '' : ' (non installé)'}\nLLM rapide : ${s.recommend.llm_fast}\nDonnées : ${s.data_dir}`;
}

async function loadProjects() {
  S.projects = await api('/api/projects');
  renderProjects();
}

function jobLabel(st) {
  const j = st?._job?.status;
  return { running: ['en cours', 'run'], queued: ['en attente', 'run'], error: ['erreur', 'err'], done: ['analysé', ''], cancelled: ['interrompu', 'err'] }[j] || ['à analyser', ''];
}

function renderProjects() {
  const ul = $('#projList');
  if (!S.projects.length) { ul.innerHTML = '<li class="muted">Aucun cours. Cliquez sur « Nouveau ».</li>'; return; }
  ul.innerHTML = S.projects.map((p) => {
    const [lab, cls] = jobLabel(p.state);
    return `<li data-id="${esc(p.id)}" class="${p.id === S.pid ? 'on' : ''}"><b>${esc(p.title)}</b><span class="st ${cls}">${lab}</span>
      <small>${new Date(p.created * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}${p.media ? ` · ${esc(p.media.name)}` : ''}</small></li>`;
  }).join('');
}

/* ------------------------------------------------------------------- projet */

async function newProject() {
  const title = prompt('Titre du cours :', 'Nouveau cours');
  if (title === null) return;
  const p = await api('/api/projects', jsonOpts('POST', { title }));
  await loadProjects();
  await openProject(p.id);
}

async function openProject(pid) {
  S.pid = pid;
  S.data = null; S.cur = -1; S.words.clear(); S.chat = []; S.pinnedUnit = null; S.shownUnit = null;
  location.hash = pid;
  storage.set('vs.cours.last', pid);
  $('#app').classList.remove('no-project');
  renderProjects();
  await refreshProject();
  await loadData();
  $('#chatLog').innerHTML = '<div class="msg bot"><div class="bubble">Posez une question sur le cours : je réponds uniquement à partir de la transcription et du support, avec les sources.</div></div>';
}

async function refreshProject() {
  const p = await api(`/api/projects/${encodeURIComponent(S.pid)}`);
  const wasRunning = S.project && (S.project.running || S.project.queued);
  S.project = p;
  renderProjectPanel();
  const busy = p.running || p.queued;
  clearTimeout(S.pollT);
  if (busy) S.pollT = setTimeout(refreshProject, 1500);
  if (wasRunning && !busy) {
    await loadProjects();
    await loadData();
    toast(p.state?._job?.status === 'done' ? 'Analyse terminée.' : 'Traitement interrompu.', p.state?._job?.status !== 'done');
  }
}

function renderProjectPanel() {
  const p = S.project;
  $('#projPanel').hidden = false;
  if (document.activeElement !== $('#projTitle')) $('#projTitle').value = p.title;
  $('#mediaName').textContent = p.media ? p.media.name : "Ajouter l'audio / la vidéo du cours";
  $('#mediaInfo').textContent = p.media ? `${sizeMb(p.media.size)} · cliquer pour remplacer` : 'MP3, WAV, M4A, MP4, MKV… (glisser-déposer)';
  $('#docList').innerHTML = (p.docs || []).map((d) => `<li>${icon('doc', '#3987e5', { tile: false })}<span title="${esc(d.name)}">${esc(d.name)}</span>
    <small class="muted">${sizeMb(d.size)}</small><button data-del="${esc(d.id)}" title="Retirer">✕</button></li>`).join('');
  hydrateIcons($('#docList'));
  for (const sel of $$('[data-set]')) {
    const v = (p.settings || {})[sel.dataset.set];
    if (sel.type === 'checkbox') sel.checked = !!v; else sel.value = String(v ?? '');
    sel.disabled = p.running;
  }
  const busy = p.running || p.queued;
  $('#btnRun').disabled = busy || !p.media;
  $('#btnRun span').textContent = busy ? (p.queued ? 'En attente…' : 'Analyse en cours…') : (p.state?._job?.status === 'done' ? 'Relancer (mises à jour)' : "Lancer l'analyse");
  $('#btnCancel').hidden = !busy;
  const steps = S.system?.steps || [];
  $('#steps').innerHTML = steps.map(({ id, label }) => {
    const st = p.state?.[id] || {};
    const status = st.status || 'pending';
    const pct = Math.round((st.progress || 0) * 100);
    return `<li class="${status}"><span class="sd"></span><span>${esc(label)}</span><span class="sp">${status === 'done' ? (st.seconds != null ? `${st.seconds < 90 ? Math.round(st.seconds) + ' s' : Math.round(st.seconds / 60) + ' min'}` : '✓') : status === 'running' ? pct + ' %' : status === 'skipped' ? '—' : ''}</span>
      ${status === 'running' ? `<span class="sbar"><i style="width:${pct}%"></i></span>` : ''}${status === 'error' && st.error ? `<span class="serr">${esc(st.error)}</span>` : ''}</li>`;
  }).join('');
  const logs = $('#logs');
  const atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 8;
  logs.textContent = (p.logs || []).join('\n');
  if (atBottom) logs.scrollTop = logs.scrollHeight;
}

async function loadData() {
  try {
    S.data = await api(`/api/projects/${encodeURIComponent(S.pid)}/data`);
  } catch (e) { toast(e.message, true); return; }
  S.unitsById = Object.fromEntries((S.data.units || []).map((u) => [u.id, u]));
  S.paraStarts = (S.data.paragraphs || []).map((p) => p.start);
  S.cur = -1;
  renderAll();
}

/* ------------------------------------------------------------------- envois */

function uploadFile(url, files, field, label) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const f of files) fd.append(field, f);
    const xhr = new XMLHttpRequest();
    const bar = $('#uploadBar');
    bar.hidden = false;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      bar.querySelector('i').style.transform = `scaleX(${e.loaded / e.total})`;
      bar.querySelector('span').textContent = `${label} : ${Math.round((e.loaded / e.total) * 100)} % (${sizeMb(e.loaded)} / ${sizeMb(e.total)})`;
    };
    xhr.onload = () => { bar.hidden = true; xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(JSON.parse(xhr.responseText || '{}').detail || xhr.statusText)); };
    xhr.onerror = () => { bar.hidden = true; reject(new Error('Envoi impossible (moteur arrêté ?)')); };
    xhr.open('POST', API + url);
    xhr.send(fd);
  });
}

async function addMedia(file) {
  if (!file) return;
  try {
    await uploadFile(`/api/projects/${encodeURIComponent(S.pid)}/media`, [file], 'file', file.name);
    await refreshProject(); await loadProjects();
    toast('Média ajouté. Ajoutez le support puis lancez l’analyse.');
  } catch (e) { toast(e.message, true); }
}

async function addDocs(files) {
  if (!files?.length) return;
  try {
    await uploadFile(`/api/projects/${encodeURIComponent(S.pid)}/docs`, files, 'files', files.length > 1 ? `${files.length} documents` : files[0].name);
    await refreshProject();
  } catch (e) { toast(e.message, true); }
}

/* ----------------------------------------------------------- liaisons UI */

function bindUi() {
  for (const b of $$('.s-tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('#btnSide').addEventListener('click', () => $('#app').classList.toggle('side-hidden'));
  $('#btnNew').addEventListener('click', newProject);
  $('#btnNew2').addEventListener('click', newProject);
  $('#projList').addEventListener('click', (e) => { const li = e.target.closest('li[data-id]'); if (li) openProject(li.dataset.id); });
  $('#projTitle').addEventListener('change', async (e) => {
    await api(`/api/projects/${encodeURIComponent(S.pid)}`, jsonOpts('PATCH', { title: e.target.value }));
    loadProjects();
  });
  $('#btnDelete').addEventListener('click', async () => {
    if (!confirm('Mettre ce cours à la corbeille (Bureau/Visual Singer/cours/_corbeille) ?')) return;
    await api(`/api/projects/${encodeURIComponent(S.pid)}`, { method: 'DELETE' });
    S.pid = null; location.hash = '';
    $('#projPanel').hidden = true;
    $('#app').classList.add('no-project');
    loadProjects();
  });
  for (const [drop, input, handler] of [['#dropMedia', '#fileMedia', (f) => addMedia(f[0])], ['#dropDocs', '#fileDocs', (f) => addDocs([...f])]]) {
    const d = $(drop), inp = $(input);
    d.addEventListener('click', () => inp.click());
    d.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.click(); });
    inp.addEventListener('change', () => { handler(inp.files); inp.value = ''; });
    d.addEventListener('dragover', (e) => { e.preventDefault(); d.classList.add('over'); });
    d.addEventListener('dragleave', () => d.classList.remove('over'));
    d.addEventListener('drop', (e) => { e.preventDefault(); d.classList.remove('over'); handler(e.dataTransfer.files); });
  }
  $('#docList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b || !confirm('Retirer ce document du cours ?')) return;
    await api(`/api/projects/${encodeURIComponent(S.pid)}/docs/${b.dataset.del}`, { method: 'DELETE' });
    refreshProject();
  });
  for (const sel of $$('[data-set]')) {
    sel.addEventListener('change', async () => {
      const v = sel.type === 'checkbox' ? sel.checked : ['speakers', 'qa_count'].includes(sel.dataset.set) ? Number(sel.value) : sel.value;
      await api(`/api/projects/${encodeURIComponent(S.pid)}`, jsonOpts('PATCH', { settings: { [sel.dataset.set]: v } }));
      refreshProject();
    });
  }
  $('#btnRun').addEventListener('click', async () => {
    await api(`/api/projects/${encodeURIComponent(S.pid)}/process`, { method: 'POST' });
    refreshProject(); loadProjects();
  });
  $('#btnCancel').addEventListener('click', async () => {
    await api(`/api/projects/${encodeURIComponent(S.pid)}/cancel`, { method: 'POST' });
    toast('Annulation demandée : le traitement s’arrête après l’étape en cours de sauvegarde.');
  });

  // Horodatages cliquables partout.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]');
    if (t) { seek(parseT(t.dataset.t)); return; }
    const u = e.target.closest('[data-unit]');
    if (u && !e.target.closest('.thumbs')) { showUnit(u.dataset.unit, true); showTab('read'); }
  });

  $('#transcript').addEventListener('click', (e) => {
    const p = e.target.closest('.tp');
    if (!p) return;
    const w = e.target.closest('.w');
    seek(w ? Number(w.dataset.s) : Number(p.dataset.start));
  });
  $('#trFilter').addEventListener('input', debounce(renderTranscript, 250));
  $('#chapters').addEventListener('click', (e) => { const li = e.target.closest('li[data-s]'); if (li) seek(Number(li.dataset.s)); });
  $('#thumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-u]'); if (b) showUnit(b.dataset.u, true); });
  $('#speakers').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-spk]');
    if (!b) return;
    const i = Number(b.dataset.spk);
    const name = prompt('Nom de cet intervenant :', S.data.speakers[i]);
    if (!name) return;
    const names = [...S.data.speakers];
    names[i] = name;
    await api(`/api/projects/${encodeURIComponent(S.pid)}`, jsonOpts('PATCH', { speaker_names: names }));
    loadData();
  });
  $('#glossFilter').addEventListener('input', debounce(renderNotions, 200));
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
  $('#results').addEventListener('click', (e) => {
    const r = e.target.closest('.res');
    if (!r || e.target.closest('[data-t]')) return;
    if (r.dataset.start) { seek(Number(r.dataset.start)); }
    else if (r.dataset.u) { showUnit(r.dataset.u, true); showTab('read'); }
  });
  $('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  $('#qa').addEventListener('click', (e) => {
    const card = e.target.closest('.card-qa');
    if (!card || e.target.closest('[data-t]')) return;
    const k = e.target.closest('button.k');
    if (k) { card.classList.toggle('ok', k.dataset.k === 'ok'); card.classList.toggle('ko', k.dataset.k === 'ko'); updateScore(); return; }
    card.classList.toggle('open');
  });
  $('#qaReveal').addEventListener('click', () => $$('.card-qa').forEach((c) => c.classList.add('open')));
  $('#qaShuffle').addEventListener('click', () => { const box = $('#qa'); [...box.children].sort(() => Math.random() - 0.5).forEach((c) => box.append(c)); });
  for (const b of $$('[data-export]')) b.addEventListener('click', () => doExport(b.dataset.export));
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || !S.media) return;
    if (e.key === ' ') { e.preventDefault(); S.media.paused ? S.media.play() : S.media.pause(); }
    if (e.key === 'ArrowLeft') S.media.currentTime -= e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowRight') S.media.currentTime += e.shiftKey ? 30 : 5;
  });
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function showTab(name) {
  S.tab = name;
  for (const b of $$('.s-tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const p of $$('.pane')) p.classList.toggle('on', p.dataset.pane === name);
  if (name === 'chat') $('#chatInput').focus();
  if (name === 'search') $('#searchInput').focus();
}

/* ------------------------------------------------------------------ rendu */

function renderAll() {
  const d = S.data;
  renderPlayer();
  renderTranscript();
  renderSpeakers();
  renderChapters();
  renderThumbs();
  if (!S.shownUnit && d.units?.length) showUnit(d.units[0].id);
  renderSummary();
  renderNotions();
  renderCross();
  renderQA();
  $('#exportNote').textContent = d.analysis ? `Fichiers enregistrés aussi dans le dossier exports du cours.` : 'Disponible après l’analyse.';
}

function renderPlayer() {
  const a = S.data.audio;
  const box = $('#playerBox');
  if (!a) { box.innerHTML = '<p class="muted">Le lecteur apparaîtra après l’extraction audio.</p>'; S.media = null; return; }
  const tag = a.playback_kind === 'video' ? 'video' : 'audio';
  box.innerHTML = `<${tag} controls preload="metadata" src="${fileUrl(a.playback)}"></${tag}>`;
  S.media = box.firstElementChild;
  let raf = 0;
  const onTime = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; syncToTime(S.media.currentTime); }); };
  S.media.addEventListener('timeupdate', onTime);
  S.media.addEventListener('seeked', onTime);
}

function seek(t) {
  if (!S.media) return;
  S.media.currentTime = t;
  if (S.media.paused) S.media.play().catch(() => {});
  S.pinnedUnit = null;
  showTab('read');
  syncToTime(t, true);
}

function paraAt(t) {
  const a = S.paraStarts || [];
  let lo = 0, hi = a.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= t + 0.05) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

function syncToTime(t, force = false) {
  const d = S.data;
  $('#nowTime').textContent = fmt(t);
  const i = paraAt(t);
  if (i !== S.cur || force) {
    $(`.tp[data-i="${S.cur}"]`)?.classList.remove('on');
    S.cur = i;
    const el = $(`.tp[data-i="${i}"]`);
    if (el) {
      el.classList.add('on');
      if ($('#follow').checked || force) el.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
      loadWords(i);
    }
    const p = d.paragraphs[i];
    $('#nowSpeaker').textContent = p && d.speakers.length > 1 ? d.speakers[p.speaker] || '' : '';
    const secs = d.index?.sections || [];
    const si = secs.findIndex((s) => t >= s.start && t <= s.end);
    const title = d.analysis?.sections?.[si]?.titre;
    $('#nowSection').textContent = si >= 0 ? (title || `Section ${si + 1}`) : '';
    $$('#chapters li').forEach((li, k) => li.classList.toggle('on', k === si));
    const al = d.index?.alignment?.[i];
    if (al?.unit && !S.pinnedUnit && al.unit !== S.shownUnit) showUnit(al.unit);
  }
  // Mot courant.
  const words = $$(`.tp[data-i="${S.cur}"] .w`);
  for (const w of words) w.classList.toggle('cur', t >= Number(w.dataset.s) && t < Number(w.dataset.e) + 0.05);
}

async function loadWords(i) {
  const p = S.data.paragraphs[i];
  if (!p || S.words.has(i)) return;
  S.words.set(i, null);
  try {
    const segs = await api(`/api/projects/${encodeURIComponent(S.pid)}/words?start=${p.start - 0.5}&end=${p.end + 0.5}`);
    const ids = new Set(p.segs);
    const words = segs.filter((s) => ids.has(s.id)).flatMap((s) => s.words);
    if (!words.length) return;
    S.words.set(i, words);
    const el = $(`.tp[data-i="${i}"] p`);
    if (el && !$('#trFilter').value) {
      el.innerHTML = words.map((w) => `<span class="w${w.p < 0.45 ? ' lowp' : ''}" data-s="${w.s}" data-e="${w.e}"${w.p < 0.45 ? ` title="Mot incertain (${Math.round(w.p * 100)} %)"` : ''}>${esc(w.w)}</span>`).join('');
    }
  } catch { S.words.delete(i); }
}

function renderTranscript() {
  const d = S.data;
  const box = $('#transcript');
  if (!d.paragraphs?.length) { box.innerHTML = `<p class="muted">${S.project?.running ? 'Transcription en cours…' : 'La transcription apparaîtra ici après l’analyse.'}</p>`; return; }
  const q = $('#trFilter').value.trim();
  const secs = d.index?.sections || [];
  const secStart = new Map(secs.map((s, k) => [s.paras[0], k]));
  const html = [];
  d.paragraphs.forEach((p, i) => {
    if (q && !p.text.toLowerCase().includes(q.toLowerCase())) return;
    if (!q && secStart.has(i)) {
      const k = secStart.get(i);
      html.push(`<div class="tp-sec">${k + 1}. ${esc(d.analysis?.sections?.[k]?.titre || `Section ${k + 1}`)}</div>`);
    }
    const spk = d.speakers.length > 1 ? `<b style="color:${SPK[p.speaker % SPK.length]}">${esc(d.speakers[p.speaker] || '')}</b>` : '';
    html.push(`<div class="tp" data-i="${i}" data-start="${p.start}"><span class="tt">${fmt(p.start)}${spk}</span><p>${highlight(p.text, q)}</p></div>`);
  });
  box.innerHTML = html.join('') || '<p class="muted">Aucun passage ne correspond.</p>';
  S.words.clear();
  S.cur = -1;
  if (S.media) syncToTime(S.media.currentTime);
}

function renderSpeakers() {
  const d = S.data;
  const shares = d.meta?.speaker_shares;
  $('#speakers').innerHTML = (d.speakers || []).length > 1
    ? d.speakers.map((s, i) => `<span class="spk" data-spk="${i}" title="Cliquer pour renommer"><i style="background:${SPK[i % SPK.length]}"></i>${esc(s)}</span>`).join('')
    : '';
  void shares;
}

function renderChapters() {
  const d = S.data;
  const secs = d.index?.sections || [];
  $('#chapters').innerHTML = secs.map((s, k) => `<li data-s="${s.start}"><span>${fmt(s.start)}</span>${esc(d.analysis?.sections?.[k]?.titre || `Section ${k + 1}`)}</li>`).join('')
    || '<li class="muted">Disponible après l’indexation.</li>';
}

function unitCoverage() {
  const cov = {};
  for (const c of S.data.index?.coverage || []) (cov[c.unit] ||= []).push(c.score);
  const out = {};
  for (const [u, arr] of Object.entries(cov)) out[u] = arr.reduce((a, b) => a + b, 0) / arr.length;
  return out;
}

function renderThumbs() {
  const units = S.data.units || [];
  const cov = unitCoverage();
  $('#thumbs').innerHTML = units.map((u) => u.image
    ? `<button class="thumb${cov[u.id] != null && cov[u.id] < 0.55 ? ' uncov' : ''}" data-u="${u.id}" title="${esc(`${UNIT_LABEL[u.kind] || ''} ${u.n} — ${u.title}`)}"><img loading="lazy" src="${fileUrl(u.image)}" alt=""><span>${u.n}</span></button>`
    : `<button class="thumb txt${cov[u.id] != null && cov[u.id] < 0.55 ? ' uncov' : ''}" data-u="${u.id}" title="${esc(u.title)}">${u.n}. ${esc(u.title).slice(0, 60)}</button>`).join('');
  $('#slideHead').textContent = units.length ? `Support (${units.length})` : 'Support';
}

function showUnit(uid, pin = false) {
  const u = S.unitsById?.[uid];
  if (!u) return;
  S.shownUnit = uid;
  if (pin) S.pinnedUnit = uid;
  const label = `${UNIT_LABEL[u.kind] || ''} ${u.n}`;
  $('#slideMeta').textContent = `${label} · ${u.doc_name || ''}`;
  const text = [u.text, ...(u.tables || []), u.notes ? `Notes : ${u.notes}` : ''].filter(Boolean).join('\n\n');
  $('#slideView').innerHTML = (u.image ? `<img src="${fileUrl(u.image)}" alt="${esc(label)}">` : '')
    + `<div class="stext"><b>${esc(u.title || label)}</b>${esc(text).slice(0, 4000)}${u.ocr ? '\n\n(texte lu par OCR)' : ''}</div>`;
  const times = S.data.index?.unit_times?.[uid] || [];
  $('#slideTimes').innerHTML = times.length
    ? `<span class="muted">Expliquée à :</span> ${times.slice(0, 12).map(([a, b]) => `<button class="chip-t" data-t="${fmt(a)}">${fmt(a)}–${fmt(b)}</button>`).join('')}`
    : (S.data.index ? '<span class="muted">Pas de passage oral associé à cette diapositive.</span>' : '');
  $$('#thumbs .thumb').forEach((b) => b.classList.toggle('on', b.dataset.u === uid));
  $(`#thumbs .thumb[data-u="${uid}"]`)?.scrollIntoView({ block: 'nearest' });
}

/* ---------------------------------------------------------------- résumé */

function renderSummary() {
  const a = S.data.analysis;
  if (!a) {
    $('#sumTitle').textContent = S.project?.title || '—';
    $('#sumShort').innerHTML = `<p class="muted">${S.data.paragraphs?.length ? 'L’analyse par le LLM n’est pas encore faite (vérifiez qu’Ollama est lancé, puis relancez).' : 'Lancez l’analyse pour obtenir les résumés.'}</p>`;
    for (const id of ['#sumPlan', '#sumLong', '#sumSynth', '#sumSections']) $(id).innerHTML = '';
    return;
  }
  const c = a.course || {};
  $('#sumModel').textContent = `Analyse : ${a.model} · ${a.sections.length} sections`;
  $('#sumTitle').textContent = c.titre_cours || S.project.title;
  $('#sumShort').innerHTML = markdown(c.resume_court);
  $('#sumLong').innerHTML = markdown(c.resume_detaille);
  $('#sumSynth').innerHTML = markdown(a.synthesis);
  $('#sumPlan').innerHTML = `<div class="plan"><ol>${(c.plan || []).map((p) => {
    const t0 = Math.min(...p.sections.map((s) => a.sections[s]?.start ?? Infinity));
    return `<li><b>${esc(p.titre)}</b> ${Number.isFinite(t0) ? tBtn(t0) : ''}<ul>${(p.sous_parties || []).map((x) => `<li>${esc(x)}</li>`).join('')}
      ${p.sections.map((s) => a.sections[s] ? `<li>${tBtn(a.sections[s].start)} ${esc(a.sections[s].titre)}</li>` : '').join('')}</ul></li>`;
  }).join('')}</ol></div>`;
  $('#sumSections').innerHTML = a.sections.map((r) => `<div class="sec-card">
      <h4>${r.section + 1}. ${esc(r.titre)} ${tBtn(r.start)}</h4><p>${esc(r.resume)}</p>
      <ul>${(r.points_cles || []).slice(0, 6).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${r.units?.length ? `<div class="slide-times">${r.units.slice(0, 6).map((u) => S.unitsById[u] ? `<button class="chip-t slide" data-unit="${u}">${UNIT_LABEL[S.unitsById[u].kind] || ''} ${S.unitsById[u].n}</button>` : '').join('')}</div>` : ''}
    </div>`).join('');
}

/* --------------------------------------------------------------- notions */

function renderNotions() {
  const a = S.data.analysis;
  if (!a) { $('#gloss').innerHTML = '<p class="muted">Disponible après l’analyse.</p>'; $('#formulas').innerHTML = ''; $('#examples').innerHTML = ''; $('#keep').innerHTML = ''; return; }
  const q = $('#glossFilter').value.trim().toLowerCase();
  const g = a.glossary.filter((x) => !q || x.terme.toLowerCase().includes(q) || x.definition.toLowerCase().includes(q));
  $('#gloss').innerHTML = g.map((x) => `<div class="gl-item"><h4>${esc(x.terme)} ${tBtn(x.t)}</h4><p>${esc(x.definition)}</p></div>`).join('') || '<p class="muted">Aucune notion.</p>';
  $('#formulas').innerHTML = `<div class="list-items">${a.formulas.map((f) => `<div class="li-row">${tBtn(f.t)}<div><code>${esc(f.formule)}</code><span class="muted">${esc(f.explication)}</span></div></div>`).join('') || '<p class="muted">Aucune formule.</p>'}</div>`;
  $('#examples').innerHTML = `<div class="list-items">${a.examples.map((e) => `<div class="li-row">${tBtn(e.t)}<div>${esc(e.exemple)}</div></div>`).join('') || '<p class="muted">Aucun exemple relevé.</p>'}</div>`;
  $('#keep').innerHTML = `<div class="list-items">${a.keep.map((k) => `<div class="li-row">${tBtn(k.t)}<div>${esc(k.point)}</div></div>`).join('') || '<p class="muted">Rien de souligné explicitement.</p>'}</div>`;
}

/* ----------------------------------------------------------- croisement */

const TYPE_LABEL = { contradiction: 'Contradiction', difference: 'Différence', ajout_oral: 'Ajout oral', non_explique: 'Non expliqué' };

function renderCross() {
  const a = S.data.analysis;
  const units = S.data.units || [];
  const cross = a?.cross;
  if (!units.length) {
    $('#crossTiles').innerHTML = '';
    $('#crossDiff').innerHTML = '<p class="muted">Ajoutez un support de cours (diaporama, PDF…) pour croiser l’oral et l’écrit.</p>';
    $('#crossOral').innerHTML = ''; $('#crossCoverage').innerHTML = '';
    return;
  }
  const cov = unitCoverage();
  const covVals = Object.values(cov);
  const avgCov = covVals.length ? covVals.reduce((x, y) => x + y, 0) / covVals.length : null;
  const covered = covVals.filter((v) => v >= 0.55).length;
  const ec = cross?.ecarts || [];
  const tile = (label, value, sub, q) => `<div class="tile${q != null ? ' has-q' : ''}" ${q != null ? `style="--qc:${qColor(q, 0.55)}"` : ''}><span>${esc(label)}</span><b>${esc(value)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}${q != null ? `<small class="qs"><i style="background:${qColor(q)}"></i>${qLabel(q)}</small>` : ''}</div>`;
  $('#crossTiles').innerHTML = [
    tile('Support couvert à l’oral', covVals.length ? `${Math.round((covered / covVals.length) * 100)} %` : '—', `${covered} / ${covVals.length} unités`, covVals.length ? lin(covered / covVals.length, 0.4, 0.9) : null),
    tile('Contradictions', String(ec.filter((e) => e.type === 'contradiction').length), 'oral ≠ support', a ? lin(ec.filter((e) => e.type === 'contradiction').length, 5, 0) : null),
    tile('Différences', String(ec.filter((e) => e.type === 'difference').length), 'formulation, valeur…'),
    tile('Ajouts à l’oral', String(ec.filter((e) => e.type === 'ajout_oral').length + (cross?.oral_absent_support?.length || 0)), 'absents du support'),
    tile('Lignes du support non expliquées', String(cross?.support_non_explique?.length ?? (S.data.index?.coverage || []).filter((c) => c.score < 0.48).length), 'à revoir dans le support'),
    tile('Similarité moyenne', avgCov != null ? avgCov.toFixed(2) : '—', 'oral ↔ support', avgCov != null ? lin(avgCov, 0.45, 0.72) : null),
  ].join('');
  $('#crossDiff').innerHTML = cross ? (`<div class="list-items">${ec.filter((e) => e.type !== 'ajout_oral').map((e) => `<div class="li-row">${tBtn(e.t)}<div><span class="tag ${e.type}">${TYPE_LABEL[e.type] || e.type}</span>
      ${e.diapositive ? ` <span class="muted">diapo/page ${e.diapositive}</span>` : ''}<div>${esc(e.detail)}</div></div></div>`).join('') || '<p class="muted">Aucune contradiction ni différence relevée.</p>'}</div>`)
    : '<p class="muted">Disponible après l’analyse par le LLM.</p>';
  const oral = [...ec.filter((e) => e.type === 'ajout_oral').map((e) => ({ t: e.t, txt: e.detail })), ...(cross?.oral_absent_support || []).map((g) => ({ t: g.t, txt: `${g.terme} — ${g.definition}` }))];
  $('#crossOral').innerHTML = cross ? (`<div class="list-items">${oral.map((o) => `<div class="li-row">${tBtn(o.t)}<div>${esc(o.txt)}</div></div>`).join('') || '<p class="muted">Rien d’important hors support.</p>'}</div>`) : '<p class="muted">Disponible après l’analyse par le LLM.</p>';

  // Couverture par diapositive / page.
  const byUnit = {};
  for (const c of S.data.index?.coverage || []) (byUnit[c.unit] ||= []).push(c);
  const times = S.data.index?.unit_times || {};
  $('#crossCoverage').innerHTML = units.map((u) => {
    const lines = byUnit[u.id] || [];
    const c = cov[u.id];
    const q = c != null ? lin(c, 0.45, 0.72) : null;
    const weak = lines.filter((l) => l.score < 0.48).sort((x, y) => x.score - y.score);
    return `<div class="cov-unit">
      <div class="cu-thumb" data-unit="${u.id}">${u.image ? `<img loading="lazy" src="${fileUrl(u.image)}" alt="">` : `<div class="thumb txt">${u.n}</div>`}</div>
      <div><h4>${UNIT_LABEL[u.kind] || ''} ${u.n} — ${esc(u.title).slice(0, 90)}
        ${q != null ? `<span class="tag" style="background:${qColor(q, 0.2)};color:${qColor(q)}">${Math.round(c * 100)} % · ${qLabel(q)}</span>` : ''}
        ${(times[u.id] || []).slice(0, 4).map(([a2]) => tBtn(a2)).join(' ')}</h4>
        ${weak.slice(0, 5).map((l) => `<div class="cov-line"><span>${esc(l.line)}</span><span class="hb-track"><i style="display:block;height:100%;border-radius:99px;width:${Math.max(4, l.score * 100)}%;background:${qColor(lin(l.score, 0.3, 0.6))}"></i></span><span class="muted">peu expliqué</span></div>`).join('')}
      </div></div>`;
  }).join('');
}

/* -------------------------------------------------------------- révision */

function renderQA() {
  const a = S.data.analysis;
  $('#qa').innerHTML = a?.qa?.length ? a.qa.map((q, i) => `<div class="card-qa">
      <h4>${i + 1}. ${esc(q.question)}</h4><div class="ans">${esc(q.reponse)}</div>
      <div class="qa-foot">${tBtn(q.t)}<span><button class="k" data-k="ok">Je savais</button> <button class="k" data-k="ko">À revoir</button></span></div></div>`).join('')
    : '<p class="muted">Les questions de révision sont générées pendant l’analyse.</p>';
  updateScore();
}

function updateScore() {
  const ok = $$('.card-qa.ok').length, ko = $$('.card-qa.ko').length;
  $('#qaScore').textContent = ok + ko ? `${ok} su · ${ko} à revoir` : '';
}

/* -------------------------------------------------------------- recherche */

async function runSearch() {
  const q = $('#searchInput').value.trim();
  if (!q) return;
  const box = $('#results');
  box.innerHTML = '<p class="muted">Recherche…</p>';
  try {
    const res = await api(`/api/projects/${encodeURIComponent(S.pid)}/search?q=${encodeURIComponent(q)}&kind=${$('#searchKind').value}&k=15`);
    box.innerHTML = res.map((r) => r.kind === 'audio'
      ? `<div class="res" data-start="${r.start}"><div class="rk"><b>${fmt(r.start)}</b>${esc(r.speaker || '')}<span>Transcription</span></div>
          <div><p>${highlight(r.text, q)}</p></div></div>`
      : `<div class="res" data-u="${esc(r.unit)}"><div class="rk">${r.image ? `<img loading="lazy" src="${fileUrl(r.image)}" alt="">` : ''}<span>${UNIT_LABEL[r.unit_kind] || ''} ${r.n}</span></div>
          <div><h4>${esc(r.title)} <span class="muted">· ${esc(r.doc_name)}</span></h4><p>${highlight(r.text.slice(0, 600), q)}</p>
          ${(S.data.index?.unit_times?.[r.unit] || []).slice(0, 4).map(([a]) => tBtn(a)).join(' ')}</div></div>`).join('') || '<p class="muted">Aucun résultat.</p>';
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

/* ------------------------------------------------------------------ chat */

function renderAnswer(text, sources) {
  let html = markdown(text);
  html = html.replace(/\[S(\d+)\]/g, (m, n) => {
    const s = sources[Number(n) - 1];
    if (!s) return m;
    return s.kind === 'audio' ? `<button class="cite" data-t="${fmt(s.start)}" title="${esc(s.label)}">S${n}</button>`
      : `<button class="cite" data-unit="${esc(s.unit)}" title="${esc(s.label)}">S${n}</button>`;
  });
  return html;
}

async function sendChat() {
  const input = $('#chatInput');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  const log = $('#chatLog');
  log.insertAdjacentHTML('beforeend', `<div class="msg user"><div class="bubble">${esc(question)}</div></div>`);
  const bot = document.createElement('div');
  bot.className = 'msg bot';
  bot.innerHTML = '<div class="bubble typing">Recherche dans le cours…</div>';
  log.append(bot);
  log.scrollTop = log.scrollHeight;
  const bubble = bot.firstElementChild;
  let text = '', sources = [];
  try {
    const r = await fetch(`${API}/api/projects/${encodeURIComponent(S.pid)}/chat`, jsonOpts('POST', { question, history: S.chat }));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k);
        buf = buf.slice(k + 2);
        const ev = (block.match(/^event: (.*)$/m) || [])[1] || 'message';
        const data = (block.match(/^data: (.*)$/m) || [])[1];
        if (data == null) continue;
        if (ev === 'sources') sources = JSON.parse(data);
        else if (ev === 'error') throw new Error(JSON.parse(data));
        else if (ev === 'message') {
          text += JSON.parse(data);
          bubble.innerHTML = renderAnswer(text, sources);
          log.scrollTop = log.scrollHeight;
        }
      }
    }
    bubble.classList.remove('typing');
    bubble.insertAdjacentHTML('beforeend', `<div class="srcs">${sources.map((s, i) => s.kind === 'audio'
      ? `<button data-t="${fmt(s.start)}"><b>S${i + 1}</b>${esc(s.label)}</button>` : `<button data-unit="${esc(s.unit)}"><b>S${i + 1}</b>${esc(s.label)}</button>`).join('')}</div>`);
    S.chat.push({ role: 'user', content: question }, { role: 'assistant', content: text });
  } catch (e) {
    bubble.classList.remove('typing');
    bubble.textContent = `Erreur : ${e.message}`;
  }
}

/* ---------------------------------------------------------------- export */

async function doExport(format) {
  const note = $('#exportNote');
  note.textContent = 'Génération…';
  try {
    const r = await fetch(`${API}/api/projects/${encodeURIComponent(S.pid)}/export`, jsonOpts('POST', { format, transcript: $('#expTranscript').checked }));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const blob = await r.blob();
    const name = (r.headers.get('content-disposition') || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)/)?.[1];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name ? decodeURIComponent(name) : `cours.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
    note.textContent = 'Fichier enregistré (une copie est aussi dans le dossier exports du cours).';
  } catch (e) { note.textContent = `Erreur : ${e.message}`; }
}

boot();
