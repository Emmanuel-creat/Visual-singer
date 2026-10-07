/**
 * visualizer.js — Moteur 3D : terrain audio, grille, traînées, pics, curseur temporel.
 *
 * Repère de la scène (unités Three.js) :
 *   X (gauche → droite)  = TEMPS        : -W/2 = début de la fenêtre, +W/2 = fin (direct)
 *   Z (avant → arrière)  = FRÉQUENCE    : +D/2 = graves, -D/2 = aigus (échelle log)
 *   Y (bas → haut)       = INTENSITÉ    : 0 → H
 * L'interface nomme ces axes selon la convention demandée :
 *   X · TEMPS, Y · FRÉQUENCE, Z · INTENSITÉ.
 *
 * Performance : toute la géométrie est allouée à la construction (ou au
 * changement de qualité). Chaque image ne fait que réécrire des
 * Float32Array existants (hauteurs, glow, positions des lignes).
 */
import * as THREE from 'three';
import { OrbitCamera } from './orbit.js';
import { BANDS } from './audio.js';
import { clamp, damp, formatClock, formatFreq, hexToRgb } from './utils.js';

export const W = 36;   // largeur (temps)
export const D = 26;   // profondeur (fréquence)
export const H = 10;   // hauteur max (intensité)

export const QUALITY = {
  LOW:    { cols: 96,  rows: 48,  pixelRatio: 0.75, wire: false },
  MEDIUM: { cols: 160, rows: 64,  pixelRatio: 1,    wire: true },
  HIGH:   { cols: 256, rows: 96,  pixelRatio: 1.5,  wire: true },
  ULTRA:  { cols: 400, rows: 128, pixelRatio: 2,    wire: true },
};

/** Paramètres des traînées : intensité, estompage de l'historique, longueur par défaut (s). */
export const TRAIL_MODES = {
  none:       { label: 'Aucune',     strength: 0,    fade: 0.12, length: 0 },
  low:        { label: 'Faible',     strength: 0.45, fade: 0.25, length: 3 },
  medium:     { label: 'Moyenne',    strength: 0.75, fade: 0.42, length: 6 },
  high:       { label: 'Forte',      strength: 1,    fade: 0.62, length: 15 },
  persistent: { label: 'Persistante', strength: 1,   fade: 0.9,  length: Infinity },
};

const GAMMA = 1.35;
const MAX_TICKS = 48;
const MAX_MARKERS = 64;
const PEAK_LABELS = 4;
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

/* ----------------------------- Shaders ---------------------------------- */

const TERRAIN_VERT = /* glsl */`
  attribute float aH;
  attribute float aFx;
  attribute vec3 aZone;
  uniform float uHeight;
  uniform float uCursorX;
  varying vec3 vWorld;
  varying float vH;
  varying vec3 vZone;
  varying float vFx;
  varying float vAge;
  varying float vDist;
  void main() {
    vec3 p = position;
    p.y = aH * uHeight;
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorld = wp.xyz;
    vH = aH;
    vZone = aZone;
    vFx = aFx;
    vAge = (uCursorX - p.x) / ${W.toFixed(1)};
    vec4 mv = viewMatrix * wp;
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const TERRAIN_COMMON = /* glsl */`
  uniform vec3 uBass, uMid, uTreble, uPeak, uBg, uGrid, uCursor;
  uniform float uFade, uFogNear, uFogFar, uCursorX, uPulse;
  varying vec3 vWorld;
  varying float vH;
  varying vec3 vZone;
  varying float vFx;
  varying float vAge;
  varying float vDist;
  vec3 zoneColor() { return vZone.x * uBass + vZone.y * uMid + vZone.z * uTreble; }
  // Estompage selon l'âge (passé) ; le "futur" relatif au curseur est grisé.
  float ageFade() {
    return vAge >= 0.0 ? mix(1.0, uFade, smoothstep(0.0, 1.0, vAge)) : 0.38;
  }
  float fogF() { return smoothstep(uFogNear, uFogFar, vDist); }
`;

const TERRAIN_FRAG = /* glsl */`
  uniform float uContours;
  ${TERRAIN_COMMON}
  void main() {
    vec3 base = zoneColor();
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    float light = 0.5 + 0.5 * clamp(dot(n, normalize(vec3(0.35, 1.0, 0.45))), 0.0, 1.0);
    float h = vH;
    vec3 col = base * (0.14 + 1.3 * h) * light;
    // Les crêtes les plus hautes virent vers la couleur des pics.
    col = mix(col, uPeak, smoothstep(0.78, 1.0, h) * 0.8);
    // Halo des pics détectés.
    col += uPeak * max(vFx, 0.0) * 0.5;
    // Lignes de niveau (iso-intensité).
    if (uContours > 0.5) {
      float k = h * 12.0;
      float d = abs(fract(k - 0.5) - 0.5);
      float line = 1.0 - smoothstep(0.0, fwidth(k) * 1.3, d);
      col += base * line * 0.35 * step(0.03, h);
    }
    col *= ageFade();
    // Mise en valeur de la tranche sous le curseur.
    col += uCursor * 0.22 * exp(-abs(vWorld.x - uCursorX) * 2.5) * (0.3 + h);
    // Zones sans données (avant le début / au-delà du direct).
    col = mix(col, uBg * 0.92 + uGrid * 0.08, step(vFx, -0.5));
    col = mix(col, uBg, fogF());
    gl_FragColor = vec4(col, 1.0);
  }
