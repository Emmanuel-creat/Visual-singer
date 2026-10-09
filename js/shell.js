/**
 * shell.js : Comportements communs aux trois applications :
 *   - dialogues accessibles (remplacent alert / confirm / prompt) ;
 *   - notifications annoncées aux lecteurs d'écran, avec action « Annuler » ;
 *   - onglets accessibles (flèches du clavier) synchronisés avec l'URL (bouton Retour) ;
 *   - aide des raccourcis clavier (touche « ? ») ;
 *   - fermeture complète du logiciel (serveurs locaux, modèles d'IA en mémoire).
 */
import { icon, hydrateIcons } from './icons.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const ENGINE = location.port === '8091' ? '' : 'http://127.0.0.1:8091';

/** Application de bureau (app.py, fenêtre pywebview) : API Python exposée, sinon null. */
export const desktop = () => window.pywebview?.api || null;

/**
 * Signale une activité à protéger (ex. enregistrement de nuit) : en version bureau,
 * fermer la fenêtre demande alors confirmation. message = null pour lever la protection.
 */
let busyMessage = null;
export function setBusy(message) {
  busyMessage = message || null;
  desktop()?.set_busy(busyMessage);
}
window.addEventListener('pywebviewready', () => { if (busyMessage) desktop()?.set_busy(busyMessage); });

/* ------------------------------------------------------------- notifications */

function region() {
  let r = $('#toastRegion');
  if (!r) {
    r = document.createElement('div');
    r.id = 'toastRegion';
    r.className = 'toast-region';
    r.setAttribute('role', 'status');
    r.setAttribute('aria-live', 'polite');
    document.body.append(r);
  }
  return r;
}

/**
 * Notification brève. type : 'info' | 'ok' | 'err'. action : { label, run } (ex. Annuler).
 */
export function toast(message, { type = 'info', action = null, timeout = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = `ux-toast ${type}`;
  if (type === 'err') el.setAttribute('role', 'alert');
  const span = document.createElement('span');
  span.textContent = message;
  el.append(span);
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn btn-ghost';
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { el.remove(); action.run(); });
    el.append(b);
  }
  region().append(el);
  setTimeout(() => el.remove(), action ? Math.max(timeout, 8000) : timeout);
  return el;
}

/* ------------------------------------------------------------------ dialogues */

function openDialog(html, setup) {
  const d = document.createElement('dialog');
  d.className = 'ux-dialog';
  d.innerHTML = html;
  document.body.append(d);
  hydrateIcons(d);
  return new Promise((resolve) => {
    let result = null;
    const done = (v) => { result = v; d.close(); };
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    d.addEventListener('cancel', () => { result = null; });
    setup?.(d, done);
    d.showModal();
  });
}

/** Confirmation explicite avant une action importante. Renvoie true / false. */
export async function confirmDialog({ title, message, confirmLabel = 'Confirmer', cancelLabel = 'Annuler', danger = false, extra = '' }) {
  const r = await openDialog(`
    <form method="dialog">
      <h2>${esc(title)}</h2>
      ${message ? `<p>${esc(message)}</p>` : ''}${extra}
      <div class="actions">
        <button type="button" class="btn btn-ghost" data-cancel>${esc(cancelLabel)}</button>
        <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok autofocus>${esc(confirmLabel)}</button>
      </div>
    </form>`, (d, done) => {
    d.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    d.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const values = Object.fromEntries([...d.querySelectorAll('input[type=checkbox][name]')].map((c) => [c.name, c.checked]));
      done({ ok: true, values });
    });
  });
  return r || { ok: false, values: {} };
}

/**
 * Saisie d'un texte (remplace prompt). Champ libellé, obligatoire si required,
 * erreur affichée sous le champ, saisie conservée.
 */
