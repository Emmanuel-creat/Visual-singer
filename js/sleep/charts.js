/**
 * charts.js — Petits graphiques Canvas pour l'app Sommeil.
 *
 * Règles communes : traits de 2 px, barres ≤ 24 px aux extrémités arrondies,
 * grille fine et discrète, texte en couleurs de texte (jamais la couleur de
 * la série), info-bulle au survol avec ligne de repère verticale.
 *
 *   TimeChart     courbes lissées / aires / escalier / barres sur l'axe du temps de la nuit
 *   BarChart      barres fines en pilule sur piste, la plus haute étiquetée
 *   LaneChart     chronologie : hypnogramme + une ligne par type d'événement
 *   ringGauge     jauge circulaire (SVG)       hbarList   barres horizontales (DOM)
 *   calendarHeat  calendrier des nuits (DOM)   qualityLegend  légende vert → rouge
 *
 * Couleurs de « qualité » (quality.js) : vert = favorable, rouge = défavorable.
 */

import { qColor, qLabel } from './quality.js';

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const pad2 = (n) => String(n).padStart(2, '0');

function theme() {
  return {
    text: css('--text', '#e4e4e7'),
    muted: 'rgba(228,228,231,0.62)',
    dim: 'rgba(228,228,231,0.42)',
    grid: 'rgba(228,228,231,0.08)',
    surface: css('--raised', '#2e2f34'),
    plot: '#17181b',
    fontTag: '600 11px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
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
    this.canvas.addEventListener('pointerleave', () => { this.hoverX = null; this._hoverIndex = null; this.tip.hidden = true; this.draw(); });
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
 * Courbes sur l'axe du temps (style « Elements » : courbes lissées, trait lumineux,
 * dégradé sous la courbe, points étiquetés).
 *
 * data = {
 *   start, end, yMin, yMax, yFmt, yTicks?,
 *   series: [{ name, kind: 'area'|'line'|'step'|'dots'|'bars', points: [[sec, value|null]],
 *              color?, quality?: (v) => 0..1, fmt?, tolerance?, smooth? }],
 *   marks?: [{ t, v, text }],     // points remarquables étiquetés en permanence
 *   bands?: [{ t0, t1, color }],
 * }
 * Avec `quality`, la couleur suit la valeur : vert (favorable) → rouge (défavorable).
 */
export class TimeChart extends CanvasChart {
  get pad() { return { l: 46, r: 14, t: 14, b: 24 }; }

  xOf(sec) { const p = this.pad, d = this.data; return p.l + ((sec * 1000) / (d.end - d.start)) * (this.w - p.l - p.r); }
  secAt(x) { const p = this.pad, d = this.data; return ((x - p.l) / (this.w - p.l - p.r)) * (d.end - d.start) / 1000; }
  yOf(v) { const p = this.pad, d = this.data; return p.t + (1 - (v - d.yMin) / (d.yMax - d.yMin)) * (this.h - p.t - p.b); }

  /** Dégradé vertical : la couleur dépend de la valeur à chaque hauteur. */
  _grad(ctx, s, alphaAt) {
    const d = this.data, p = this.pad;
    const y0 = p.t, y1 = this.h - p.b;
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    const N = 14;
    for (let k = 0; k <= N; k++) {
      const f = k / N;
      const v = d.yMax - f * (d.yMax - d.yMin);
      const a = alphaAt ? alphaAt(f) : 1;
      g.addColorStop(f, s.quality ? qColor(s.quality(v), a) : rgba(s.color, a));
    }
    return g;
  }

  _segments(s) {
    const segs = [];
    let cur = null;
    for (const [t, v] of s.points) {
      if (v == null) { cur = null; continue; }
      if (!cur) segs.push(cur = []);
      cur.push([this.xOf(t), this.yOf(v)]);
    }
    return segs;
  }

  render(ctx, th) {
    const d = this.data, p = this.pad;
    const x0 = p.l, x1 = this.w - p.r, y0 = p.t, y1 = this.h - p.b;
    for (const b of d.bands || []) {
      ctx.fillStyle = b.color;
      ctx.fillRect(this.xOf(b.t0), y0, Math.max(1, this.xOf(b.t1) - this.xOf(b.t0)), y1 - y0);
    }
    // Grille + graduations.
    ctx.font = th.fontSm; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    const yt = d.yTicks || niceTicks(d.yMin, d.yMax, 4);
    for (const v of yt) {
      const y = Math.round(this.yOf(v)) + 0.5;
      ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillStyle = th.dim; ctx.fillText(d.yFmt ? d.yFmt(v) : String(v), x0 - 8, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const tk of timeTicks(d.start, d.end, x1 - x0)) {
      const x = this.xOf((tk.t - d.start) / 1000);
      ctx.fillStyle = th.dim; ctx.fillText(tk.label, x, y1 + 7);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0 - 6, x1 - x0, y1 - y0 + 8); ctx.clip();
    for (const s of d.series) {
      const segs = this._segments(s);
      const stroke = this._grad(ctx, s);
      const fill = this._grad(ctx, s, (f) => 0.02 + 0.4 * (1 - f) ** 1.4);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';

      if (s.kind === 'bars') {
        const pts = s.points.filter((q) => q[1] != null);
        const spacing = pts.length > 1 ? (x1 - x0) / ((d.end - d.start) / 1000) * Math.abs(pts[1][0] - pts[0][0]) : 6;
        const bw = Math.max(1.5, Math.min(7, spacing * 0.62));
        for (const [t, v] of pts) {
          const x = this.xOf(t), y = this.yOf(v), base = this.yOf(Math.max(d.yMin, Math.min(d.yMax, s.base ?? d.yMin)));
          if (Math.abs(base - y) < 0.5) continue;
          const g = ctx.createLinearGradient(0, y, 0, base);
          const c = s.quality ? (a) => qColor(s.quality(v), a) : (a) => rgba(s.color, a);
          g.addColorStop(0, c(1)); g.addColorStop(1, c(0.25));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.roundRect(x - bw / 2, Math.min(y, base), bw, Math.abs(base - y), Math.min(bw / 2, 3)); ctx.fill();
        }
        continue;
      }

      for (const seg of segs) {
        // Tracé (lissé, en escalier ou droit).
        const trace = (moveFirst = true) => {
          if (s.kind === 'step') {
            seg.forEach(([x, y], i) => { if (i === 0) { if (moveFirst) ctx.moveTo(x, y); else ctx.lineTo(x, y); } else { ctx.lineTo(x, seg[i - 1][1]); ctx.lineTo(x, y); } });
          } else if (s.smooth === false) {
            seg.forEach(([x, y], i) => (i === 0 && moveFirst ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
          } else smoothPath(ctx, seg, moveFirst);
        };
        if (s.kind === 'step') {
          // Chaque palier est rempli de sa propre couleur (pas de dégradé vertical).
          for (let i = 0; i < seg.length - 1; i++) {
            const [xa, ya] = seg[i], xb = seg[i + 1][0];
            const v = d.yMax - ((ya - y0) / (y1 - y0)) * (d.yMax - d.yMin);
            const c = s.quality ? (a) => qColor(s.quality(v), a) : (a) => rgba(s.color, a);
            const g = ctx.createLinearGradient(0, ya, 0, y1);
            g.addColorStop(0, c(v >= 0.5 ? 0.34 : 0.2)); g.addColorStop(1, c(0.02));
            ctx.fillStyle = g;
            ctx.fillRect(xa, ya, xb - xa + 0.5, y1 - ya);
          }
        } else if (s.kind === 'area') {
          ctx.beginPath();
          ctx.moveTo(seg[0][0], y1);
          trace(false);
          ctx.lineTo(seg[seg.length - 1][0], y1);
          ctx.closePath();
          ctx.fillStyle = fill; ctx.fill();
        }
        if (s.kind !== 'dots') {
          ctx.beginPath(); trace(true);
          ctx.strokeStyle = stroke; ctx.lineWidth = 2;
          ctx.shadowColor = 'rgba(0,0,0,0)';
          ctx.save();
          ctx.shadowBlur = 10; ctx.shadowColor = s.quality ? qColor(0.5, 0.35) : rgba(s.color, 0.55);
          ctx.stroke();
          ctx.restore();
        }
      }
      if (s.kind === 'dots') {
        for (const [t, v] of s.points) {
          if (v == null) continue;
          dot(ctx, this.xOf(t), this.yOf(v), s.quality ? qColor(s.quality(v)) : s.color, th, 3.5);
        }
      }
    }
    ctx.restore();

    // Points remarquables étiquetés.
    for (const m of d.marks || []) {
      const s = d.series[0];
      const c = s.quality ? qColor(s.quality(m.v)) : s.color;
      const x = this.xOf(m.t), y = this.yOf(m.v);
      dot(ctx, x, y, c, th, 4.5, true);
      tag(ctx, x, y - 10, m.text, c, th, this.w);
    }

    // Survol : repère + points sur chaque série.
    if (this.hoverX != null && this.hoverX >= x0 && this.hoverX <= x1) {
      ctx.fillStyle = 'rgba(228,228,231,0.22)';
      ctx.fillRect(Math.round(this.hoverX), y0, 1, y1 - y0);
      const sec = this.secAt(this.hoverX);
      d.series.forEach((s, i) => {
        const pt = nearest(s.points, sec, s.tolerance ?? 120);
        if (!pt) return;
        const c = s.quality ? qColor(s.quality(pt[1])) : s.color;
        const x = this.xOf(pt[0]), y = this.yOf(pt[1]);
        dot(ctx, x, y, c, th, 5, true);
        if (i === 0 && d.series.length === 1) tag(ctx, x, y - 12, (s.fmt || d.yFmt || String)(pt[1]), c, th, this.w);
      });
    }
  }

  tooltip(x) {
    const d = this.data, p = this.pad;
    if (x < p.l || x > this.w - p.r) return null;
    const sec = this.secAt(x);
    const at = new Date(d.start + sec * 1000);
    const items = d.series.map((s) => {
      const pt = nearest(s.points, sec, s.tolerance ?? 120);
      const q = pt && s.quality ? s.quality(pt[1]) : null;
      return {
        value: pt ? (s.fmt || d.yFmt || String)(pt[1]) : '—',
        label: `${s.name}${q != null ? ` · ${qLabel(q)}` : ''}`,
        color: pt && s.quality ? qColor(q) : s.color, line: true,
      };
    });
    return { title: `${pad2(at.getHours())}:${pad2(at.getMinutes())}`, items };
  }
}

function nearest(points, sec, tol) {
  let best = null, bd = Infinity;
  for (const pt of points) {
    if (pt[1] == null) continue;
    const dd = Math.abs(pt[0] - sec);
    if (dd < bd) { bd = dd; best = pt; }
  }
  return best && bd <= tol ? best : null;
}

/** Courbe lissée monotone (Fritsch-Carlson) : pas de dépassement entre les points. */
function smoothPath(ctx, pts, moveFirst = true) {
  const n = pts.length;
  if (moveFirst) ctx.moveTo(pts[0][0], pts[0][1]); else ctx.lineTo(pts[0][0], pts[0][1]);
  if (n < 3) { for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]); return; }
  const dx = [], dy = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; dy[i] = pts[i + 1][1] - pts[i][1]; m[i] = dx[i] ? dy[i] / dx[i] : 0; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    ctx.bezierCurveTo(pts[i][0] + h, pts[i][1] + t[i] * h, pts[i + 1][0] - h, pts[i + 1][1] - t[i + 1] * h, pts[i + 1][0], pts[i + 1][1]);
  }
}

/** Point lumineux avec anneau de la couleur du fond. */
function dot(ctx, x, y, color, th, r = 4, glow = false) {
  ctx.save();
  if (glow) { ctx.shadowBlur = 12; ctx.shadowColor = color; }
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2; ctx.strokeStyle = th.plot; ctx.stroke();
  ctx.restore();
}

/** Étiquette arrondie au-dessus d'un point (texte en couleur de texte, bordure colorée). */
function tag(ctx, x, y, text, color, th, maxW) {
  ctx.save();
  ctx.font = th.fontTag;
  const w = ctx.measureText(text).width + 14, h = 20;
  const bx = Math.max(2, Math.min(maxW - w - 2, x - w / 2)), by = Math.max(2, y - h);
  ctx.fillStyle = 'rgba(18,19,22,0.92)';
  ctx.strokeStyle = color; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.roundRect(bx, by, w, h, 10); ctx.fill(); ctx.stroke();
  ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 7, by + h / 2 + 0.5);
  ctx.restore();
}

