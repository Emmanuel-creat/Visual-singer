/**
 * orbit.js — Caméra orbitale amortie (rotation, zoom, déplacement, vues prédéfinies).
 *
 * Coordonnées sphériques autour d'une cible :
 *   theta = azimut (0 → caméra sur +Z, π/2 → caméra sur +X)
 *   phi   = angle polaire depuis la verticale (0 → vue de dessus)
 * Toutes les transitions passent par un lissage exponentiel : les vues
 * prédéfinies s'animent donc naturellement.
 *
 * Souris : gauche = rotation · droit/milieu ou Maj+gauche = déplacement · molette = zoom
 * Tactile : 1 doigt = rotation · 2 doigts = zoom + déplacement
 */
import * as THREE from 'three';
import { clamp, damp } from './utils.js';

const DEG = Math.PI / 180;

export const VIEWS = {
  '3D':    { theta: 58 * DEG, phi: 57 * DEG, radius: 50, target: [-2, 1.5, 0] },
  TOP:     { theta: 0, phi: 0.001, radius: 52, target: [0, 0, 0] },
  FRONT:   { theta: 90 * DEG, phi: 84 * DEG, radius: 44, target: [0, 4, 0] },
  SIDE:    { theta: 0, phi: 82 * DEG, radius: 50, target: [0, 4, 0] },
};

export class OrbitCamera {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.cur = { theta: 0, phi: 1, radius: 50, target: new THREE.Vector3() };
    this.goal = { theta: 0, phi: 1, radius: 50, target: new THREE.Vector3() };
    this.minRadius = 10;
    this.maxRadius = 160;
    this.autoRotate = false;
    this.autoSpeed = 0.12;
    this.pointers = new Map();
    this.onInteract = null;
    this.setView('3D', true);
    this._bind();
  }

  /** Applique une vue prédéfinie (animée sauf si immediate). */
  setView(name, immediate = false) {
    const v = VIEWS[name] || VIEWS['3D'];
    // Chemin angulaire le plus court.
    let theta = v.theta;
    const d = theta - this.goal.theta;
    theta = this.goal.theta + Math.atan2(Math.sin(d), Math.cos(d));
    this.goal.theta = theta;
    this.goal.phi = v.phi;
    this.goal.radius = v.radius;
    this.goal.target.set(...v.target);
    if (immediate) {
      this.cur.theta = theta; this.cur.phi = v.phi; this.cur.radius = v.radius;
      this.cur.target.copy(this.goal.target);
    }
  }

  _bind() {
    const el = this.dom;
    el.style.touchAction = 'none';
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
      this.onInteract?.();
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (this.pointers.size === 2) {
        this._pinch(e.pointerId, e.clientX, e.clientY);
      } else if (p.button === 0 && !p.shift && !e.shiftKey) {
        this._rotate(dx, dy);
      } else {
        this._pan(dx, dy);
      }
      p.x = e.clientX; p.y = e.clientY;
    });
    const end = (e) => { this.pointers.delete(e.pointerId); this._pinchDist = 0; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.zoom(Math.exp(delta * 0.0012));
      this.onInteract?.();
    }, { passive: false });
  }

  _rotate(dx, dy) {
    const h = this.dom.clientHeight || 600;
    this.goal.theta -= (dx / h) * Math.PI * 1.1;
    this.goal.phi = clamp(this.goal.phi - (dy / h) * Math.PI * 0.9, 0.001, 88 * DEG);
  }

  _pan(dx, dy) {
    const h = this.dom.clientHeight || 600;
    const scale = (this.cur.radius * 1.1) / h;
    const cam = this.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
    this.goal.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
    this.goal.target.y = clamp(this.goal.target.y, -10, 30);
  }

  _pinch(id, x, y) {
    const pts = [...this.pointers.entries()];
    const other = pts.find(([k]) => k !== id)?.[1];
    if (!other) return;
    const dist = Math.hypot(other.x - x, other.y - y);
    if (this._pinchDist) this.zoom(this._pinchDist / dist);
    this._pinchDist = dist;
  }

  zoom(factor) {
    this.goal.radius = clamp(this.goal.radius * factor, this.minRadius, this.maxRadius);
  }

  update(dt) {
    if (this.autoRotate && this.pointers.size === 0) this.goal.theta += this.autoSpeed * dt;
    const k = damp(7, dt);
    const c = this.cur, g = this.goal;
    c.theta += (g.theta - c.theta) * k;
    c.phi += (g.phi - c.phi) * k;
    c.radius += (g.radius - c.radius) * k;
    c.target.lerp(g.target, k);
    const sp = Math.sin(c.phi);
    this.camera.position.set(
      c.target.x + c.radius * sp * Math.sin(c.theta),
      c.target.y + c.radius * Math.cos(c.phi),
      c.target.z + c.radius * sp * Math.cos(c.theta),
    );
    this.camera.lookAt(c.target);
  }
}