export async function promptDialog({ title, label, value = '', hint = '', required = true, confirmLabel = 'Enregistrer', maxLength = 120 }) {
  return openDialog(`
    <form method="dialog" novalidate>
      <h2>${esc(title)}</h2>
      <label class="field" for="uxPrompt">${esc(label)}${required ? ' <span aria-hidden="true">*</span>' : ''}
        <input id="uxPrompt" name="v" type="text" maxlength="${maxLength}" value="${esc(value)}" ${required ? 'required aria-required="true"' : ''}
          aria-describedby="uxPromptHint uxPromptErr" autocomplete="off">
      </label>
      ${hint ? `<span class="hint" id="uxPromptHint">${esc(hint)}</span>` : '<span id="uxPromptHint" hidden></span>'}
      <span class="error" id="uxPromptErr" hidden></span>
      <div class="actions">
        <button type="button" class="btn btn-ghost" data-cancel>Annuler</button>
        <button type="submit" class="btn btn-primary">${esc(confirmLabel)}</button>
      </div>
    </form>`, (d, done) => {
    const input = d.querySelector('input');
    const err = d.querySelector('#uxPromptErr');
    setTimeout(() => { input.focus(); input.select(); }, 30);
    d.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    d.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (required && !v) {
        err.textContent = 'Ce champ est obligatoire : saisissez un nom pour continuer.';
        err.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      done(v);
    });
  });
}

/* ------------------------------------------------------------------- onglets */

/**
 * Onglets accessibles : rôles ARIA, flèches gauche/droite, Début/Fin, état dans l'URL
 * (le bouton Retour du navigateur revient à l'onglet précédent).
 * @param {HTMLElement} list    conteneur des boutons [data-tab]
 * @param {(name) => void} onChange
 */
export function bindTabs(list, onChange, { param = 'tab' } = {}) {
  const tabs = [...list.querySelectorAll('[data-tab]')];
  list.setAttribute('role', 'tablist');
  for (const t of tabs) {
    t.setAttribute('role', 'tab');
    t.id ||= `tab-${t.dataset.tab}`;
    const pane = document.querySelector(`[data-pane="${t.dataset.tab}"]`);
    if (pane) {
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', t.id);
      pane.tabIndex = -1;
    }
  }
  const select = (name, { push = true, focus = false } = {}) => {
    if (!tabs.some((t) => t.dataset.tab === name)) name = tabs[0].dataset.tab;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      t.classList.toggle('on', on);
      if (on && focus) t.focus();
    }
    if (push) setHashParam(param, name);
    onChange(name);
  };
  list.addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) select(t.dataset.tab); });
  list.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const go = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (go === undefined) return;
    e.preventDefault();
    select(tabs[(go + tabs.length) % tabs.length].dataset.tab, { focus: true });
  });
  window.addEventListener('hashchange', () => {
    const want = hashParams().get(param) || tabs[0].dataset.tab;   // pas de paramètre : onglet par défaut
    if (list.querySelector(`[data-tab="${want}"][aria-selected="false"]`)) select(want, { push: false });
  });
  return { select, current: () => tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.tab };
}

export function hashParams() { return new URLSearchParams(location.hash.slice(1)); }
export function setHashParam(key, value) {
  const p = hashParams();
  if (value == null || value === '') p.delete(key); else p.set(key, value);
  const next = `#${p.toString()}`;
  if (next !== location.hash) history.pushState(null, '', next);
}

/* ------------------------------------------------------- raccourcis clavier */

const GLOBAL_SHORTCUTS = [
  ['?', 'Afficher cette aide'],
  ['Tab / Maj+Tab', 'Passer d’un élément interactif à l’autre'],
  ['← / → (sur les onglets)', 'Changer d’onglet'],
  ['Échap', 'Fermer une fenêtre de dialogue'],
];

export function showShortcuts(appShortcuts = []) {
  const rows = (list) => list.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join('');
  return openDialog(`
    <form method="dialog">
      <h2>Raccourcis clavier</h2>
      <table>
        ${appShortcuts.length ? `<tr><td colspan="2" class="sc-group">Cette application</td></tr>${rows(appShortcuts)}` : ''}
        <tr><td colspan="2" class="sc-group">Partout</td></tr>${rows(GLOBAL_SHORTCUTS)}
      </table>
      <div class="actions"><button type="submit" class="btn btn-primary" autofocus>Fermer</button></div>
    </form>`, (d, done) => d.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); done(true); }));
}

/* ------------------------------------------------------ fermer le logiciel */

async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return r.ok;
  } catch { return false; }
}

