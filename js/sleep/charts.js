/**
 * charts.js — Petits graphiques Canvas pour l'app Sommeil.
 *
 * Règles communes : traits de 2 px, barres ≤ 24 px aux extrémités arrondies,
 * grille fine et discrète, texte en couleurs de texte (jamais la couleur de
 * la série), info-bulle au survol avec ligne de repère verticale.
 *
 *   TimeChart   courbes / aires / bandes sur l'axe du temps de la nuit
 *   BarChart    barres verticales par catégorie (heures, nuits…)
 *   LaneChart   chronologie : hypnogramme + une ligne par type d'événement
 */

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const pad2 = (n) => String(n).padStart(2, '0');

function theme() {
  return {
    text: css('--text', '#e4e4e7'),
    muted: 'rgba(228,228,231,0.62)',
    dim: 'rgba(228,228,231,0.42)',
    grid: 'rgba(228,228,231,0.08)',
    surface: css('--raised', '#2e2f34'),
    font: '500 11px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
    fontSm: '500 10px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
  };
}

export function rgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Trace un rectangle aux coins supérieurs arrondis (barres). */
function topRounded(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

/* ------------------------------------------------------------------------ */

class CanvasChart {
  constructor(container, opts = {}) {
    this.el = container;
    this.opts = opts;
    this.el.classList.add('chart');
    this.canvas = document.createElement('canvas');
    this.tip = document.createElement('div');
    this.tip.className = 'viz-tip';
    this.tip.hidden = true;
    this.el.append(this.canvas, this.tip);
    this.ctx = this.canvas.getContext('2d');
    this.hoverX = null;
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.el);
    this.canvas.addEventListener('pointermove', (e) => this._move(e));
    this.canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.tip.hidden = true; this.draw(); });
    this._resize();
  }

  _resize() {
    const r = this.el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  _move(e) {
    const r = this.canvas.getBoundingClientRect();
    this.hoverX = e.clientX - r.left;
    this.hoverY = e.clientY - r.top;
    this.draw();
    const rows = this.tooltip?.(this.hoverX, this.hoverY);
    if (!rows) { this.tip.hidden = true; return; }
    this._renderTip(rows);
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    let x = this.hoverX + 14, y = this.hoverY - th - 8;
    if (x + tw > this.w) x = this.hoverX - tw - 14;
    if (y < 0) y = this.hoverY + 16;
    this.tip.style.transform = `translate(${Math.max(0, x)}px, ${y}px)`;
  }

  /** rows = { title, items: [{ value, label, color, line }] } — contenu inséré en textContent. */
  _renderTip({ title, items }) {
    this.tip.hidden = false;
    this.tip.replaceChildren();
    if (title) { const t = document.createElement('div'); t.className = 'tt-title'; t.textContent = title; this.tip.append(t); }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'tt-row';
      const key = document.createElement('i');
      key.className = it.line ? 'tt-line' : 'tt-sw';
      if (it.color) key.style.background = it.color;
      const v = document.createElement('b'); v.textContent = it.value;
      const l = document.createElement('span'); l.textContent = it.label;
      row.append(key, v, l);
      this.tip.append(row);
    }
  }

  setData(data) { this.data = data; this.draw(); }

  draw() {
    if (!this.w || !this.data) return;
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.ctx.clearRect(0, 0, this.w, this.h);
      this.render(this.ctx, theme());
    });
  }

  destroy() { this._ro.disconnect(); this.el.replaceChildren(); }
}

/* ------------------------------------------------------------- Axe temps --- */

/** Graduations d'horloge entre deux instants (ms), pas adapté à la largeur. */
function timeTicks(t0, t1, px) {
  const span = (t1 - t0) / 60000;
  const steps = [5, 10, 15, 30, 60, 120, 180];
  const step = steps.find((s) => span / s <= px / 70) || 240;
  // Première graduation : multiple du pas en heure locale.
  const d0 = new Date(t0);
  const dayStart = new Date(d0); dayStart.setHours(0, 0, 0, 0);
  const minOfDay = (t0 - dayStart.getTime()) / 60000;
  const out = [];
  for (let m = Math.ceil(minOfDay / step) * step; ; m += step) {
    const t = dayStart.getTime() + m * 60000;
    if (t > t1) break;
    const d = new Date(t);
    out.push({ t, label: d.getMinutes() === 0 ? `${d.getHours()}h` : `${d.getHours()}h${pad2(d.getMinutes())}` });
  }
  return out;
}

