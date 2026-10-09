/**
 * quality.js : Échelle « qualité » : vert = favorable, rouge = défavorable,
 * dégradé continu entre les deux (interpolation OKLab, milieu ambre).
 *
 * Palette validée sur fond sombre (#1a1b1f) : #e0384a → #c4851a → #14a88a,
 * interpolée en OKLCH pour garder des couleurs franches entre les étapes.
 * Le vert et le rouge restent proches pour certains daltonismes : chaque
 * couleur est toujours doublée d'un mot (« favorable », « intermédiaire »,
 * « défavorable ») ou d'une valeur affichée.
 *
 * q ∈ [0, 1] : 0 = défavorable, 1 = favorable.
 */

export const Q_BAD = '#e0384a';
export const Q_MID = '#c4851a';
export const Q_GOOD = '#14a88a';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** 0 à la valeur `bad`, 1 à la valeur `good` (fonctionne dans les deux sens). */
export const lin = (v, bad, good) => (v == null || !Number.isFinite(v) ? null : clamp01((v - bad) / (good - bad)));
/** Plage idéale [lo, hi], 0 aux bornes extrêmes. */
const band = (v, min, lo, hi, max) => (v == null ? null : v < lo ? lin(v, min, lo) : v > hi ? lin(v, max, hi) : 1);

/* ------------------------------------------------------- couleurs OKLab --- */

function hexToLin(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
}
function linToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin3 = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return lin3.map((c) => { c = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; return Math.round(clamp01(c) * 255); });
}
// Interpolation en OKLCH (teinte conservée) : évite le gris boueux entre ambre et vert.
const toLch = ([L, a, b]) => [L, Math.hypot(a, b), Math.atan2(b, a)];
const fromLch = ([L, C, h]) => [L, C * Math.cos(h), C * Math.sin(h)];
const STOPS = [Q_BAD, Q_MID, Q_GOOD].map((h) => toLch(linToOklab(hexToLin(h))));

/** Couleur de la qualité q (0 rouge → 1 vert). null → gris neutre. */
export function qColor(q, alpha = 1) {
  if (q == null || !Number.isFinite(q)) return `rgba(150,152,160,${alpha})`;
  const t = clamp01(q) * 2;
  const i = Math.min(1, Math.floor(t));
  const k = t - i;
  const a = STOPS[i], b = STOPS[i + 1];
  let dh = b[2] - a[2];
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;
  const [r, g, bl] = oklabToRgb(fromLch([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + dh * k]));
  return `rgba(${r},${g},${bl},${alpha})`;
}

/** Mot qui accompagne la couleur (jamais la couleur seule). */
export function qLabel(q) {
  if (q == null) return '';
  return q >= 0.67 ? 'favorable' : q >= 0.34 ? 'intermédiaire' : 'défavorable';
}

/* ------------------------------------------------ indicateurs de la nuit --- */

/** Qualité de chaque indicateur de METRICS (analysis.js), par clé. */
export const METRIC_Q = {
  sleepMin: (v) => (v > 600 ? lin(v, 720, 600) : lin(v, 300, 450)),
  efficiency: (v) => lin(v, 0.7, 0.9),
  latency: (v) => lin(v, 45, 15),
  awak: (v) => lin(v, 5, 1),
  waso: (v) => lin(v, 60, 15),
  snorePct: (v) => lin(v, 0.3, 0.05),
  snoreCount: (v) => lin(v, 600, 50),
  pauses: (v) => lin(v, 10, 1),
  rate: (v) => band(v, 8, 12, 18, 24),
  reg: (v) => lin(v, 0.3, 0.6),
  cough: (v) => lin(v, 10, 0),
  sneeze: (v) => lin(v, 6, 0),
  speech: (v) => lin(v, 10, 0),
  vocal: (v) => lin(v, 8, 0),
  brux: (v) => lin(v, 8, 0),
  move: (v) => lin(v, 20, 5),
  env: (v) => lin(v, 20, 3),
  l50: (v) => lin(v, -40, -60),
};

/** Qualité des séries temporelles et horaires. */
export const SERIES_Q = {
  snoreSecPerMin: (v) => lin(v, 40, 0),
  snoreDb: (v) => lin(v, -25, -50),
  rate: METRIC_Q.rate,
  reg: METRIC_Q.reg,
  level: (v) => lin(v, -35, -60),
  sleepState: (v) => (v >= 0.5 ? 1 : 0),
  hour: {
    snoreMin: (v) => lin(v, 20, 0),
    move: (v) => lin(v, 15, 2),
    cough: (v) => lin(v, 5, 0),
    pauses: (v) => lin(v, 8, 0),
    env: (v) => lin(v, 8, 0),
  },
};