`;

const WIRE_FRAG = /* glsl */`
  uniform float uWireAlpha;
  ${TERRAIN_COMMON}
  void main() {
    if (vFx < -0.5) discard;
    vec3 col = mix(zoneColor(), uGrid, 0.25) * (0.35 + 1.4 * vH);
    float a = uWireAlpha * ageFade() * (1.0 - fogF());
    gl_FragColor = vec4(col * a, 1.0);
  }
`;

const GLOW_VERT = /* glsl */`
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uScale;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
    gl_Position = projectionMatrix * mv;
  }
`;
const GLOW_FRAG = /* glsl */`
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float core = smoothstep(0.35, 0.0, d);
    float halo = pow(max(1.0 - d, 0.0), 2.2);
    gl_FragColor = vec4(vColor * (halo * 0.8 + core), 1.0);
  }
`;

/* ------------------------- Calques de libellés ---------------------------- */

/** Libellés HTML projetés depuis la 3D (nets à toutes les résolutions). */
class LabelLayer {
  constructor(el) {
    this.el = el;
    this.items = [];
    this._v = new THREE.Vector3();
  }
  add(cls) {
    const div = document.createElement('div');
    div.className = `lbl ${cls}`;
    this.el.appendChild(div);
    const item = { div, pos: new THREE.Vector3(), text: '', visible: true, shown: true, cls };
    this.items.push(item);
    return item;
  }
  text(item, t) {
    if (item.text !== t) { item.text = t; item.div.textContent = t; }
  }
  update(camera, w, h) {
    const v = this._v;
    for (const it of this.items) {
      let show = it.visible;
      if (show) {
        v.copy(it.pos).project(camera);
        show = v.z < 1 && v.x > -1.2 && v.x < 1.2 && v.y > -1.2 && v.y < 1.2;
        if (show) it.div.style.transform = `translate3d(${((v.x + 1) * 0.5 * w).toFixed(1)}px,${((1 - v.y) * 0.5 * h).toFixed(1)}px,0)`;
      }
      if (show !== it.shown) { it.div.style.display = show ? '' : 'none'; it.shown = show; }
    }
  }
}

/* ------------------------------ Visualiseur ------------------------------- */

export class Visualizer {
  /**
   * @param {HTMLElement} container  élément accueillant le canvas WebGL
   * @param {HTMLElement} labelEl    calque des libellés HTML
   */
  constructor(container, labelEl) {
    this.container = container;
    this.labels = new LabelLayer(labelEl);
    this.colors = null;
    this.qualityName = 'HIGH';
    this.q = QUALITY.HIGH;
    this.pulse = 0;
    this.freq = { fmin: 20, fmax: 20000, bassMax: 250, midMax: 4000 };
    this.db = { min: -95, max: -20 };
    this.heightScale = 1;
    this.showLabels = true;
    this.hLut = new Float32Array(256);
    for (let i = 0; i < 256; i++) this.hLut[i] = Math.pow(i / 255, GAMMA);
    this.colTmp = new Float32Array(BANDS);
    this.cursorX = W / 2;
    this.lastCursor = 0;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.q.pixelRatio));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 600);
    this.orbit = new OrbitCamera(this.camera, this.renderer.domElement);

    this._initUniforms();
    this._buildTerrain();
    this._buildStatic();
    this._buildDynamicLines();
    this._buildMarkers();
    this._buildLabels();

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this.resize();
  }

  /* ------------------------------ Construction ---------------------------- */

  _initUniforms() {
    const v3 = () => ({ value: new THREE.Color() });
    this.u = {
      uBass: v3(), uMid: v3(), uTreble: v3(), uPeak: v3(), uBg: v3(), uGrid: v3(), uCursor: v3(),
      uHeight: { value: H }, uCursorX: { value: W / 2 }, uFade: { value: 0.4 },
      uFogNear: { value: 60 }, uFogFar: { value: 160 }, uPulse: { value: 0 },
      uContours: { value: 1 }, uWireAlpha: { value: 0.22 },
    };
    this.glowUniforms = { uScale: { value: 400 } };
  }

  _glowMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: this.glowUniforms,
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  /** (Re)construit la surface du terrain selon la qualité courante. */
  _buildTerrain() {
    if (this.terrain) {
      this.scene.remove(this.terrain, this.wire, this.ridgeLine, this.ridgePts, this.sliceLine, this.holdLine);
      this.terrain.geometry.dispose();
      this.terrain.material.dispose();
      this.wire.material.dispose();
      for (const o of [this.ridgeLine, this.ridgePts, this.sliceLine, this.holdLine]) { o.geometry.dispose(); o.material.dispose(); }
    }
    const { cols, rows } = this.q;
    const n = cols * rows;
    const pos = new Float32Array(n * 3);
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const i = (c * rows + r) * 3;
        pos[i] = -W / 2 + (c / (cols - 1)) * W;
        pos[i + 2] = D / 2 - (r / (rows - 1)) * D;
      }
    }
    const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let k = 0;
    for (let c = 0; c < cols - 1; c++) {
      for (let r = 0; r < rows - 1; r++) {
        const a = c * rows + r, b = a + rows, c1 = a + 1, d = b + 1;
        index[k++] = a; index[k++] = b; index[k++] = c1;
        index[k++] = b; index[k++] = d; index[k++] = c1;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.hAttr = new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    this.fxAttr = new THREE.BufferAttribute(new Float32Array(n).fill(-1), 1).setUsage(THREE.DynamicDrawUsage);
    this.zoneAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    g.setAttribute('aH', this.hAttr);
    g.setAttribute('aFx', this.fxAttr);
    g.setAttribute('aZone', this.zoneAttr);
    g.setIndex(new THREE.BufferAttribute(index, 1));

    const solidMat = new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    const wireMat = new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: TERRAIN_VERT, fragmentShader: WIRE_FRAG,
      wireframe: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.terrain = new THREE.Mesh(g, solidMat);
    this.wire = new THREE.Mesh(g, wireMat);
    this.terrain.frustumCulled = this.wire.frustumCulled = false;
    this.wire.visible = this.q.wire && this.wireEnabled !== false;

    // Correspondance ligne de la grille → bandes (max sur le voisinage pour garder les pics).
    this.rowLo = new Uint16Array(rows);
    this.rowHi = new Uint16Array(rows);
    const half = (BANDS / rows) * 0.5;
    for (let r = 0; r < rows; r++) {
      const bp = (r / (rows - 1)) * (BANDS - 1);
      this.rowLo[r] = clamp(Math.round(bp - half + 0.5), 0, BANDS - 1);
      this.rowHi[r] = clamp(Math.round(bp + half - 0.5), this.rowLo[r], BANDS - 1);
    }
    this.colDom = new Float32Array(cols);
    this.slice = new Float32Array(rows);
    this.hold = new Float32Array(rows);

    // Crête de la fréquence dominante (segments + points lumineux).
    const rg = new THREE.BufferGeometry();
    this.ridgePos = new THREE.BufferAttribute(new Float32Array((cols - 1) * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.ridgeCol = new THREE.BufferAttribute(new Float32Array((cols - 1) * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    rg.setAttribute('position', this.ridgePos);
    rg.setAttribute('color', this.ridgeCol);
    this.ridgeLine = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    const pg = new THREE.BufferGeometry();
    this.ridgePtPos = new THREE.BufferAttribute(new Float32Array(cols * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.ridgePtCol = new THREE.BufferAttribute(new Float32Array(cols * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.ridgePtSize = new THREE.BufferAttribute(new Float32Array(cols).fill(0.55), 1);
    pg.setAttribute('position', this.ridgePtPos);
    pg.setAttribute('aColor', this.ridgePtCol);
    pg.setAttribute('aSize', this.ridgePtSize);
    this.ridgePts = new THREE.Points(pg, this._glowMaterial());

    // Spectre sous le curseur + maintien des crêtes (peak hold).
    const mkLine = () => {
      const lg = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(new Float32Array(rows * 3), 3).setUsage(THREE.DynamicDrawUsage);
      lg.setAttribute('position', attr);
      const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      line.frustumCulled = false;
      return [line, attr];
    };
    [this.sliceLine, this.slicePos] = mkLine();
    [this.holdLine, this.holdPos] = mkLine();
    for (const o of [this.ridgeLine, this.ridgePts]) o.frustumCulled = false;

    this.scene.add(this.terrain, this.wire, this.ridgeLine, this.ridgePts, this.sliceLine, this.holdLine);
    this._updateZoneAttr();
    if (this.colors) this.setTheme(this.colors);
  }

  /** Poids graves/médiums/aigus par ligne, avec fondu d'un tiers d'octave aux frontières. */
  _updateZoneAttr() {
    const { rows, cols } = this.q;
    const arr = this.zoneAttr.array;
    const s = 0.3;
    const smooth = (x) => { const t = clamp((x + s) / (2 * s), 0, 1); return t * t * (3 - 2 * t); };
    const w = new Float32Array(rows * 3);
    for (let r = 0; r < rows; r++) {
      const f = this.rowFreq(r);
      const tb = 1 - smooth(Math.log2(f / this.freq.bassMax));
      const tt = smooth(Math.log2(f / this.freq.midMax));
      w[r * 3] = tb; w[r * 3 + 1] = clamp(1 - tb - tt, 0, 1); w[r * 3 + 2] = tt;
    }
    for (let c = 0; c < cols; c++) arr.set(w, c * rows * 3);
    this.zoneAttr.needsUpdate = true;
  }

  rowFreq(r) {
    const { fmin, fmax } = this.freq;
    return fmin * Math.pow(fmax / fmin, r / (this.q.rows - 1));
  }

  freqToZ(f) {
    const { fmin, fmax } = this.freq;
    const t = clamp(Math.log(f / fmin) / Math.log(fmax / fmin), 0, 1);
    return D / 2 - t * D;
  }

  /** Grille statique, murs, axes et bandes de zones au sol. */
  _buildStatic() {
    if (this.staticGroup) {
      this.scene.remove(this.staticGroup);
      this.staticGroup.traverse((o) => { o.geometry?.dispose(); });
    }
    const grp = new THREE.Group();
    this.staticGroup = grp;
    this.gridMat ??= new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
    this.gridFaintMat ??= new THREE.LineBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false });
    this.zoneLineMat ??= new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false });
    this.axisMat ??= new THREE.LineBasicMaterial({ transparent: true, opacity: 0.95 });

    const seg = (pts, mat) => {
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
      const l = new THREE.LineSegments(g, mat);
      grp.add(l);
      return l;
    };
    const { fmin, fmax } = this.freq;
    const ticks = FREQ_TICKS.filter((f) => f >= fmin && f <= fmax);
    const x0 = -W / 2, x1 = W / 2, z0 = -D / 2, z1 = D / 2;

    // Sol : lignes de fréquence + cadre.
    const floor = [];
    for (const f of ticks) { const z = this.freqToZ(f); floor.push(x0, 0, z, x1, 0, z); }
    floor.push(x0, 0, z0, x1, 0, z0, x0, 0, z1, x1, 0, z1, x0, 0, z0, x0, 0, z1, x1, 0, z0, x1, 0, z1);
    seg(floor, this.gridMat);

    // Murs du fond : x = -W/2 (fréquence × intensité) et z = -D/2 (temps × intensité).
    const wall = [];
    const levels = [0.25, 0.5, 0.75, 1];
    for (const l of levels) {
      const y = l * H;
      wall.push(x0, y, z0, x0, y, z1, x0, y, z0, x1, y, z0);
    }
    for (const f of ticks) { const z = this.freqToZ(f); wall.push(x0, 0, z, x0, H, z); }
    wall.push(x0, 0, z1, x0, H, z1, x1, 0, z0, x1, H, z0);
    seg(wall, this.gridFaintMat);

    // Frontières des zones (graves | médiums | aigus).
    const zl = [];
    for (const f of [this.freq.bassMax, this.freq.midMax]) {
      const z = this.freqToZ(f);
      zl.push(x0, 0.02, z, x1 + 1.2, 0.02, z, x0, 0, z, x0, H, z);
    }
    seg(zl, this.zoneLineMat);

    // Axes (avec flèches).
    const ax = [];
    const ar = 0.5;
    // X · temps : bord avant (côté graves), vers le direct.
    ax.push(x0, 0, z1 + 1, x1 + 2, 0, z1 + 1, x1 + 2, 0, z1 + 1, x1 + 2 - ar, 0, z1 + 1 - ar * 0.6, x1 + 2, 0, z1 + 1, x1 + 2 - ar, 0, z1 + 1 + ar * 0.6);
    // Y · fréquence : bord du direct, des graves vers les aigus.
    ax.push(x1 + 0.6, 0, z1, x1 + 0.6, 0, z0 - 2, x1 + 0.6, 0, z0 - 2, x1 + 0.6 - ar * 0.6, 0, z0 - 2 + ar, x1 + 0.6, 0, z0 - 2, x1 + 0.6 + ar * 0.6, 0, z0 - 2 + ar);
    // Z · intensité : arête verticale arrière.
    ax.push(x1 + 0.6, 0, z0, x1 + 0.6, H + 1.5, z0, x1 + 0.6, H + 1.5, z0, x1 + 0.6 - ar * 0.5, H + 1.5 - ar, z0, x1 + 0.6, H + 1.5, z0, x1 + 0.6 + ar * 0.5, H + 1.5 - ar, z0);
    for (const l of levels) ax.push(x1 + 0.3, l * H, z0, x1 + 0.9, l * H, z0);
    seg(ax, this.axisMat);

    // Bandes de zones au sol (s'illuminent selon le niveau de la zone).
    this.zoneMats ??= [0, 1, 2].map(() => new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    const bounds = [fmin, this.freq.bassMax, this.freq.midMax, fmax];
    this.zoneCenters = [];
    for (let i = 0; i < 3; i++) {
      const za = this.freqToZ(bounds[i]), zb = this.freqToZ(bounds[i + 1]);
      const depth = Math.max(0.01, za - zb);
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.1, depth), this.zoneMats[i]);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(x1 + 1.5, 0.01, (za + zb) / 2);
      grp.add(plane);
      this.zoneCenters.push((za + zb) / 2);
    }
    this.scene.add(grp);
    this.freqTicks = ticks;
  }

  /** Lignes dynamiques : repères temporels, curseur. */
  _buildDynamicLines() {
    const tg = new THREE.BufferGeometry();
    this.tickPos = new THREE.BufferAttribute(new Float32Array(MAX_TICKS * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    tg.setAttribute('position', this.tickPos);
    this.tickLines = new THREE.LineSegments(tg, this.gridFaintMat);
    this.tickLines.frustumCulled = false;
    this.scene.add(this.tickLines);

    // Plan du curseur temporel.
    const ch = H * 1.15;
    this.cursorMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    this.cursorPlane = new THREE.Mesh(new THREE.PlaneGeometry(D, ch), this.cursorMat);
    this.cursorPlane.rotation.y = Math.PI / 2;
    this.cursorPlane.position.y = ch / 2;
    const eg = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0, -D / 2, 0, ch, -D / 2, 0, ch, -D / 2, 0, ch, D / 2, 0, ch, D / 2, 0, 0, D / 2, 0, 0, D / 2, 0, 0, -D / 2,
    ]), 3));
    this.cursorEdgeMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false });
    this.cursorEdge = new THREE.LineSegments(eg, this.cursorEdgeMat);
    this.cursorGroup = new THREE.Group();
    this.cursorGroup.add(this.cursorPlane, this.cursorEdge);
    this.scene.add(this.cursorGroup);
  }

  /** Marqueurs de pics : faisceaux verticaux + points lumineux (pools fixes). */
  _buildMarkers() {
    const bg = new THREE.BufferGeometry();
    this.beamPos = new THREE.BufferAttribute(new Float32Array(MAX_MARKERS * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.beamCol = new THREE.BufferAttribute(new Float32Array(MAX_MARKERS * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    bg.setAttribute('position', this.beamPos);
    bg.setAttribute('color', this.beamCol);
    this.beams = new THREE.LineSegments(bg, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    const pg = new THREE.BufferGeometry();
    this.mkPos = new THREE.BufferAttribute(new Float32Array(MAX_MARKERS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.mkCol = new THREE.BufferAttribute(new Float32Array(MAX_MARKERS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.mkSize = new THREE.BufferAttribute(new Float32Array(MAX_MARKERS), 1).setUsage(THREE.DynamicDrawUsage);
    pg.setAttribute('position', this.mkPos);
    pg.setAttribute('aColor', this.mkCol);
    pg.setAttribute('aSize', this.mkSize);
    this.markers = new THREE.Points(pg, this._glowMaterial());
    this.beams.frustumCulled = this.markers.frustumCulled = false;
    this.scene.add(this.beams, this.markers);
  }

  _buildLabels() {
    const L = this.labels;
    this.lblTicks = Array.from({ length: MAX_TICKS }, () => L.add('tick-time'));
    this.lblFreq = FREQ_TICKS.map(() => L.add('tick-freq'));
    this.lblDb = [0.25, 0.5, 0.75, 1].map(() => L.add('tick-db'));
    this.lblAxes = ['X · TEMPS', 'Y · FRÉQUENCE', 'Z · INTENSITÉ'].map((t) => { const it = L.add('axis-title'); L.text(it, t); return it; });
    this.lblZones = ['bass', 'mid', 'treble'].map((z) => L.add(`zone zone-${z}`));
    this.lblCursor = L.add('cursor-tag');
    this.lblPeaks = Array.from({ length: PEAK_LABELS }, () => L.add('peak-tag'));
    this._placeStaticLabels();
  }

  _placeStaticLabels() {
    const x1 = W / 2;
    this.lblFreq.forEach((it, i) => {
      const f = FREQ_TICKS[i];
      it.staticVisible = this.freqTicks.includes(f);
      it.pos.set(x1 + 3.2, 0, this.freqToZ(f));
      this.labels.text(it, formatFreq(f, true));
    });
    this.lblAxes[0].pos.set(x1 + 3.2, 0, D / 2 + 1);
    this.lblAxes[1].pos.set(x1 + 0.6, 0, -D / 2 - 3);
    this.lblAxes[2].pos.set(x1 + 0.6, H + 2.4, -D / 2);
    this.lblDb.forEach((it, i) => it.pos.set(x1 + 1.4, ((i + 1) / 4) * H, -D / 2));
    this.lblZones.forEach((it, i) => it.pos.set(x1 + 5.6, 0, this.zoneCenters[i]));
    this._updateDbLabels();
  }

  _updateDbLabels() {
    this.lblDb.forEach((it, i) => {
      const y = (i + 1) / 4;
      const v = Math.pow(clamp(y / this.heightScale, 0, 1), 1 / GAMMA);
      this.labels.text(it, `${Math.round(this.db.min + v * (this.db.max - this.db.min))} dB`);
    });
  }

  /* ------------------------------- Réglages ------------------------------- */

  setQuality(name) {
    if (!QUALITY[name] || name === this.qualityName) return;
    this.qualityName = name;
    this.q = QUALITY[name];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.q.pixelRatio));
    this._buildTerrain();
    this.resize();
  }

  setWireframe(on) { this.wireEnabled = on; this.wire.visible = on && this.q.wire; }
  setContours(on) { this.u.uContours.value = on ? 1 : 0; }
  setHeightScale(v) { this.heightScale = v; this._updateDbLabels(); }
  setDecibels(min, max) { this.db = { min, max }; this._updateDbLabels(); }
  setShowLabels(on) { this.showLabels = on; this.labels.el.style.display = on ? '' : 'none'; }

  /** Change la plage de fréquences affichée et les frontières des zones. */
  setFreqLayout({ fmin, fmax, bassMax, midMax }) {
    this.freq = { fmin, fmax, bassMax, midMax };
    this._updateZoneAttr();
    this._buildStatic();
    this._placeStaticLabels();
    if (this.colors) this.setTheme(this.colors);
  }

  setTheme(c) {
    this.colors = c;
    const set = (u, hex) => u.value.setRGB(...hexToRgb(hex));
    set(this.u.uBass, c.bass); set(this.u.uMid, c.mid); set(this.u.uTreble, c.treble);
    set(this.u.uPeak, c.peak); set(this.u.uBg, c.bg); set(this.u.uGrid, c.grid); set(this.u.uCursor, c.cursor);
    this.renderer.setClearColor(c.bg);
    this.gridMat.color.set(c.grid).multiplyScalar(1.6);
    this.gridFaintMat.color.set(c.grid).multiplyScalar(1.3);
    this.zoneLineMat.color.set(c.accent);
    this.axisMat.color.set(c.axis);
    this.zoneMats[0].color.set(c.bass); this.zoneMats[1].color.set(c.mid); this.zoneMats[2].color.set(c.treble);
    this.cursorMat.color.set(c.cursor);
    this.cursorEdgeMat.color.set(c.cursor);
    this.sliceLine.material.color.set(c.cursor);
    this.holdLine.material.color.set(c.trail);
    this._trailRgb = hexToRgb(c.trail);
    this._peakRgb = hexToRgb(c.peak);
  }

  /** Déclenche la pulsation visuelle d'un nouveau pic. */
  triggerPulse() { this.pulse = 1; }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.glowUniforms.uScale.value = (h * pr) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  /* ------------------------------ Mise à jour ------------------------------ */

  /**
   * Met à jour la scène pour l'instant affiché.
   * @param {number} dt
   * @param {object} s  { history, cursor, ws, we, trail:{strength,fade,length}, zones:{bass,mid,treble}, live }
   */
  update(dt, s) {
    const { history, cursor, ws, we } = s;
    this.pulse = Math.max(0, this.pulse - dt * 2.5);
    const pulse = 1 + 0.12 * this.pulse * this.pulse;
    const Hs = H * this.heightScale * pulse;
    this.u.uHeight.value = Hs;
    this.u.uFade.value = s.trail.fade;
    const span = Math.max(0.001, we - ws);
    const toX = (t) => -W / 2 + ((t - ws) / span) * W;

    // Curseur temporel (lissé pour des transitions douces).
    const targetX = clamp(toX(cursor), -W / 2, W / 2);
    this.cursorX += (targetX - this.cursorX) * (s.live ? 1 : damp(18, dt));
    this.u.uCursorX.value = this.cursorX;
    this.cursorGroup.position.x = this.cursorX;
    this.cursorMat.opacity = 0.06 + 0.1 * this.pulse;

    this._updateTerrain(history, ws, we, Hs);
    this._updateSlice(history, cursor, Hs, dt, s.trail);
    this._updateRidge(ws, we, cursor, Hs, s.trail);
    this._updateTicks(ws, we, toX);
    this._updateMarkers(history, ws, we, cursor, Hs, s.trail, toX);
    this._updateZones(s.zones);

    // Libellé du curseur.
    this.lblCursor.pos.set(this.cursorX, H * 1.15 + 0.4, D / 2);
    this.labels.text(this.lblCursor, s.live ? `● LIVE  ${formatClock(cursor)}` : `▼ ${formatClock(cursor)}`);
    this.lblCursor.div.classList.toggle('live', !!s.live);

    // Brouillard adapté à la distance caméra.
    const r = this.orbit.cur.radius;
    this.u.uFogNear.value = r * 1.05;
    this.u.uFogFar.value = r * 2.6;

    this.orbit.update(dt);
  }

  /** Échantillonne les bandes de l'historique au temps t dans colTmp. Renvoie l'indice ou NaN. */
  _sampleColumn(history, t, framesPerCol) {
    const fi = history.indexAt(t);
    if (Number.isNaN(fi)) return NaN;
    const tmp = this.colTmp, bands = history.bands, n = history.length;
    if (framesPerCol > 1.5) {
      const i0 = Math.max(0, Math.floor(fi - framesPerCol / 2));
      const i1 = Math.min(n - 1, Math.ceil(fi + framesPerCol / 2));
      tmp.fill(0);
      for (let i = i0; i <= i1; i++) {
        const o = history.bandOffset(i);
        for (let b = 0; b < BANDS; b++) { const v = bands[o + b]; if (v > tmp[b]) tmp[b] = v; }
      }
    } else {
      const i0 = Math.floor(fi), i1 = Math.min(i0 + 1, n - 1), k = fi - i0;
      const oa = history.bandOffset(i0), ob = history.bandOffset(i1);
      for (let b = 0; b < BANDS; b++) tmp[b] = bands[oa + b] + (bands[ob + b] - bands[oa + b]) * k;
    }
    return fi;
  }

  _updateTerrain(history, ws, we, Hs) {
    const { cols, rows } = this.q;
    const aH = this.hAttr.array, aFx = this.fxAttr.array;
    const lut = this.hLut, tmp = this.colTmp, rowLo = this.rowLo, rowHi = this.rowHi;
    const dtCol = (we - ws) / (cols - 1);
    const fpc = dtCol * history.rate;
    // Pics présents dans la fenêtre (halo sur le terrain).
    const peaks = history.peaks;
    let p0 = peaks.length;
    while (p0 > 0 && peaks[p0 - 1].time > ws - 0.5) p0--;
    for (let c = 0; c < cols; c++) {
      const t = ws + c * dtCol;
      const base = c * rows;
      const fi = this._sampleColumn(history, t, fpc);
      if (Number.isNaN(fi)) {
        aH.fill(0, base, base + rows);
        aFx.fill(-1, base, base + rows);
        this.colDom[c] = 0;
        continue;
      }
      this.colDom[c] = history.dom(Math.round(fi));
      let fx = 0;
      for (let k = p0; k < peaks.length; k++) {
        const d = Math.abs(t - peaks[k].time);
        if (d < 0.35) fx = Math.max(fx, 1 - d / 0.35);
      }
      for (let r = 0; r < rows; r++) {
        let v = 0;
        for (let b = rowLo[r]; b <= rowHi[r]; b++) if (tmp[b] > v) v = tmp[b];
        aH[base + r] = lut[v | 0];
        aFx[base + r] = fx;
      }
    }
    this.hAttr.needsUpdate = true;
    this.fxAttr.needsUpdate = true;
  }

  /** Spectre à l'instant du curseur + ligne de maintien des crêtes. */
  _updateSlice(history, cursor, Hs, dt, trail) {
    const { rows } = this.q;
    const ok = !Number.isNaN(this._sampleColumn(history, cursor, 0));
    const sp = this.slicePos.array, hp = this.holdPos.array;
    // Un saut du curseur (navigation) remet le maintien à zéro.
    if (Math.abs(cursor - this.lastCursor) > 0.5) this.hold.fill(0);
    this.lastCursor = cursor;
    const decay = trail.length === Infinity ? 0 : trail.length > 0 ? dt / trail.length : 1;
    const x = this.cursorX;
    for (let r = 0; r < rows; r++) {
      let v = 0;
      if (ok) for (let b = this.rowLo[r]; b <= this.rowHi[r]; b++) if (this.colTmp[b] > v) v = this.colTmp[b];
      const h = this.hLut[v | 0];
      this.slice[r] = h;
      this.hold[r] = Math.max(h, this.hold[r] - decay);
      const z = D / 2 - (r / (rows - 1)) * D;
      sp[r * 3] = x + 0.02; sp[r * 3 + 1] = h * Hs + 0.06; sp[r * 3 + 2] = z;
      hp[r * 3] = x + 0.04; hp[r * 3 + 1] = this.hold[r] * Hs + 0.12; hp[r * 3 + 2] = z;
    }
    this.slicePos.needsUpdate = true;
    this.holdPos.needsUpdate = true;
    this.sliceLine.visible = ok;
    this.holdLine.visible = ok && trail.strength > 0;
    this.holdLine.material.opacity = 0.9 * trail.strength;
  }

  /** Traînée de la fréquence dominante (ligne persistante sur le terrain). */
  _updateRidge(ws, we, cursor, Hs, trail) {
    const { cols, rows } = this.q;
    const visible = trail.strength > 0;
    this.ridgeLine.visible = this.ridgePts.visible = visible;
    if (!visible) return;
    const aH = this.hAttr.array;
    const pp = this.ridgePtPos.array, pc = this.ridgePtCol.array;
    const [tr, tg, tb] = this._trailRgb;
    const len = trail.length;
    const dtCol = (we - ws) / (cols - 1);
    for (let c = 0; c < cols; c++) {
      const t = ws + c * dtCol;
      const f = this.colDom[c];
      const x = -W / 2 + (c / (cols - 1)) * W;
      let a = 0, y = 0, z = 0;
      if (f > 0 && t <= cursor + 1e-3) {
        const age = cursor - t;
        a = trail.strength * (len === Infinity ? 1 : clamp(1 - age / Math.max(len, 0.01), 0, 1));
        z = this.freqToZ(f);
        const r = clamp(Math.round(((D / 2 - z) / D) * (rows - 1)), 0, rows - 1);
        y = aH[c * rows + r] * Hs + 0.18;
      }
      pp[c * 3] = x; pp[c * 3 + 1] = y; pp[c * 3 + 2] = z;
      pc[c * 3] = tr * a; pc[c * 3 + 1] = tg * a; pc[c * 3 + 2] = tb * a;
    }
    const lp = this.ridgePos.array, lc = this.ridgeCol.array;
    for (let c = 0; c < cols - 1; c++) {
      const i = c * 6;
      const jump = Math.abs(pp[c * 3 + 2] - pp[c * 3 + 5]) > 2.2;
      const a = jump ? 0 : 1;
      for (let k = 0; k < 3; k++) {
        lp[i + k] = pp[c * 3 + k];
        lp[i + 3 + k] = pp[c * 3 + 3 + k];
        lc[i + k] = Math.min(pc[c * 3 + k], pc[c * 3 + 3 + k]) * a;
        lc[i + 3 + k] = lc[i + k];
      }
    }
    this.ridgePos.needsUpdate = this.ridgeCol.needsUpdate = true;
    this.ridgePtPos.needsUpdate = this.ridgePtCol.needsUpdate = true;
  }

  /** Repères temporels défilants (horloge de session). */
  _updateTicks(ws, we, toX) {
    const span = we - ws;
    const step = span <= 6 ? 0.5 : span <= 15 ? 1 : span <= 40 ? 5 : span <= 90 ? 10 : span <= 240 ? 30 : 60;
    const first = Math.ceil(ws / step) * step;
    const arr = this.tickPos.array;
    let n = 0;
    for (let t = first; t <= we && n < MAX_TICKS; t += step) {
      const x = toX(t);
      const i = n * 12;
      arr[i] = x; arr[i + 1] = 0.01; arr[i + 2] = -D / 2;
      arr[i + 3] = x; arr[i + 4] = 0.01; arr[i + 5] = D / 2 + 0.5;
      arr[i + 6] = x; arr[i + 7] = 0; arr[i + 8] = -D / 2;
      arr[i + 9] = x; arr[i + 10] = H; arr[i + 11] = -D / 2;
      const lbl = this.lblTicks[n];
      lbl.visible = t >= 0;
      lbl.pos.set(x, 0, D / 2 + 1.9);
      this.labels.text(lbl, formatClock(t, step < 1 ? 1 : 0));
      n++;
    }
    for (let k = n; k < MAX_TICKS; k++) this.lblTicks[k].visible = false;
    this.tickLines.geometry.setDrawRange(0, n * 4);
    this.tickPos.needsUpdate = true;
  }

  /** Marqueurs des pics : apparition progressive, persistance selon la traînée. */
  _updateMarkers(history, ws, we, cursor, Hs, trail, toX) {
    const peaks = history.peaks;
    const persist = trail.length === Infinity ? Infinity : Math.max(0.8, trail.length * 1.5);
    const bp = this.beamPos.array, bc = this.beamCol.array;
    const mp = this.mkPos.array, mc = this.mkCol.array, ms = this.mkSize.array;
    const [pr, pg, pb] = this._peakRgb;
    let n = 0, labelled = 0, lastLabelT = Infinity;
    const labelGap = (we - ws) * 0.12; // évite l'empilement de libellés
    for (let k = peaks.length - 1; k >= 0 && n < MAX_MARKERS; k--) {
      const p = peaks[k];
      if (p.time > we) continue;
      if (p.time < ws) break;
      const age = cursor - p.time;
      let a;
      if (age < 0) a = 0.25;                                      // pic "à venir" pendant la relecture
      else {
        if (age > persist) continue;
        a = clamp(age / 0.25 + 0.2, 0, 1) * (persist === Infinity ? 1 : clamp(1 - age / persist, 0, 1) ** 0.5);
      }
      const x = toX(p.time), z = this.freqToZ(p.freq || 100), y = p.h * Hs;
      const top = y + 1.5 + 2.5 * p.intensity;
      const i = n * 6;
      bp[i] = x; bp[i + 1] = 0; bp[i + 2] = z; bp[i + 3] = x; bp[i + 4] = top; bp[i + 5] = z;
      bc[i] = pr * a * 0.15; bc[i + 1] = pg * a * 0.15; bc[i + 2] = pb * a * 0.15;
      bc[i + 3] = pr * a; bc[i + 4] = pg * a; bc[i + 5] = pb * a;
      mp[n * 3] = x; mp[n * 3 + 1] = y + 0.3; mp[n * 3 + 2] = z;
      mc[n * 3] = pr * a; mc[n * 3 + 1] = pg * a; mc[n * 3 + 2] = pb * a;
      ms[n] = (0.9 + 1.6 * p.intensity) * (age >= 0 && age < 0.4 ? 1 + (0.4 - age) * 2 : 1);
      if (labelled < PEAK_LABELS && age >= 0 && a > 0.3 && lastLabelT - p.time > labelGap) {
        lastLabelT = p.time;
        const lbl = this.lblPeaks[labelled++];
        lbl.visible = true;
        lbl.pos.set(x, top + 0.3, z);
        this.labels.text(lbl, `▲ ${p.db.toFixed(1)} dB · ${formatFreq(p.freq)} · ${formatClock(p.time)}`);
        lbl.div.style.opacity = a.toFixed(2);
      }
      n++;
    }
    for (let k = labelled; k < PEAK_LABELS; k++) this.lblPeaks[k].visible = false;
    this.beams.geometry.setDrawRange(0, n * 2);
    this.markers.geometry.setDrawRange(0, n);
    this.beamPos.needsUpdate = this.beamCol.needsUpdate = true;
    this.mkPos.needsUpdate = this.mkCol.needsUpdate = this.mkSize.needsUpdate = true;
  }

  _updateZones(z) {
    const levels = [z.bass, z.mid, z.treble];
    const max = Math.max(...levels);
    const names = ['GRAVES', 'MÉDIUMS', 'AIGUS'];
    levels.forEach((l, i) => {
      this.zoneMats[i].opacity = 0.06 + 0.5 * l;
      const lbl = this.lblZones[i];
      this.labels.text(lbl, `${names[i]} ${Math.round(l * 100)}%`);
      lbl.div.classList.toggle('dominant', max > 0.04 && l === max);
    });
  }

  render() {
    for (const it of this.lblFreq) it.visible = it.staticVisible;
    if (this.showLabels) this.labels.update(this.camera, this.width, this.height);
    this.renderer.render(this.scene, this.camera);
  }

  /** Vues caméra : '3D' | 'TOP' | 'FRONT' | 'SIDE' | 'RESET'. */
  setView(name) { this.orbit.setView(name === 'RESET' ? '3D' : name); }

  dispose() {
    this._ro.disconnect();
    this.scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