/**
 * Courbes sur l'axe du temps.
 * data = { start, end, yMin, yMax, yFmt, yTicks?, series: [{ name, color, kind: 'line'|'area'|'step', points: [[sec, value|null]] }], bands?: [{ t0, t1, color }] }
 */
export class TimeChart extends CanvasChart {
  get pad() { return { l: 44, r: 12, t: 10, b: 24 }; }

  xOf(sec) { const p = this.pad, d = this.data; return p.l + ((sec * 1000) / (d.end - d.start)) * (this.w - p.l - p.r); }
  secAt(x) { const p = this.pad, d = this.data; return ((x - p.l) / (this.w - p.l - p.r)) * (d.end - d.start) / 1000; }
  yOf(v) { const p = this.pad, d = this.data; return p.t + (1 - (v - d.yMin) / (d.yMax - d.yMin)) * (this.h - p.t - p.b); }

  render(ctx, th) {
    const d = this.data, p = this.pad;
    const x0 = p.l, x1 = this.w - p.r, y0 = p.t, y1 = this.h - p.b;
    // Bandes de fond (ex. périodes de sommeil).
    for (const b of d.bands || []) {
      ctx.fillStyle = b.color;
      ctx.fillRect(this.xOf(b.t0), y0, Math.max(1, this.xOf(b.t1) - this.xOf(b.t0)), y1 - y0);
    }
    // Grille horizontale + graduations Y.
    ctx.font = th.fontSm; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    const yt = d.yTicks || niceTicks(d.yMin, d.yMax, 4);
    for (const v of yt) {
      const y = Math.round(this.yOf(v)) + 0.5;
      ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillStyle = th.dim; ctx.fillText(d.yFmt ? d.yFmt(v) : String(v), x0 - 6, y);
    }
    // Graduations X.
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const tk of timeTicks(d.start, d.end, x1 - x0)) {
      const x = this.xOf((tk.t - d.start) / 1000);
      ctx.fillStyle = th.dim; ctx.fillText(tk.label, x, y1 + 6);
      ctx.fillStyle = th.grid; ctx.fillRect(Math.round(x), y1, 1, 4);
    }
    // Séries.
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0 - 2, x1 - x0, y1 - y0 + 4); ctx.clip();
    for (const s of d.series) {
      ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = s.color;
      let pen = false, firstX = 0, lastX = 0;
      ctx.beginPath();
      for (const [t, v] of s.points) {
        if (v == null) {
          if (pen && s.kind === 'area') { ctx.lineTo(lastX, y1); ctx.lineTo(firstX, y1); }
          pen = false; continue;
        }
        const x = this.xOf(t), y = this.yOf(v);
        if (!pen) {
          if (s.kind === 'area') { ctx.moveTo(x, y1); ctx.lineTo(x, y); } else ctx.moveTo(x, y);
          pen = true; firstX = x;
        } else if (s.kind === 'step') { ctx.lineTo(x, this.yOf(s.prev ?? v)); ctx.lineTo(x, y); }
        else ctx.lineTo(x, y);
        s.prev = v; lastX = x;
      }
      if (s.kind === 'area') {
        if (pen) { ctx.lineTo(lastX, y1); ctx.lineTo(firstX, y1); }
        ctx.fillStyle = rgba(s.color, 0.12); ctx.fill();
        // Contour supérieur.
        ctx.beginPath(); pen = false;
        for (const [t, v] of s.points) {
          if (v == null) { pen = false; continue; }
          const x = this.xOf(t), y = this.yOf(v);
          if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
        }
      }
      if (s.kind !== 'dots') ctx.stroke();
      if (s.dots) {
        for (const [t, v] of s.points) {
          if (v == null) continue;
          ctx.beginPath(); ctx.arc(this.xOf(t), this.yOf(v), 4, 0, Math.PI * 2);
          ctx.fillStyle = s.color; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = th.surface; ctx.stroke();
        }
      }
    }
    ctx.restore();
    // Repère de survol.
    if (this.hoverX != null && this.hoverX >= x0 && this.hoverX <= x1) {
      ctx.fillStyle = 'rgba(228,228,231,0.35)';
      ctx.fillRect(Math.round(this.hoverX), y0, 1, y1 - y0);
    }
  }

  tooltip(x) {
    const d = this.data, p = this.pad;
    if (x < p.l || x > this.w - p.r) return null;
    const sec = this.secAt(x);
    const at = new Date(d.start + sec * 1000);
    const items = [];
    for (const s of d.series) {
      let best = null, bd = Infinity;
      for (const pt of s.points) { const dd = Math.abs(pt[0] - sec); if (dd < bd) { bd = dd; best = pt; } }
      items.push({ value: best && best[1] != null && bd < (s.tolerance ?? 120) ? (s.fmt || d.yFmt || String)(best[1]) : '—', label: s.name, color: s.color, line: true });
    }
    return { title: `${pad2(at.getHours())}:${pad2(at.getMinutes())}`, items };
  }
}

