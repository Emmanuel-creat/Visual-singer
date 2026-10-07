/**
 * timeline.js — Timeline / scrubber de l'historique audio (Canvas 2D).
 *
 * Affiche graves / médiums / aigus / intensité sur la plage visible,
 * les pics détectés, la fenêtre 3D courante et le curseur de lecture
 * avec sa traînée. Interactions :
 *   clic / glisser       → déplacer le curseur (quitte le direct)
 *   molette              → zoom temporel
 *   Maj + molette        → défilement
 *   double-clic          → retour au direct
 */
import { Emitter, clamp, formatClock, formatOffset, hexToRgb } from './utils.js';
import { CATEGORIES } from './sound-labels.js';

export const TIMELINE_ZOOMS = [10, 30, 60, 120, 300, 600, 0]; // 0 = tout l'historique

const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`; };

export class Timeline extends Emitter {
  constructor(canvas, history, transport, settings) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.history = history;
    this.transport = transport;
    this.settings = settings;
    this.colors = null;
    this.viewEnd = 0;
    this.span = 60;
    this.dragging = false;
    this.hoverX = -1;
    this.trail = [];          // positions récentes du curseur { t, at }
    this.detections = [];     // sons identifiés (partagé avec le module de reconnaissance)
    this.w = 0; this.h = 0;
    this._bind();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._resize();
  }

  setTheme(c) {
    this.colors = c;
    this.css = {
      bass: rgba(c.bass, 0.38), bassLine: rgba(c.bass, 0.9),
      mid: rgba(c.mid, 0.3), midLine: rgba(c.mid, 0.85),
      treble: rgba(c.treble, 0.26), trebleLine: rgba(c.treble, 0.85),
      text: rgba(c.text, 0.85), textDim: rgba(c.text, 0.45), grid: rgba(c.grid, 1),
      win: rgba(c.accent, 0.08), winEdge: rgba(c.accent, 0.55),
    };
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  get pad() { return { l: 12, r: 52, top: 18, bottom: 6 }; }

  _xToTime(x) {
    const p = this.pad;
    const f = clamp((x - p.l) / (this.w - p.l - p.r), 0, 1);
    return this.viewEnd - this.span + f * this.span;
  }
  _timeToX(t) {
    const p = this.pad;
    return p.l + ((t - (this.viewEnd - this.span)) / this.span) * (this.w - p.l - p.r);
  }

  _bind() {
    const c = this.canvas;
    const local = (e) => e.clientX - c.getBoundingClientRect().left;
    c.addEventListener('pointerdown', (e) => {
      if (!this.history.length) return;
      c.setPointerCapture(e.pointerId);
      this.dragging = true;
      this._manual = false;
      this.transport.seek(this._xToTime(local(e)));
      this.emit('scrub', true);
    });
    c.addEventListener('pointermove', (e) => {
      this.hoverX = local(e);
      if (this.dragging) this.transport.seek(this._xToTime(this.hoverX));
    });
    const end = () => { if (this.dragging) { this.dragging = false; this.emit('scrub', false); } };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { this.hoverX = -1; });
    c.addEventListener('dblclick', () => this.transport.goLive());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = (e.deltaX || e.deltaY) / this.w * this.span;
        this.viewEnd = clamp(this.viewEnd + d, this.history.oldestTime + this.span * 0.2, this.history.latestTime);
        this._manual = true;
        return;
      }
      const zooms = TIMELINE_ZOOMS;
      const cur = zooms.indexOf(this.settings.get('timelineZoom'));
      const next = clamp((cur < 0 ? 2 : cur) + (e.deltaY > 0 ? 1 : -1), 0, zooms.length - 1);
      this.settings.set('timelineZoom', zooms[next]);
    }, { passive: false });
  }

  /**
   * Dessine la timeline.
   * @param {object} v { liveTime, ws, we }
   */
  draw(v) {
    if (!this.colors) return;
    const { ctx, w, h, history: hist, transport: tr } = this;
    const css = this.css, c = this.colors, p = this.pad;
    const zoom = this.settings.get('timelineZoom');
    this.span = zoom > 0 ? zoom : Math.max(10, this.settings.get('retention'));
    const latest = Math.max(v.liveTime, hist.latestTime);

    // Plage visible : suit le direct, sinon garde le curseur dans le champ.
    if (!this.dragging) {
      if (tr.isLive) { this.viewEnd = latest; this._manual = false; }
      else if (!this._manual) {
        const cur = tr.cursor;
        if (cur > this.viewEnd - this.span * 0.05) this.viewEnd = cur + this.span * 0.25;
        if (cur < this.viewEnd - this.span * 0.95) this.viewEnd = cur + this.span * 0.7;
        this.viewEnd = Math.min(this.viewEnd, latest);
      }
    }
    const t0 = this.viewEnd - this.span, t1 = this.viewEnd;
    const gx0 = p.l, gx1 = w - p.r, gy0 = p.top, gy1 = h - p.bottom, gh = gy1 - gy0;

    ctx.clearRect(0, 0, w, h);

    // Fond du graphe.
    ctx.fillStyle = rgba(c.bg, 0.55);
    ctx.fillRect(gx0, gy0, gx1 - gx0, gh);

    // Zone hors historique (avant le début de l'enregistrement).
    if (hist.length) {
      const xo = this._timeToX(hist.oldestTime);
      if (xo > gx0) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(gx0, gy0, Math.min(xo, gx1) - gx0, gh);
      }
    }

    // Repères temporels (relatifs au direct).
    const step = this._tickStep(this.span, gx1 - gx0);
    ctx.font = '600 10px "JetBrains Mono", "Cascadia Mono", Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const firstRel = Math.ceil((t0 - latest) / step) * step;
    for (let rel = firstRel; latest + rel <= t1 + 1e-6; rel += step) {
      const x = this._timeToX(latest + rel);
      if (x < gx0 - 1) continue;
      ctx.fillStyle = css.grid;
      ctx.fillRect(Math.round(x), gy0, 1, gh);
      ctx.fillStyle = Math.abs(rel) < 1e-6 ? css.text : css.textDim;
      const label = Math.abs(rel) < 1e-6 ? 'NOW' : (step < 60 ? `${Math.round(rel)}s` : formatOffset(rel));
      ctx.fillText(label, x, 8);
    }

    // Fenêtre visible dans la 3D.
    const wx0 = clamp(this._timeToX(v.ws), gx0, gx1), wx1 = clamp(this._timeToX(v.we), gx0, gx1);
    if (wx1 > wx0) {
      ctx.fillStyle = css.win;
      ctx.fillRect(wx0, gy0, wx1 - wx0, gh);
      ctx.fillStyle = css.winEdge;
      ctx.fillRect(wx0, gy0, wx1 - wx0, 2);
      ctx.fillRect(wx0, gy1 - 2, wx1 - wx0, 2);
    }

    // Courbes graves / médiums / aigus / intensité.
    if (hist.length > 1) this._drawCurves(t0, t1, gx0, gx1, gy0, gy1);

    // Pics détectés.
    ctx.fillStyle = c.peak;
    for (const pk of hist.peaks) {
      if (pk.time < t0 || pk.time > t1) continue;
      const x = this._timeToX(pk.time);
      const s = 3 + pk.intensity * 3;
      ctx.globalAlpha = 0.5 + 0.5 * pk.intensity;
      ctx.beginPath();
      ctx.moveTo(x, gy0 + 1); ctx.lineTo(x - s, gy0 + 1 + s * 1.4); ctx.lineTo(x + s, gy0 + 1 + s * 1.4);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha *= 0.3;
      ctx.fillRect(x - 0.5, gy0, 1, gh);
    }
    ctx.globalAlpha = 1;

    // Sons identifiés : bandes colorées par catégorie en bas du graphe.
    ctx.font = '600 9px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const d of this.detections) {
      if (d.end < t0 || d.start > t1) continue;
      const x0 = clamp(this._timeToX(d.start), gx0, gx1), x1 = clamp(this._timeToX(d.end), gx0, gx1);
      const col = (CATEGORIES[d.category] || CATEGORIES.other).color;
      ctx.fillStyle = rgba(col, 0.22);
      ctx.fillRect(x0, gy1 - 14, Math.max(2, x1 - x0), 13);
      ctx.fillStyle = col;
      ctx.fillRect(x0, gy1 - 3, Math.max(2, x1 - x0), 2);
      if (x1 - x0 > 46) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, gy1 - 14, x1 - x0, 13); ctx.clip();
        ctx.fillStyle = c.text;
        ctx.fillText(`${(CATEGORIES[d.category] || CATEGORIES.other).icon} ${d.label}`, x0 + 4, gy1 - 8);
        ctx.restore();
      }
    }

    // Survol.
    if (this.hoverX >= gx0 && this.hoverX <= gx1 && !this.dragging) {
      ctx.fillStyle = css.textDim;
      ctx.fillRect(Math.round(this.hoverX), gy0, 1, gh);
      const ht = this._xToTime(this.hoverX);
      this._tag(this.hoverX, gy1 - 9, `${formatClock(ht)}  ${formatOffset(ht - latest)}`, rgba(c.bg, 0.9), css.text);
    }

    // Traînée du curseur : échos des positions récentes.
    const now = performance.now();
    const cur = tr.cursor;
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.abs(last.t - cur) > 1e-4) this.trail.push({ t: cur, at: now });
    while (this.trail.length && now - this.trail[0].at > 700) this.trail.shift();
    if (this.trail.length > 1) {
      const xc = this._timeToX(cur);
      for (const e of this.trail) {
        const a = 1 - (now - e.at) / 700;
        const x = this._timeToX(e.t);
        if (x < gx0 || x > gx1) continue;
        ctx.fillStyle = rgba(c.cursor, 0.28 * a * a);
        ctx.fillRect(x - 1, gy0, 2, gh);
      }
      const xo = this._timeToX(this.trail[0].t);
      const grad = ctx.createLinearGradient(xo, 0, xc, 0);
      grad.addColorStop(0, rgba(c.cursor, 0));
      grad.addColorStop(1, rgba(c.cursor, 0.5));
      ctx.fillStyle = grad;
      ctx.fillRect(Math.min(xo, xc), gy0 + gh / 2 - 2, Math.abs(xc - xo), 4);
    }

    // Curseur de lecture.
    const xc = clamp(this._timeToX(cur), gx0, gx1);
    ctx.save();
    ctx.shadowColor = c.cursor;
    ctx.shadowBlur = 12;
    ctx.fillStyle = c.cursor;
    ctx.fillRect(Math.round(xc) - 1, gy0 - 2, 2, gh + 2);
    ctx.restore();
    ctx.fillStyle = c.cursor;
    ctx.beginPath();
    ctx.moveTo(xc - 6, gy0 - 8); ctx.lineTo(xc + 6, gy0 - 8); ctx.lineTo(xc + 6, gy0 - 2); ctx.lineTo(xc, gy0 + 4); ctx.lineTo(xc - 6, gy0 - 2);
    ctx.closePath(); ctx.fill();
    const label = tr.isLive ? 'LIVE' : formatOffset(cur - latest);
    this._tag(clamp(xc, gx0 + 34, gx1 - 34), gy0 + gh / 2, label, c.cursor, c.bg, true);

    // Bord du direct.
    ctx.fillStyle = tr.isLive ? c.accent : css.textDim;
    ctx.textAlign = 'left';
    ctx.fillText(tr.isLive ? '● LIVE' : '○ LIVE', gx1 + 6, gy0 + gh / 2);
  }

  _drawCurves(t0, t1, gx0, gx1, gy0, gy1) {
    const { ctx, history: hist, css } = this;
    const gh = gy1 - gy0;
    const step = 2;
    const nCols = Math.ceil((gx1 - gx0) / step);
    const cols = this._cols?.length === nCols * 4 ? this._cols : (this._cols = new Float32Array(nCols * 4));
    cols.fill(-1);
    // Parcours séquentiel : O(tranches + colonnes).
    let i = 0;
    const n = hist.length;
    const startFi = hist.indexAt(Math.max(t0, hist.oldestTime));
    i = Number.isNaN(startFi) ? 0 : Math.floor(startFi);
    const dtc = (t1 - t0) / nCols;
    for (let k = 0; k < nCols; k++) {
      const ce = t0 + (k + 1) * dtc;
      let b = -1, m = -1, tr = -1, it = -1;
      while (i < n && hist.time(i) < ce) {
        if (hist.time(i) >= t0 + k * dtc) {
          b = Math.max(b, hist.bass(i)); m = Math.max(m, hist.mid(i));
          tr = Math.max(tr, hist.treble(i)); it = Math.max(it, hist.intensity(i));
        }
        i++;
      }
      cols[k * 4] = b; cols[k * 4 + 1] = m; cols[k * 4 + 2] = tr; cols[k * 4 + 3] = it;
    }
    // Comble les colonnes vides isolées (zoom avant > cadence d'échantillonnage).
    for (let k = 1; k < nCols; k++) {
      if (cols[k * 4 + 3] < 0 && cols[(k - 1) * 4 + 3] >= 0) {
        const nxt = k + 1 < nCols ? cols[(k + 1) * 4 + 3] : -1;
        if (nxt >= 0 || (t0 + k * dtc) < hist.latestTime) for (let j = 0; j < 4; j++) cols[k * 4 + j] = cols[(k - 1) * 4 + j];
      }
    }
    const area = (ch, fill, stroke, scale) => {
      ctx.beginPath();
      let open = false, xs = 0;
      for (let k = 0; k < nCols; k++) {
        const v = cols[k * 4 + ch];
        const x = gx0 + k * step;
        if (v < 0) { if (open) { ctx.lineTo(x, gy1); ctx.lineTo(xs, gy1); ctx.closePath(); open = false; } continue; }
        const y = gy1 - clamp(v * scale, 0, 1) * gh;
        if (!open) { ctx.moveTo(x, gy1); ctx.lineTo(x, y); xs = x; open = true; } else ctx.lineTo(x, y);
      }
      if (open) { const x = gx0 + (nCols - 1) * step; ctx.lineTo(x, gy1); ctx.lineTo(xs, gy1); ctx.closePath(); }
      ctx.fillStyle = fill; ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    };
    area(0, css.bass, null, 1.15);
    area(1, css.mid, null, 1.25);
    area(2, css.treble, null, 1.4);
    // Intensité globale : ligne nette.
    ctx.beginPath();
    let pen = false;
    for (let k = 0; k < nCols; k++) {
      const v = cols[k * 4 + 3];
      if (v < 0) { pen = false; continue; }
      const x = gx0 + k * step, y = gy1 - v * gh;
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.strokeStyle = css.text;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  _tickStep(span, px) {
    const target = span / Math.max(1, px / 70);
    for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 300]) if (s >= target) return s;
    return 600;
  }

  _tag(x, y, text, bg, fg, bold = false) {
    const { ctx } = this;
    ctx.font = `${bold ? 700 : 600} 10px "JetBrains Mono", "Cascadia Mono", Consolas, monospace`;
    const tw = ctx.measureText(text).width + 10;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(x - tw / 2, y - 8, tw, 16, 3);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
  }
}