export function niceTicks(min, max, n = 4) {
  const span = max - min;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  // La dernière graduation couvre toujours le maximum.
  if (out.length && out[out.length - 1] < max - 1e-9) out.push(+(out[out.length - 1] + step).toFixed(6));
  return out;
}

/* ---------------------------------------------------------------- Barres --- */

/**
 * Barres fines en « pilule » sur une piste discrète ; la plus haute (ou la survolée)
 * s'allume et porte son étiquette.
 * data = { bars: [{ label, value, tip?, tipTitle? }], fmt, name, quality?: (v)=>q, color?, max? }
 */
export class BarChart extends CanvasChart {
  get pad() { return { l: 44, r: 10, t: 30, b: 24 }; }

  layout() {
    const d = this.data, p = this.pad;
    const n = d.bars.length || 1;
    const band = (this.w - p.l - p.r) / n;
    const bw = Math.max(5, Math.min(16, band * 0.4));
    const max = d.max ?? Math.max(1e-9, ...d.bars.map((b) => b.value || 0));
    return { band, bw, max };
  }

  colorOf(v, a = 1) {
    const d = this.data;
    return d.quality ? qColor(d.quality(v), a) : rgba(d.color || '#e0384a', a);
  }

  render(ctx, th) {
    const d = this.data, p = this.pad;
    const { band, bw, max } = this.layout();
    const y0 = p.t, y1 = this.h - p.b;
    const ticks = niceTicks(0, max, 3);
    const top = ticks[ticks.length - 1] || max;
    ctx.font = th.fontSm; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of ticks) {
      const y = Math.round(y1 - (v / top) * (y1 - y0)) + 0.5;
      ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(this.w - p.r, y); ctx.stroke();
      ctx.fillStyle = th.dim; ctx.fillText(d.fmt ? d.fmt(v) : String(v), p.l - 8, y);
    }
    let maxI = -1;
    d.bars.forEach((b, i) => { if (maxI < 0 || (b.value || 0) > (d.bars[maxI].value || 0)) maxI = i; });
    const focus = this._hoverIndex ?? (d.highlight === false ? -1 : maxI);
    const labelEvery = Math.ceil(30 / band);
    d.bars.forEach((b, i) => {
      const cx = p.l + band * (i + 0.5);
      const v = b.value || 0;
      const h = (v / top) * (y1 - y0);
      // Piste.
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.beginPath(); ctx.roundRect(cx - bw / 2, y0, bw, y1 - y0, bw / 2); ctx.fill();
      // Barre.
      if (h > 0.5) {
        const lit = i === focus;
        const g = ctx.createLinearGradient(0, y1 - h, 0, y1);
        g.addColorStop(0, this.colorOf(v, lit ? 1 : 0.85));
        g.addColorStop(1, this.colorOf(v, lit ? 0.55 : 0.3));
        ctx.save();
        if (lit) { ctx.shadowBlur = 14; ctx.shadowColor = this.colorOf(v, 0.8); }
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.roundRect(cx - bw / 2, y1 - h, bw, h, Math.min(bw / 2, h / 2)); ctx.fill();
        ctx.restore();
      }
      if (i % labelEvery === 0) {
        ctx.fillStyle = th.dim; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(b.label, cx, y1 + 7);
      }
    });
    if (focus >= 0 && d.bars[focus] && d.bars[focus].value) {
      const b = d.bars[focus];
      const cx = p.l + band * (focus + 0.5);
      const h = (b.value / top) * (y1 - y0);
      tag(ctx, cx, y1 - h - 6, d.fmt ? d.fmt(b.value) : String(b.value), this.colorOf(b.value), th, this.w);
    }
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
    const q = d.quality ? d.quality(b.value || 0) : null;
    return {
      title: b.tipTitle || b.label,
      items: b.tip || [{ value: d.fmt ? d.fmt(b.value) : String(b.value), label: `${d.name || ''}${q != null ? ` · ${qLabel(q)}` : ''}`, color: this.colorOf(b.value || 0) }],
    };
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
      ctx.fillStyle = s ? qColor(1, 0.9) : qColor(0, 0.75);
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
        { value: st == null ? '—' : st ? 'Sommeil' : 'Éveil', label: 'état estimé', color: st == null ? 'transparent' : qColor(st ? 1 : 0) },
        { value: d.level?.[Math.floor(sec)] != null ? `${d.level[Math.floor(sec)]} dB` : '—', label: 'niveau sonore', color: 'rgba(228,228,231,0.5)', line: true },
      ],
    };
  }
}