export function niceTicks(min, max, n = 4) {
  const span = max - min;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/* ---------------------------------------------------------------- Barres --- */

/**
 * data = { bars: [{ label, value, color?, tip? }], color, fmt, max?, highlight? (index) }
 */
export class BarChart extends CanvasChart {
  get pad() { return { l: 44, r: 8, t: 22, b: 24 }; }

  layout() {
    const d = this.data, p = this.pad;
    const n = d.bars.length || 1;
    const band = (this.w - p.l - p.r) / n;
    const bw = Math.min(24, band * 0.62);
    const max = d.max ?? Math.max(1e-9, ...d.bars.map((b) => b.value || 0));
    return { band, bw, max };
  }

  render(ctx, th) {
    const d = this.data, p = this.pad;
    const { band, bw, max } = this.layout();
    const y0 = p.t, y1 = this.h - p.b;
    const ticks = niceTicks(0, max, 3);
    const top = ticks[ticks.length - 1] || max;
    this._top = top;
    ctx.font = th.fontSm; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of ticks) {
      const y = Math.round(y1 - (v / top) * (y1 - y0)) + 0.5;
      ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(this.w - p.r, y); ctx.stroke();
      ctx.fillStyle = th.dim; ctx.fillText(d.fmt ? d.fmt(v) : String(v), p.l - 6, y);
    }
    const labelEvery = Math.ceil(28 / band);
    d.bars.forEach((b, i) => {
      const cx = p.l + band * (i + 0.5);
      const h = ((b.value || 0) / top) * (y1 - y0);
      const hover = this._hoverIndex === i;
      ctx.fillStyle = b.color || d.color;
      ctx.globalAlpha = this._hoverIndex == null || hover ? 1 : 0.55;
      if (h > 0) { topRounded(ctx, cx - bw / 2, y1 - h, bw, h, 4); ctx.fill(); }
      ctx.globalAlpha = 1;
      if (i % labelEvery === 0) {
        ctx.fillStyle = th.dim; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(b.label, cx, y1 + 6);
      }
      if (d.valueLabels && b.value) {
        ctx.fillStyle = th.muted; ctx.textBaseline = 'bottom';
        ctx.fillText(d.fmt ? d.fmt(b.value) : String(b.value), cx, y1 - h - 3);
      }
    });
  }

  tooltip(x) {
    const d = this.data, p = this.pad;
    const { band } = this.layout();
    const i = Math.floor((x - p.l) / band);
    const prev = this._hoverIndex;
    this._hoverIndex = i >= 0 && i < d.bars.length ? i : null;
    if (prev !== this._hoverIndex) this.draw();
    if (this._hoverIndex == null) return null;
    const b = d.bars[i];
    return { title: b.tipTitle || b.label, items: b.tip || [{ value: d.fmt ? d.fmt(b.value) : String(b.value), label: d.name || '', color: b.color || d.color }] };
  }
}

/* ----------------------------------------------------------- Chronologie --- */

/**
 * Carte chronologique de la nuit, zoomable (molette) et déplaçable (glisser).
 * data = { start, end, states: [0|1 par minute], lanes: [{ key, label, color, items: [{ t0, t1, ... }] }], level: [dB/s], onPick(item) }
 */
