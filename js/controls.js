/**
 * controls.js — Interface : boutons, panneaux, paramètres, couleurs, raccourcis, affichages.
 *
 * Aucune logique audio ou 3D ici : ce module relie le DOM aux autres
 * modules (settings, theme, audio, transport, visualizer, server).
 */
import { COLOR_KEYS, PRESETS } from './theme.js';
import { TRAIL_MODES } from './visualizer.js';
import { SPEEDS } from './transport.js';
import { clamp, formatClock, formatFreq, formatOffset, noteName, hexToRgb } from './utils.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const FORMATS = {
  smoothing: (v) => v.toFixed(2),
  minDb: (v) => `${v} dB`,
  maxDb: (v) => `${v} dB`,
  heightScale: (v) => `${v.toFixed(2)}×`,
  trailLength: (v) => `${v} s`,
  peakThreshold: (v) => `${Math.round(v * 100)}%`,
  autoRotateSpeed: (v) => v.toFixed(2),
  soundMinConf: (v) => `${Math.round(v * 100)}%`,
  birdMinConf: (v) => `${Math.round(v * 100)}%`,
};
const VIEW_CYCLE = ['3D', 'TOP', 'FRONT', 'SIDE'];

export class UI {
  constructor(ctx) {
    Object.assign(this, ctx); // settings, theme, audio, history, transport, viz, timeline, server
    this.app = $('#app');
    this.view = '3D';
    this.drawer = null;
    this._acc = 0;
    this._peakItems = [];

    this._bindSettings();
    this._bindTransport();
    this._bindCamera();
    this._bindMic();
    this._bindDrawer();
    this._bindColors();
    this._bindServer();
    this._bindKeyboard();
    this._bindMisc();
    this._applyLayoutSettings();
    this.onTransport();
    this.onAudioState({ state: this.audio.state });
  }

  /* --------------------------------------------------------- Paramètres --- */