async function engineStatus() {
  try {
    const r = await fetch(`${ENGINE}/api/system`, { cache: 'no-store' });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

/** Ferme complètement le logiciel : serveur des pages, moteur Cours, modèles d'IA. */
export async function quitSoftware({ beforeQuit } = {}) {
  const sys = await engineStatus();
  const busy = sys?.runner?.current;
  const res = await confirmDialog({
    title: 'Quitter Visual Singer ?',
    message: 'Les serveurs locaux s’arrêtent et la mémoire (RAM et GPU) est libérée. Vos cours, nuits, réglages et détections sont déjà enregistrés sur le Bureau.',
    extra: `${busy ? '<p><strong>Une analyse de cours est en cours.</strong> Elle reprendra automatiquement au prochain lancement de Cours.</p>' : ''}
      <label class="check"><input type="checkbox" name="ollama" checked> Arrêter aussi Ollama (modèles de langage), libère la mémoire du GPU</label>`,
    confirmLabel: 'Quitter le logiciel',
    danger: true,
  });
  if (!res.ok) return;
  await beforeQuit?.();
  setBusy(null);
  const stopOllama = !!res.values.ollama;
  // Moteur Cours (port 8091) puis serveur des pages (port 8080) s'il sert cette page.
  if (sys) await post(`${ENGINE}/api/shutdown`, { ollama: stopOllama });
  if (location.port !== '8091') await post('api/shutdown', { ollama: stopOllama && !sys });
  if (desktop()) { await desktop().close_all(); return; }   // version bureau : toutes les fenêtres se ferment
  else await fetch('http://127.0.0.1:8080/api/shutdown', { method: 'POST', mode: 'no-cors', body: '{}' }).catch(() => {});   // serveur des pages (port 8080)
  document.body.innerHTML = `
    <main class="closed-screen" id="main">
      <div>
        <h1>Visual Singer est fermé</h1>
        <p>Les serveurs locaux sont arrêtés${stopOllama ? ' et les modèles d’IA déchargés' : ''}. Vous pouvez fermer cet onglet.</p>
        <p>Pour relancer : raccourcis « Visual Singer » du Bureau.</p>
      </div>
    </main>`;
  document.title = 'Visual Singer - fermé';
  setTimeout(() => window.close(), 400);   // ne fonctionne que si l'onglet a été ouvert par le logiciel
}

/* ------------------------------------------------------------- initialisation */

/**
 * @param {{ shortcuts?: [string, string][], beforeQuit?: () => Promise<void> }} o
 */
export function initShell(o = {}) {
  hydrateIcons(document.querySelector('header') || document);
  document.querySelectorAll('[data-quit]').forEach((b) => b.addEventListener('click', () => quitSoftware(o)));
  document.querySelectorAll('[data-shortcuts]').forEach((b) => b.addEventListener('click', () => showShortcuts(o.shortcuts)));
  window.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    showShortcuts(o.shortcuts);
  });
  region();
  linkAcrossServers();

  // Version bureau : chaque application a sa propre fenêtre.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    const api = desktop();
    if (!a || !api || e.defaultPrevented) return;
    const url = new URL(a.href, location.href);
    const page = url.pathname.split('/').pop() || 'index.html';
    if (url.origin !== location.origin || !APP_PAGES.includes(page)) return;
    if (url.pathname === location.pathname) return;          // même page (ancre, fil d'Ariane) : navigation normale
    e.preventDefault();
    api.open_app(page);
  });
  // Fermeture de la fenêtre (croix) avec une activité en cours : confirmation dans la page.
  window.vsRequestClose = async (engineBusy) => {
    if (document.querySelector('dialog[open]')) return;
    if (engineBusy) { await quitSoftware(o); return; }
    const r = await confirmDialog({ title: 'Fermer cette fenêtre ?', message: busyMessage, confirmLabel: 'Arrêter et fermer', danger: true });
    if (!r.ok) return;
    await o.beforeQuit?.();
    setBusy(null);
    await desktop()?.close_window();
  };
  if (desktop() || 'pywebview' in window) document.documentElement.classList.add('is-desktop');
  window.addEventListener('pywebviewready', () => document.documentElement.classList.add('is-desktop'));
}

const APP_PAGES = ['index.html', 'detecteur.html', 'sommeil.html', 'cours.html'];

/**
 * Page servie par le moteur Cours (port 8091) : les autres applications ont besoin du
 * serveur des pages (port 8080, sauvegardes Bureau), liens réécrits s'il répond.
 */
async function linkAcrossServers() {
  if (location.port !== '8091') return;
  try { await fetch('http://127.0.0.1:8080/api/info', { mode: 'no-cors', cache: 'no-store' }); } catch { return; }
  for (const a of document.querySelectorAll('.shell-brand, .app-switch a:not([aria-current])')) {
    const href = a.getAttribute('href');
    if (href && !/^https?:/.test(href)) a.href = `http://localhost:8080/${href}`;
  }
}

export { icon };