/* ------------------------------------------------- Composants DOM / SVG --- */

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let uid = 0;

/**
 * Jauge circulaire : arc dégradé lumineux + point d'extrémité, valeur au centre.
 * o = { value (0..1, remplissage), q (qualité 0..1), center, label, sub }
 */
export function ringGauge(el, o) {
  const id = `rg${uid++}`;
  const v = Math.max(0, Math.min(1, o.value ?? 0));
  const r = 40, C = 2 * Math.PI * r;
  const col = qColor(o.q), colSoft = qColor(o.q, 0.45);
  const ang = (-90 + 360 * v) * Math.PI / 180;
  const ex = 50 + r * Math.cos(ang), ey = 50 + r * Math.sin(ang);
  const arc = `stroke-dasharray="${(C * v).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 50 50)"`;
  el.innerHTML = `
    <div class="ring">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colSoft}"/><stop offset="1" stop-color="${col}"/></linearGradient>
          <filter id="${id}f" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.6"/></filter>
        </defs>
        <circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8"/>
        <circle cx="50" cy="50" r="${r - 9}" fill="none" stroke="rgba(255,255,255,0.025)" stroke-width="1"/>
        ${v > 0 ? `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" ${arc} filter="url(#${id}f)" opacity=".55"/>
        <circle cx="50" cy="50" r="${r}" fill="none" stroke="url(#${id})" stroke-width="8" stroke-linecap="round" ${arc}/>
        <circle cx="${ex.toFixed(2)}" cy="${ey.toFixed(2)}" r="5.2" fill="${col}" stroke="#16171a" stroke-width="2.4"/>` : ''}
      </svg>
      <div class="ring-c"><b>${escHtml(o.center)}</b><span>${escHtml(o.label)}</span></div>
    </div>
    <div class="ring-sub"><i style="background:${col}"></i>${escHtml(o.sub || '')}${o.q != null ? `<em>${qLabel(o.q)}</em>` : ''}</div>`;
}

/**
 * Liste de barres horizontales (pistes en pilule), couleur selon la qualité.
 * rows = [{ label, value, max, text, q }]
 */
export function hbarList(el, rows) {
  el.innerHTML = rows.length ? rows.map((r) => {
    const f = r.max ? Math.max(0.02, Math.min(1, r.value / r.max)) : 0;
    const col = qColor(r.q);
    return `<div class="hbar" title="${escHtml(r.label)} : ${escHtml(r.text)}${r.q != null ? ` (${qLabel(r.q)})` : ''}">
      <div class="hb-top"><span>${escHtml(r.label)}</span><b>${escHtml(r.text)}</b></div>
      <div class="hb-track"><i style="width:${(f * 100).toFixed(1)}%;background:linear-gradient(90deg, ${qColor(r.q, 0.35)}, ${col});box-shadow:0 0 10px ${qColor(r.q, 0.45)}"></i></div>
    </div>`;
  }).join('') : '<p class="muted">Aucune donnée.</p>';
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/**
 * Calendrier des nuits (une pastille par nuit, couleur = qualité de l'indicateur choisi).
 * items = [{ id, start (ms), q, text }] ; une nuit commencée avant midi compte pour la veille.
 */
export function calendarHeat(el, { items, onPick, selected }) {
  const byDay = new Map();
  for (const it of items) {
    const d = new Date(it.start);
    if (d.getHours() < 12) d.setDate(d.getDate() - 1);
    byDay.set(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`, it);
  }
  const last = items.length ? new Date(Math.max(...items.map((i) => i.start))) : new Date();
  const months = [new Date(last.getFullYear(), last.getMonth() - 1, 1), new Date(last.getFullYear(), last.getMonth(), 1)];
  el.innerHTML = months.map((m) => {
    const first = (m.getDay() + 6) % 7;   // lundi = 0
    const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<span class="cd empty"></span>';
    for (let day = 1; day <= days; day++) {
      const it = byDay.get(`${m.getFullYear()}-${m.getMonth()}-${day}`);
      if (it) {
        const col = qColor(it.q);
        cells += `<button class="cd has${it.id === selected ? ' sel' : ''}" data-id="${escHtml(it.id)}" title="${escHtml(it.text)}${it.q != null ? ` · ${qLabel(it.q)}` : ''}"
          style="--c:${col};--cs:${qColor(it.q, 0.4)}">${day}</button>`;
      } else cells += `<span class="cd">${day}</span>`;
    }
    return `<div class="cal-month"><h4>${MONTHS[m.getMonth()]} <small>${m.getFullYear()}</small></h4>
      <div class="cal-grid"><span class="cw">L</span><span class="cw">M</span><span class="cw">M</span><span class="cw">J</span><span class="cw">V</span><span class="cw">S</span><span class="cw">D</span>${cells}</div></div>`;
  }).join('');
  el.onclick = (e) => { const b = e.target.closest('button[data-id]'); if (b) onPick?.(b.dataset.id); };
}

/** Légende de l'échelle de qualité (dégradé + mots). */
export function qualityLegend(el) {
  const stops = Array.from({ length: 9 }, (_, i) => qColor(i / 8)).join(', ');
  el.innerHTML = `<span>défavorable</span><i style="background:linear-gradient(90deg, ${stops})"></i><span>favorable</span>`;
}