  /** Relie automatiquement chaque élément [data-setting] à settings. */
  _bindSettings() {
    const s = this.settings;
    const refresh = (key) => {
      for (const el of $$(`[data-setting="${key}"]`)) {
        const v = s.get(key);
        if (el.type === 'checkbox') el.checked = !!v;
        else if (document.activeElement !== el || el.type === 'range') {
          if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === String(v))) {
            const o = document.createElement('option');
            o.value = String(v); o.textContent = String(v);
            el.appendChild(o);
          }
          el.value = String(v);
        }
      }
      for (const out of $$(`output[data-for="${key}"]`)) {
        const v = s.get(key);
        out.textContent = FORMATS[key] ? FORMATS[key](v) : String(v);
      }
      if (key === 'trailMode' || key === 'trailLength') {
        const persistent = s.get('trailMode') === 'persistent';
        for (const el of $$('[data-setting="trailLength"]')) el.disabled = persistent || s.get('trailMode') === 'none';
        for (const out of $$('output[data-for="trailLength"]')) if (persistent) out.textContent = '∞';
      }
    };
    const keys = new Set($$('[data-setting]').map((el) => el.dataset.setting));
    for (const key of keys) refresh(key);
    refresh('trailMode');

    for (const el of $$('[data-setting]')) {
      const key = el.dataset.setting;
      const handler = () => {
        let v = el.type === 'checkbox' ? el.checked : el.value;
        if (el.type === 'number') {
          v = Number(v);
          if (!Number.isFinite(v)) return;
          if (el.min !== '') v = Math.max(Number(el.min), v);
          if (el.max !== '') v = Math.min(Number(el.max), v);
        }
        s.set(key, v);
      };
      el.addEventListener(el.type === 'range' ? 'input' : 'change', handler);
    }
    s.on('change', ({ key }) => {
      refresh(key);
      if (key === 'trailMode') {
        const m = TRAIL_MODES[s.get('trailMode')];
        if (m && Number.isFinite(m.length) && m.length > 0) s.set('trailLength', m.length);
      }
      if (key === 'hudVisible' || key === 'sidebarCollapsed') this._applyLayoutSettings();
      if (key === 'autoRotate') $('#btnAutoRotate').classList.toggle('on', s.get('autoRotate'));
      if (['freqMin', 'bassMax', 'midMax', 'freqMax'].includes(key)) this._updateRanges();
    });
    $('#btnAutoRotate').classList.toggle('on', s.get('autoRotate'));
    this._updateRanges();
  }

  _applyLayoutSettings() {
    this.app.classList.toggle('hud-hidden', !this.settings.get('hudVisible'));
    this.app.classList.toggle('sidebar-collapsed', this.settings.get('sidebarCollapsed'));
  }

  _updateRanges() {
    const s = this.settings;
    $('#zoneRanges').textContent = `${formatFreq(s.get('bassMax'), true)} · ${formatFreq(s.get('midMax'), true)}`;
  }

  /* ---------------------------------------------------------- Transport --- */

  _bindTransport() {
    const t = this.transport;
    $('#btnPlay').addEventListener('click', () => t.togglePlay());
    $('#btnLive').addEventListener('click', () => t.goLive());
    $('#btnBack').addEventListener('click', () => t.step(-5));
    $('#btnFwdStep').addEventListener('click', () => t.step(5));
    $('#btnRewind').addEventListener('click', () => { t.shuttle(-1); this._syncSpeed(); });
    $('#btnForward').addEventListener('click', () => { t.shuttle(1); this._syncSpeed(); });
    t.on('change', () => this.onTransport());
  }

  /** Répercute la vitesse du transport dans le sélecteur SPEED. */
  _syncSpeed() {
    if (this.settings.get('playbackSpeed') !== this.transport.speed) this.settings.set('playbackSpeed', this.transport.speed);
  }

  onTransport() {
    const t = this.transport;
    const playing = t.mode === 'playing';
    $('#playIcon').textContent = playing || t.isLive ? '❚❚' : '▶';
    $('#playLabel').textContent = playing || t.isLive ? 'PAUSE' : 'PLAY';
    $('#btnLive').classList.toggle('on', t.isLive);
    $('#btnRewind').classList.toggle('on', playing && t.speed < 0);
    $('#btnForward').classList.toggle('on', playing && t.speed > 1);
    this._updateBadge();
  }

  _updateBadge() {
    const t = this.transport;
    const badge = $('#modeBadge');
    let mode = t.mode, text;
    if (!this.history.length) { mode = 'idle'; text = this.audio.active ? 'BUFFERING' : 'NO SIGNAL'; }
    else if (t.isLive) text = this.audio.active ? 'LIVE' : 'LIVE · INPUT STOPPED';
    else if (mode === 'paused') text = 'PAUSED';
    else text = t.speed < 0 ? `REWIND ${Math.abs(t.speed)}×` : `PLAYBACK ${t.speed}×`;
    badge.dataset.mode = mode;
    $('#modeText').textContent = text;
  }

  /* ------------------------------------------------------------- Caméra --- */

  _bindCamera() {
    for (const b of $$('[data-view]')) b.addEventListener('click', () => this.setView(b.dataset.view));
    $('#btnAutoRotate').addEventListener('click', () => this.settings.set('autoRotate', !this.settings.get('autoRotate')));
    $('#btnCamera').addEventListener('click', () => this.setView(VIEW_CYCLE[(VIEW_CYCLE.indexOf(this.view) + 1) % VIEW_CYCLE.length]));
    this.viz.orbit.onInteract = () => this._markView(null);
    this._markView('3D');
  }

  setView(name) {
    this.viz.setView(name);
    this._markView(name === 'RESET' ? '3D' : name);
  }

  _markView(name) {
    if (name) this.view = name;
    for (const b of $$('[data-view]')) b.classList.toggle('active', b.dataset.view === name);
    $('#camName').textContent = name || 'FREE';
  }

  /* ------------------------------------------------------------ Micro ----- */

  _bindMic() {
    const toggle = () => {
      if (this.audio.active) this.audio.stop();
      else this.audio.connectMicrophone();
    };
    $('#btnMic').addEventListener('click', toggle);
    for (const b of $$('[data-action="mic"]')) b.addEventListener('click', () => this.audio.connectMicrophone());
    for (const b of $$('[data-action="demo"]')) b.addEventListener('click', () => this.audio.startDemo());
    // Fichier audio : bouton ou glisser-déposer sur la vue 3D.
    const fileInput = $('#fileInput');
    const pick = () => fileInput.click();
    $('#btnFile').addEventListener('click', pick);
    for (const b of $$('[data-action="file"]')) b.addEventListener('click', pick);
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) this.audio.playFile(fileInput.files[0]); fileInput.value = ''; });
    const vp = $('#viewport');
    vp.addEventListener('dragover', (e) => { e.preventDefault(); vp.classList.add('drop-target'); });
    vp.addEventListener('dragleave', () => vp.classList.remove('drop-target'));
    vp.addEventListener('drop', (e) => {
      e.preventDefault();
      vp.classList.remove('drop-target');
      const f = e.dataTransfer.files[0];
      if (f) this.audio.playFile(f);
    });
    $('#btnDevices').addEventListener('click', () => this.refreshDevices());
    this.audio.on('state', (e) => this.onAudioState(e));
    this.audio.on('devices', (list) => this._fillDevices(list));
    this.audio.on('config', () => this._updateMicInfo());
    this.refreshDevices();
  }

  async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    this._fillDevices(await this.audio.listDevices());
  }

  _fillDevices(list) {
    const sel = $('#deviceSelect');
    const cur = this.settings.get('deviceId');
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = ''; def.textContent = 'Entrée par défaut';
    sel.appendChild(def);
    list.forEach((d, i) => {
      if (!d.deviceId || d.deviceId === 'default') return;
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${i + 1}`;
      sel.appendChild(o);
    });
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  }

  onAudioState({ state }) {
    const a = this.audio;
    const overlay = $('#overlay');
    const btn = $('#btnMic');
    const status = $('#micStatus');
    const dot = $('#micDot');
    const tb = $('#tbAudio');
    overlay.dataset.state = state === 'active' ? 'hidden' : state === 'error' ? 'error' : state === 'requesting' ? 'requesting' : (this.history.length ? 'hidden' : 'idle');
    btn.classList.toggle('connected', state === 'active');
    dot.className = 'dot';
    status.className = 'mic-status';
    if (state === 'active') {
      const demo = a.source === 'demo' || a.source === 'file';
      $('#btnMicLabel').textContent = a.source === 'file' ? 'STOP FILE' : demo ? 'STOP DEMO' : 'DISCONNECT';
      status.textContent = a.source === 'file' ? '● FICHIER EN LECTURE' : demo ? '● DEMO SIGNAL ACTIVE' : '● MICROPHONE ACTIVE';
      status.classList.add(demo ? 'demo' : 'on');
      dot.classList.add(demo ? 'demo' : 'on');
      tb.textContent = a.source === 'file' ? 'FILE' : demo ? 'DEMO' : 'LIVE';
      tb.dataset.state = demo ? 'demo' : 'on';
    } else {
      $('#btnMicLabel').textContent = 'CONNECT MICROPHONE';
      if (state === 'requesting') { status.textContent = '◌ EN ATTENTE D\'AUTORISATION…'; dot.classList.add('warn'); }
      else if (state === 'error') { status.textContent = `✕ ${a.error?.title?.toUpperCase() || 'ERREUR'}`; status.classList.add('err'); dot.classList.add('err'); }
      else status.textContent = '○ MICROPHONE OFF';
      tb.textContent = state === 'error' ? 'ERROR' : 'OFFLINE';
      tb.dataset.state = state === 'error' ? 'error' : 'off';
    }
    if (state === 'error' && a.error) {
      $('#errTitle').textContent = a.error.title;
      $('#errMessage').textContent = a.error.message;
      $('#errHint').textContent = a.error.hint;
      $('#errCode').textContent = a.error.code;
    }
    this._updateMicInfo();
    this._updateBadge();
  }

  _updateMicInfo() {
    const a = this.audio;
    $('#micDevice').textContent = a.active ? a.deviceLabel : '—';
    $('#micDevice').title = a.deviceLabel || '';
    $('#micRate').textContent = a.sampleRate ? `${(a.sampleRate / 1000).toFixed(1)} kHz` : '—';
    $('#micFft').textContent = a.analyser ? `${a.fftSize} · ${(a.sampleRate / a.fftSize).toFixed(1)} Hz/bin` : String(this.settings.get('fftSize'));
  }

  /* ------------------------------------------------------------ Tiroir ---- */

  _bindDrawer() {
    for (const b of $$('[data-drawer]')) b.addEventListener('click', () => this.toggleDrawer(b.dataset.drawer));
    $('#drawerClose').addEventListener('click', () => this.toggleDrawer(null));
  }

  toggleDrawer(name) {
    if (name && this.drawer === name) name = null;
    this.drawer = name;
    this.app.classList.toggle('drawer-open', !!name);
    $('#drawer').setAttribute('aria-hidden', String(!name));
    for (const p of $$('.drawer-body')) p.classList.toggle('active', p.dataset.pane === name);
    for (const b of $$('[data-drawer]')) b.classList.toggle('on', b.dataset.drawer === name);
    if (name) $('#drawerTitle').textContent = name === 'colors' ? 'COLORS' : 'SETTINGS';
    if (name === 'settings') this._updateHistoryInfo();
  }

  /* ------------------------------------------------------------ Couleurs -- */

  _bindColors() {
    const th = this.theme;
    const grid = $('#presetGrid');
    for (const [name, c] of Object.entries(PRESETS)) {
      const b = document.createElement('button');
      b.className = 'preset';
      b.dataset.preset = name;
      b.innerHTML = `<span>${name.toUpperCase()}</span><span class="swatches">${['bg', 'bass', 'mid', 'treble', 'peak', 'accent'].map((k) => `<i style="background:${c[k]}"></i>`).join('')}</span>`;
      b.addEventListener('click', () => th.apply(name));
      grid.appendChild(b);
    }
    const list = $('#colorList');
    for (const { key, label } of COLOR_KEYS) {
      const row = document.createElement('label');
      row.className = 'color-item';
      row.innerHTML = `<input type="color" data-color="${key}"><span>${label}</span><code></code>`;
      const input = row.querySelector('input');
      input.addEventListener('input', () => th.set(key, input.value));
      list.appendChild(row);
    }
    $('#btnThemeSave').addEventListener('click', () => {
      const input = $('#themeSaveName');
      if (th.saveCustom(input.value)) input.value = '';
      else input.focus();
    });
    $('#themeSaveName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnThemeSave').click(); });
    $('#btnThemeExport').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(th.toJSON()); this.toast('Thème copié dans le presse-papiers'); }
      catch { window.prompt('Copiez le thème :', th.toJSON()); }
    });
    $('#btnThemeImport').addEventListener('click', () => {
      const text = window.prompt('Collez le JSON du thème :');
      if (text && !th.fromJSON(text)) this.toast('JSON de thème invalide');
    });
    th.on('change', () => this._syncColors());
    this._syncColors();
  }

  _syncColors() {
    const th = this.theme;
    for (const input of $$('[data-color]')) {
      const v = th.colors[input.dataset.color];
      if (input.value !== v) input.value = v;
      input.parentElement.querySelector('code').textContent = v.toUpperCase();
    }
    for (const b of $$('.preset')) b.classList.toggle('active', b.dataset.preset === th.presetName);
    $('#themeName').textContent = th.presetName;
    const box = $('#customThemes');
    box.innerHTML = '';
    const names = Object.keys(th.custom);
    if (!names.length) box.innerHTML = '<div class="empty">Aucun thème sauvegardé.</div>';
    for (const name of names) {
      const row = document.createElement('div');
      row.className = 'ct';
      const c = th.custom[name];
      row.innerHTML = `<button class="btn ghost"><span class="swatches" style="width:3rem">${['bass', 'mid', 'treble'].map((k) => `<i style="background:${c[k]}"></i>`).join('')}</span></button><button class="icon-btn" title="Supprimer">✕</button>`;
      row.children[0].append(name);
      row.children[0].addEventListener('click', () => th.apply(name));
      row.children[1].addEventListener('click', () => th.deleteCustom(name));
      box.appendChild(row);
    }
    // Couleur de la barre d'adresse mobile / fenêtre.
    let meta = $('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = th.colors.bg;
  }

  /* ------------------------------------------------------------ Serveur --- */

  _bindServer() {
    const srv = this.server;
    $('#btnServerConnect').addEventListener('click', () => srv.connect());
    srv.on('status', ({ connection, message, source }) => {
      const dot = $('#srvDot');
      dot.className = `dot ${connection === 'connected' ? 'on' : connection === 'connecting' ? 'warn' : connection === 'error' ? 'err' : ''}`;
      $('#srvSource').textContent = source === 'off' ? 'DISABLED' : source.toUpperCase();
      $('#srvMsg').textContent = message || '';
      if (connection !== 'connected') {
        const st = $('#tbStatus');
        st.dataset.state = connection === 'connecting' ? 'connecting' : 'offline';
        st.textContent = connection === 'connecting' ? 'CONNECTING' : source === 'off' ? 'N/A' : 'OFFLINE';
      }
    });
    srv.on('data', (d) => this._renderServer(d));
  }

  _renderServer(d) {
    const st = $('#tbStatus');
    st.dataset.state = d.status;
    st.textContent = d.status.toUpperCase();
    $('#tbPlayers').textContent = `${d.players.online} / ${d.players.max || '—'}`;
    $('#tbTps').textContent = d.tps != null ? `${d.tps.toFixed(1)} TPS` : '— TPS';
    $('#tbTps').style.color = d.tps == null ? '' : d.tps >= 19 ? 'var(--ok)' : d.tps >= 15 ? 'var(--warn)' : 'var(--err)';
    $('#tbCpu').textContent = d.cpu != null ? `${Math.round(d.cpu)}%` : '—';
    $('#tbRam').textContent = d.ram.used != null ? `${d.ram.used.toFixed(1)}${d.ram.max ? ` / ${d.ram.max}` : ''} GB` : '—';
    $('#srvName').textContent = d.name;
    $('#srvVersion').textContent = d.version || '—';
    $('#srvUptime').textContent = d.uptime != null ? formatClock(d.uptime, 0) : '—';
    $('#srvMspt').textContent = d.mspt != null ? `${d.mspt.toFixed(1)} ms` : '—';
    const h = this.server.history;
    this._spark($('#sparkTps'), h.tps, 0, 20, this.theme.colors.accent);
    this._spark($('#sparkPlayers'), h.players, 0, Math.max(1, d.players.max || Math.max(...h.players)), this.theme.colors.treble);
  }

  _spark(canvas, data, min, max, color) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    if (data.length < 2) return;
    const [r, g, b] = hexToRgb(color).map((v) => Math.round(v * 255));
    c.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - 2 - clamp((v - min) / (max - min || 1), 0, 1) * (h - 4);
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    });
    c.strokeStyle = color; c.lineWidth = 1.3; c.stroke();
    c.lineTo(w, h); c.lineTo(0, h); c.closePath();
    c.fillStyle = `rgba(${r},${g},${b},0.15)`; c.fill();
  }

  /* ---------------------------------------------------------- Clavier ----- */

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = this.transport, s = this.settings;
      const k = e.key.toLowerCase();
      const map = {
        ' ': () => t.togglePlay(),
        l: () => t.goLive(),
        arrowleft: () => t.step(e.shiftKey ? -5 : -1),
        arrowright: () => t.step(e.shiftKey ? 5 : 1),
        j: () => { t.shuttle(-1); this._syncSpeed(); },
        k: () => { t.shuttle(1); this._syncSpeed(); },
        '[': () => this._stepSpeed(-1),
        ']': () => this._stepSpeed(1),
        1: () => this.setView('TOP'),
        2: () => this.setView('FRONT'),
        3: () => this.setView('SIDE'),
        4: () => this.setView('3D'),
        r: () => this.setView('RESET'),
        v: () => $('#btnCamera').click(),
        a: () => s.set('autoRotate', !s.get('autoRotate')),
        t: () => { const m = Object.keys(TRAIL_MODES); s.set('trailMode', m[(m.indexOf(s.get('trailMode')) + 1) % m.length]); },
        h: () => s.set('hudVisible', !s.get('hudVisible')),
        b: () => this.toggleSidebar(),
        c: () => this.toggleDrawer('colors'),
        s: () => this.toggleDrawer('settings'),
        f: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()),
        escape: () => this.toggleDrawer(null),
      };
      const fn = map[k];
      if (fn) { e.preventDefault(); fn(); }
    });
  }

  _stepSpeed(dir) {
    const i = SPEEDS.indexOf(this.transport.speed);
    const next = SPEEDS[clamp((i < 0 ? SPEEDS.indexOf(1) : i) + dir, 0, SPEEDS.length - 1)];
    this.settings.set('playbackSpeed', next);
  }

  toggleSidebar() {
    if (window.innerWidth <= 1180) this.app.classList.toggle('sidebar-peek');
    else this.settings.set('sidebarCollapsed', !this.settings.get('sidebarCollapsed'));
  }

  /* -------------------------------------------------------------- Divers -- */

  _bindMisc() {
    $('#btnSidebar').addEventListener('click', () => this.toggleSidebar());
    $('#btnClearHistory').addEventListener('click', () => {
      this.history.clear();
      this._peakItems = [];
      this._renderPeakList();
      this.transport.goLive();
      this._updateHistoryInfo();
    });
    $('#btnResetSettings').addEventListener('click', () => {
      if (window.confirm('Réinitialiser tous les paramètres ?')) this.settings.reset();
    });
    $('#peakList').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-time]');
      if (li) this.transport.seek(Number(li.dataset.time) - 1.5);
    });
  }

  _updateHistoryInfo() {
    const h = this.history;
    $('#histMem').textContent = `${(h.memoryBytes / 1048576).toFixed(2)} Mo alloués`;
    $('#histLen').textContent = `${formatClock(h.duration, 0)} / ${formatClock(h.retention, 0)}`;
  }

  toast(msg) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      Object.assign(el.style, {
        position: 'fixed', left: '50%', bottom: 'calc(var(--toolbar-h) + var(--timeline-h) + 12px)', translate: '-50% 0',
        padding: '0.5rem 0.9rem', borderRadius: '6px', background: 'var(--panel-solid)', border: '1px solid var(--border-strong)',
        fontFamily: 'var(--font-mono)', fontSize: '0.74rem', zIndex: 20, transition: 'opacity .3s', pointerEvents: 'none',
      });
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { el.style.opacity = '0'; }, 2200);
  }

  /* ----------------------------------------------------------- Pics ------- */

  addPeak(p) {
    this._peakItems.unshift(p);
    if (this._peakItems.length > 60) this._peakItems.length = 60;
    this._renderPeakList();
    const flash = $('#peakFlash');
    flash.classList.remove('on');
    void flash.offsetWidth; // relance l'animation
    flash.classList.add('on');
  }

  _renderPeakList() {
    const ul = $('#peakList');
    const items = this._peakItems.filter((p) => p.time >= this.history.oldestTime);
    $('#peakCount').textContent = String(this.history.peaks.length);
    if (!items.length) { ul.innerHTML = '<li class="empty">Aucun pic détecté</li>'; return; }
    ul.innerHTML = items.map((p) => `<li data-time="${p.time}" title="Aller à cet instant"><span class="pt">${formatClock(p.time)}</span><span class="pf">${formatFreq(p.freq)}</span><span class="pd">${p.db.toFixed(1)} dB</span></li>`).join('');
  }

  /* ------------------------------------------------------ Affichages ------ */

  /**
   * Mise à jour des mesures (appelée à chaque image, limitée à ~20 Hz).
   * @param {object} v { shown, live, cursor, liveTime, fps, dt }
   */
  tick(v) {
    // Barres : chaque image (fluide). Textes : ~20 Hz.
    const f = v.shown;
    const set = (id, x) => { const el = document.getElementById(id); if (el) el.style.transform = `scaleX(${clamp(x, 0, 1).toFixed(3)})`; };
    const setY = (id, x) => { const el = document.getElementById(id); if (el) el.style.transform = `scaleY(${clamp(x, 0, 1).toFixed(3)})`; };
    const b = f ? f.bass : 0, m = f ? f.mid : 0, tr = f ? f.treble : 0, it = f ? f.intensity : 0;
    set('barBass', b); set('barMid', m); set('barTreble', tr); set('barInt', it); set('hudIntBar', it);
    setY('hzBass', b); setY('hzMid', m); setY('hzTreble', tr);
    const lv = v.live;
    set('micMeter', lv ? clamp((lv.rmsDb + 60) / 60, 0, 1) : 0);
    $('#micPeak').style.left = `${(lv ? clamp((lv.peakDb + 60) / 60, 0, 1) : 0) * 100}%`;

    this._acc += v.dt;
    if (this._acc < 0.05) return;
    this._acc = 0;

    const pct = (x) => `${Math.round(x * 100)}%`;
    $('#valBass').textContent = pct(b); $('#valMid').textContent = pct(m);
    $('#valTreble').textContent = pct(tr); $('#valInt').textContent = pct(it);
    $('#hzBassV').textContent = Math.round(b * 100); $('#hzMidV').textContent = Math.round(m * 100); $('#hzTrebleV').textContent = Math.round(tr * 100);
    const zones = [['bass', b], ['mid', m], ['treble', tr]];
    const dom = zones.reduce((a, z) => (z[1] > a[1] ? z : a), ['', 0.04]);
    for (const [z] of zones) {
      document.querySelector(`.band-row[data-zone="${z}"]`).classList.toggle('dominant', dom[0] === z);
      document.querySelector(`.hz[data-zone="${z}"]`).classList.toggle('dominant', dom[0] === z);
    }
    $('#domZone').textContent = { bass: 'GRAVES', mid: 'MÉDIUMS', treble: 'AIGUS' }[dom[0]] || '—';

    $('#hudInt').textContent = pct(it);
    $('#hudDb').textContent = f && f.rmsDb > -120 ? `${f.rmsDb.toFixed(1)} dB` : '−∞ dB';
    const df = f?.dominantFrequency || 0;
    $('#hudFreq').textContent = formatFreq(df);
    const note = noteName(df);
    $('#hudNote').textContent = df ? `${note.name} ${note.cents >= 0 ? '+' : ''}${note.cents}¢` : '';
    $('#hudPeak').textContent = f && f.peakDb > -120 ? f.peakDb.toFixed(1) : '−∞';
    $('#hudClip').classList.toggle('on', !!f?.clipping);
    $('#hudTime').textContent = formatClock(v.cursor);
    $('#hudOffset').textContent = this.transport.isLive ? 'LIVE' : formatOffset(v.cursor - v.liveTime);
    $('#audioAt').textContent = this.transport.isLive ? 'LIVE' : `@ ${formatClock(v.cursor)}`;

    // Micro (toujours le direct).
    $('#micDom').textContent = lv?.dominantFrequency ? `${formatFreq(lv.dominantFrequency)} · ${noteName(lv.dominantFrequency).name}` : '—';
    $('#micVol').textContent = lv && lv.rmsDb > -120 ? `${lv.rmsDb.toFixed(1)} dBFS` : '—';
    const clip = $('#micClip');
    clip.textContent = lv?.clipping ? 'CLIPPING!' : 'NONE';
    clip.className = lv?.clipping ? 'bad' : 'ok';

    $('#tbFps').textContent = Math.round(v.fps);
    $('#tbClock').textContent = formatClock(v.liveTime, 0);
    const h = this.history;
    $('#tlRange').textContent = h.length ? `BUFFER ${formatClock(h.duration, 0)} / ${formatClock(h.retention, 0)} · ${h.peaks.length} PEAKS` : 'BUFFER VIDE';
    this._updateBadge();
    if (this.drawer === 'settings') this._updateHistoryInfo();
    if (this._peakItems.length && this._peakItems[this._peakItems.length - 1].time < h.oldestTime) this._renderPeakList();
  }
}