export class LaneChart extends CanvasChart {
  constructor(el, opts) {
    super(el, opts);
    this.view = null;   // [s0, s1] secondes visibles
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [a, b] = this.view, total = this.total;
      const at = this.secAt(this.hoverX ?? this.w / 2);
      const k = Math.exp(e.deltaY * 0.0015);
      const span = Math.min(total, Math.max(120, (b - a) * k));
      let s0 = at - (at - a) * (span / (b - a));
      s0 = Math.max(0, Math.min(total - span, s0));
      this.view = [s0, s0 + span];
      this.draw();
      this.onView?.(this.view);
    }, { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => { this._drag = { x: e.clientX, view: [...this.view], moved: false }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointerup', () => {
      if (this._drag && !this._drag.moved && this._hit) this.data.onPick?.(this._hit);
      this._drag = null;
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x;
      if (Math.abs(dx) > 3) this._drag.moved = true;
      const [a, b] = this._drag.view;
      const ds = -dx / (this.w - this.pad.l - this.pad.r) * (b - a);
      const s0 = Math.max(0, Math.min(this.total - (b - a), a + ds));
      this.view = [s0, s0 + (b - a)];
      this.draw();
    });
    this.canvas.addEventListener('dblclick', () => this.resetZoom());
  }

  get pad() { return { l: 150, r: 12, t: 8, b: 24 }; }
  get total() { return (this.data.end - this.data.start) / 1000; }

  setData(data) {
    const keep = this.data && this.data.start === data.start && this.view;
    this.data = data;
    if (!keep) this.view = [0, this.total];
    this.draw();
  }

  resetZoom() { this.view = [0, this.total]; this.draw(); }
  zoomTo(s0, s1) { this.view = [Math.max(0, s0), Math.min(this.total, s1)]; this.draw(); }

  xOf(sec) { const p = this.pad; const [a, b] = this.view; return p.l + ((sec - a) / (b - a)) * (this.w - p.l - p.r); }
  secAt(x) { const p = this.pad; const [a, b] = this.view; return a + ((x - p.l) / (this.w - p.l - p.r)) * (b - a); }

  rows() {
    const p = this.pad;
    const lanes = this.data.lanes;
    const hypH = 30;
    const levelH = Math.max(46, Math.min(110, (this.h - p.t - p.b) * 0.18));
    const avail = this.h - p.t - p.b - hypH - levelH - 12;
    const laneH = Math.max(14, Math.min(40, avail / Math.max(1, lanes.length)));
    let y = p.t;
    const out = { hyp: [y, y + hypH] };
    y += hypH + 6;
    out.lanes = lanes.map((l) => { const r = [y, y + laneH]; y += laneH; return r; });
    out.level = [y + 6, y + 6 + levelH];
    return out;
  }

  render(ctx, th) {
    const d = this.data, p = this.pad;
    const x0 = p.l, x1 = this.w - p.r;
    const R = this.rows();
    ctx.font = th.font; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';

    // Hypnogramme (sommeil / éveil estimés).
    const [h0, h1] = R.hyp;
    ctx.fillStyle = th.muted; ctx.fillText('Sommeil estimé', 10, (h0 + h1) / 2);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, this.h); ctx.clip();
    (d.states || []).forEach((s, m) => {
      const xa = this.xOf(m * 60), xb = this.xOf((m + 1) * 60);
      if (xb < x0 || xa > x1) return;
      ctx.fillStyle = s ? '#3987e5' : 'rgba(228,228,231,0.22)';
      if (s) ctx.fillRect(xa, h0 + 6, Math.max(1, xb - xa + 0.5), h1 - h0 - 6);
      else ctx.fillRect(xa, h0, Math.max(1, xb - xa + 0.5), 5);
    });
    ctx.restore();

    // Lignes d'événements.
    this._hits = [];
    d.lanes.forEach((lane, i) => {
      const [a, b] = R.lanes[i];
      const mid = (a + b) / 2;
      ctx.fillStyle = i % 2 ? 'rgba(228,228,231,0.025)' : 'transparent';
      ctx.fillRect(x0, a, x1 - x0, b - a);
      ctx.fillStyle = lane.color; ctx.beginPath(); ctx.arc(14, mid, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = th.muted; ctx.fillText(`${lane.label}`, 24, mid);
      ctx.fillStyle = th.dim; ctx.textAlign = 'right'; ctx.fillText(String(lane.items.length), x0 - 8, mid); ctx.textAlign = 'left';
      ctx.save(); ctx.beginPath(); ctx.rect(x0, a, x1 - x0, b - a); ctx.clip();
      for (const it of lane.items) {
        const xa = this.xOf(it.t0), xb = this.xOf(it.t1);
        if (xb < x0 || xa > x1) continue;
        const w = Math.max(3, xb - xa);
        ctx.fillStyle = lane.color;
        ctx.globalAlpha = this._hit === it ? 1 : 0.85;
        ctx.beginPath(); ctx.roundRect(xa, a + 3, w, b - a - 6, 3); ctx.fill();
        ctx.globalAlpha = 1;
        this._hits.push({ it, lane, xa: xa - 3, xb: xa + w + 3, a, b });
      }
      ctx.restore();
    });

    // Niveau sonore (dB, max par pixel).
    const [l0, l1] = R.level;
    ctx.fillStyle = th.muted; ctx.fillText('Niveau sonore', 10, (l0 + l1) / 2);
    const lv = d.level || [];
    const lo = -80, hi = -20;
    ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, l1 + 0.5); ctx.lineTo(x1, l1 + 0.5); ctx.stroke();
    if (lv.length) {
      ctx.save(); ctx.beginPath(); ctx.rect(x0, l0, x1 - x0, l1 - l0); ctx.clip();
      ctx.beginPath(); ctx.moveTo(x0, l1);
      const [va, vb] = this.view;
      const step = Math.max(1, (vb - va) / (x1 - x0));
      for (let x = x0; x <= x1; x++) {
        const s0 = Math.floor(this.secAt(x)), s1 = Math.max(s0 + 1, Math.floor(s0 + step));
        let m = -120;
        for (let s = s0; s < s1 && s < lv.length; s++) if (lv[s] > m) m = lv[s];
        if (s0 >= lv.length) break;
        ctx.lineTo(x, l1 - Math.max(0, Math.min(1, (m - lo) / (hi - lo))) * (l1 - l0));
      }
      ctx.lineTo(x1, l1);
      ctx.fillStyle = 'rgba(228,228,231,0.16)'; ctx.fill();
      ctx.restore();
    }

    // Axe du temps.
    ctx.font = th.fontSm; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const tA = d.start + this.view[0] * 1000, tB = d.start + this.view[1] * 1000;
    for (const tk of timeTicks(tA, tB, x1 - x0)) {
      const x = this.xOf((tk.t - d.start) / 1000);
      ctx.fillStyle = th.grid; ctx.fillRect(Math.round(x), p.t, 1, this.h - p.t - p.b);
      ctx.fillStyle = th.dim; ctx.fillText(tk.label, x, this.h - p.b + 6);
    }
    if (this.hoverX != null && this.hoverX >= x0 && this.hoverX <= x1) {
      ctx.fillStyle = 'rgba(228,228,231,0.35)';
      ctx.fillRect(Math.round(this.hoverX), p.t, 1, this.h - p.t - p.b);
    }
  }

  tooltip(x, y) {
    const d = this.data, p = this.pad;
    if (x < p.l) return null;
    const hit = (this._hits || []).find((h) => x >= h.xa && x <= h.xb && y >= h.a && y <= h.b);
    const prev = this._hit;
    this._hit = hit?.it || null;
    this.canvas.style.cursor = hit ? 'pointer' : 'grab';
    if (prev !== this._hit) this.draw();
    const sec = this.secAt(x);
    const at = new Date(d.start + sec * 1000);
    const title = `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
    if (hit) return { title: `${hit.lane.label} · ${title}`, items: d.describe ? d.describe(hit.it, hit.lane) : [] };
    const m = Math.floor(sec / 60);
    const st = d.states?.[m];
    return {
      title,
      items: [
        { value: st == null ? '—' : st ? 'Sommeil' : 'Éveil', label: 'état estimé', color: st ? '#3987e5' : 'rgba(228,228,231,0.4)' },
        { value: d.level?.[Math.floor(sec)] != null ? `${d.level[Math.floor(sec)]} dB` : '—', label: 'niveau sonore', color: 'rgba(228,228,231,0.5)', line: true },
      ],
    };
  }
}
