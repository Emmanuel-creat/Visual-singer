/**
 * identify-panel.js — Affichage de l'identification des sons :
 * source actuelle, scores par catégorie, candidats, journal des détections.
 */
import { CATEGORIES } from './sound-labels.js';
import { formatClock } from './utils.js';
import { icon } from './icons.js';

const $ = (sel) => document.querySelector(sel);
const pct = (x) => `${Math.round(x * 100)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class IdentifyPanel {
  constructor({ recognizer, transport, settings, store }) {
    this.rec = recognizer;
    this.transport = transport;
    this.settings = settings;
    this.store = store;
    this.past = [];            // détections des sessions précédentes du jour (Bureau)
    this._listDirty = true;

    this._buildCategories();
    this._bind();
    this._renderState({ state: recognizer.state, message: recognizer.message });
  }

  _buildCategories() {
    const box = $('#catRows');
    box.innerHTML = Object.entries(CATEGORIES).map(([k, c]) => `
      <div class="cat-row" data-cat="${k}" style="--cat:${c.color}">
        <span class="ci">${icon(c.icon, c.color)}</span><span class="cl">${c.label}</span>
        <div class="bar"><i></i></div><b>0%</b>
      </div>`).join('');
  }

  _bind() {
    const r = this.rec;
    r.on('state', (e) => this._renderState(e));
    r.on('result', (res) => this._renderResult(res));
    for (const ev of ['detection', 'update', 'final']) r.on(ev, () => { this._listDirty = true; this._renderMain(); });
    $('#btnRecog').addEventListener('click', () => {
      if (r.running) this.settings.set('recogEnabled', false);
      else if (this.settings.get('recogEnabled')) r.start();
      else this.settings.set('recogEnabled', true);
    });
    $('#detList').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-start]');
      if (li) this.transport.seek(Number(li.dataset.start) - 1);
    });
    for (const b of document.querySelectorAll('[data-tab]')) {
      b.addEventListener('click', () => {
        for (const x of document.querySelectorAll('[data-tab]')) { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); }
        for (const p of document.querySelectorAll('[data-tab-pane]')) p.hidden = p.dataset.tabPane !== b.dataset.tab;
      });
    }
    $('#btnGeo')?.addEventListener('click', () => this._locate());
    r.on('location', ({ species }) => { $('#geoNote').textContent = `${species} espèces plausibles ici cette semaine.`; });
    setInterval(() => { if (this._listDirty) this._renderList(); }, 500);
  }

  setPast(items) {
    this.past = items || [];
    this._listDirty = true;
  }

  _locate() {
    const note = $('#geoNote');
    if (!navigator.geolocation) { note.textContent = 'Géolocalisation non disponible dans ce navigateur.'; return; }
    note.textContent = 'Localisation…';
    navigator.geolocation.getCurrentPosition((pos) => {
      this.settings.set('latitude', +pos.coords.latitude.toFixed(3));
      this.settings.set('longitude', +pos.coords.longitude.toFixed(3));
      this.settings.set('useLocation', true);
      note.textContent = `Position : ${pos.coords.latitude.toFixed(3)}, ${pos.coords.longitude.toFixed(3)}`;
    }, (err) => { note.textContent = `Position refusée ou indisponible (${err.message}). Saisissez-la à la main.`; }, { timeout: 10000 });
  }

  _renderState({ state, message, progress, running }) {
    const r = this.rec;
    const dot = $('#idDot'), st = $('#idState'), btn = $('#btnRecog'), prog = $('#idProgress');
    const isRunning = running ?? r.running;
    dot.className = `dot ${state === 'ready' && isRunning ? 'on' : state === 'loading' ? 'warn' : state === 'error' ? 'err' : ''}`;
    st.textContent = state === 'loading' ? 'Chargement' : state === 'error' ? 'Erreur' : state === 'ready' ? (isRunning ? 'Active' : 'En pause') : 'Inactive';
    prog.hidden = state !== 'loading';
    if (state === 'loading') {
      prog.querySelector('i').style.transform = `scaleX(${progress ?? 0})`;
      prog.querySelector('span').textContent = message;
    }
    btn.disabled = state === 'loading';
    btn.innerHTML = state === 'loading' ? 'Chargement des modèles…'
      : isRunning ? `${icon('pauseBtn', 'var(--accent)', { tile: false })} Mettre en pause`
      : state === 'error' ? `${icon('refresh', 'var(--accent)', { tile: false })} Réessayer`
      : `${icon('play', 'var(--accent)', { tile: false })} Activer l'identification`;
    if (state === 'error') { $('#idName').textContent = 'Modèles indisponibles'; $('#idSci').textContent = message; }
  }

  _renderResult(res) {
    const rows = document.querySelectorAll('.cat-row');
    for (const row of rows) {
      const v = res.categories?.[row.dataset.cat] || 0;
      row.querySelector('i').style.transform = `scaleX(${Math.min(1, v).toFixed(3)})`;
      row.querySelector('b').textContent = pct(v);
    }
    const alts = [...(res.bird || []).filter((b) => !b.special).slice(0, 2), ...(res.top || []).slice(0, 3)];
    $('#idAlt').innerHTML = res.silent ? '<span class="muted">Silence</span>'
      : alts.map((c) => `<span class="chip" style="--cat:${CATEGORIES[c.category].color}">${icon(CATEGORIES[c.category].icon, CATEGORIES[c.category].color)} ${esc(c.label)} <b>${pct(c.score)}</b></span>`).join('');
    this._renderMain();
  }

  /** Source affichée : détection en cours la plus récente, sinon indication d'écoute. */
  currentSource() {
    const open = this.rec.detections.filter((d) => d.open);
    return open.length ? open.reduce((a, b) => (b.end > a.end ? b : a)) : null;
  }

  _renderMain() {
    const d = this.currentSource();
    const main = $('#idMain');
    if (d) {
      const c = CATEGORIES[d.category];
      main.dataset.cat = d.category;
      main.style.setProperty('--cat', c.color);
      $('#idIcon').innerHTML = icon(c.icon, c.color);
      $('#idName').textContent = d.label;
      $('#idSci').textContent = d.sci ? d.sci : `${c.label}${d.en && d.en !== d.label ? ` · ${d.en}` : ''}`;
      $('#idConf').textContent = pct(d.confidence);
      return;
    }
    main.dataset.cat = '';
    main.style.removeProperty('--cat');
    const res = this.rec.current;
    $('#idIcon').innerHTML = icon('wave', 'rgba(228,228,231,0.35)');
    $('#idConf').textContent = '';
    if (this.rec.state !== 'ready' || !this.rec.running) {
      if (this.rec.state !== 'error') { $('#idName').textContent = 'Identification inactive'; $('#idSci').textContent = 'Connectez le micro puis activez-la'; }
    } else if (!res || res.silent) {
      $('#idName').textContent = 'Écoute…'; $('#idSci').textContent = 'Aucun son suffisamment fort';
    } else {
      const best = res.top[0];
      $('#idName').textContent = 'Écoute…';
      $('#idSci').textContent = best ? `peut-être : ${best.label} (${pct(best.score)})` : '';
    }
  }

  _renderList() {
    this._listDirty = false;
    const ul = $('#detList');
    const live = this.rec.detections.slice().reverse();
    $('#detCount').textContent = String(live.length + this.past.length);
    if (!live.length && !this.past.length) {
      ul.innerHTML = '<li class="empty">Aucune détection pour l’instant</li>';
      return;
    }
    const item = (d, isPast) => {
      const c = CATEGORIES[d.category] || CATEGORIES.other;
      const when = isPast ? (d.heure || '') : formatClock(d.start, 0);
      const dur = isPast ? d.duration : d.end - d.start;
      return `<li ${isPast ? 'class="past" title="Session précédente"' : `data-start="${d.start}" title="Revoir cet instant"`} style="--cat:${c.color}">
        <span class="di">${icon(c.icon, c.color)}</span>
        <span class="dn"><b>${esc(d.label)}</b><small>${esc(d.sci || c.label)}</small></span>
        <span class="dm"><b>${pct(d.confidence)}</b><small>${when} · ${Math.max(1, Math.round(dur))} s</small></span>
        ${d.open ? '<span class="live-pip"></span>' : ''}
      </li>`;
    };
    ul.innerHTML = live.map((d) => item(d, false)).join('')
      + (this.past.length ? `<li class="sep">Plus tôt aujourd'hui</li>${this.past.slice().reverse().map((d) => item(d, true)).join('')}` : '');
  }
}
