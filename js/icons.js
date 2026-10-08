/**
 * icons.js — Icônes « verre sombre » : tuile arrondie noire au liseré clair,
 * forme principale gris givré, accent coloré qui diffuse sa lumière à travers.
 *
 *   icon(name, color, { tile = true, title })  → chaîne SVG
 *   hydrateIcons(root)                          → remplit les <i data-icon="…" data-icon-color="…">
 *
 * Grille de dessin : 48 × 48. Chaque glyphe = `base` (gris givré) + `accent` (couleur).
 * Les éléments en trait déclarent eux-mêmes fill="none" et stroke-width.
 */

const G = {
  /* ------------------------------------------------ Catégories (détecteur) */
  bird: {
    base: '<circle cx="31" cy="16" r="7.5"/><path d="M5 33c4-10 14-14 26-11.5l4 4.5c-1 9-9 15.5-19 15.5-5 0-8.5-3-11-8.5z"/>',
    accent: '<path d="M37.5 13.5l7.5 2.5-7.5 2.5z"/><path d="M13 31c6-7.5 13.5-9 19-5.5-3 6.5-11.5 9.5-19 5.5z"/>',
  },
  animal: {
    base: '<path d="M24 25c-7 0-12 6-12 11 0 4 4 6 12 6s12-2 12-6c0-5-5-11-12-11z"/>',
    accent: '<ellipse cx="12.5" cy="19" rx="3.6" ry="4.4"/><ellipse cx="20" cy="11.5" rx="3.6" ry="4.6"/><ellipse cx="28" cy="11.5" rx="3.6" ry="4.6"/><ellipse cx="35.5" cy="19" rx="3.6" ry="4.4"/>',
  },
  human: {
    base: '<circle cx="21" cy="17" r="8"/><path d="M6 41c1-9 7-13 15-13s14 4 15 13z"/>',
    accent: '<circle cx="39" cy="12" r="3.2"/><circle cx="41" cy="22" r="3.2"/><circle cx="39" cy="32" r="3.2"/>',
  },
  music: {
    base: '<path d="M34 7v24h-4.5V14.5L19 17.5V35h-4.5V12.5z"/>',
    accent: '<ellipse cx="13.5" cy="35.5" rx="5.6" ry="4.6"/><ellipse cx="28.5" cy="31.5" rx="5.6" ry="4.6"/>',
  },
  nature: {
    base: '<path d="M9 38C9 21 20 10 39 9c0 18-11 29-28 30z"/>',
    accent: '<path d="M12 36c6-9 13-16 22-21" fill="none" stroke-width="3" stroke-linecap="round"/><path d="M37 27c3 4 5 6.5 5 9a5 5 0 0 1-10 0c0-2.5 2-5 5-9z"/>',
  },
  other: {
    base: '<path d="M8 19a2 2 0 0 1 2-2h7l9-8v30l-9-8h-7a2 2 0 0 1-2-2z"/>',
    accent: '<path d="M31 18c3 3.5 3 8.5 0 12" fill="none" stroke-width="3.2" stroke-linecap="round"/><path d="M36.5 13c5.5 6 5.5 16 0 22" fill="none" stroke-width="3.2" stroke-linecap="round"/>',
  },

  /* ------------------------------------------------ Catégories (sommeil) */
  sleep: {
    base: '<path d="M28 7a15 15 0 1 0 13 22A12 12 0 0 1 28 7z"/>',
    accent: '<circle cx="36" cy="11" r="3"/><circle cx="41" cy="19" r="1.8"/>',
  },
  snore: {
    base: '<path d="M25 10a14 14 0 1 0 12 21A11 11 0 0 1 25 10z"/>',
    accent: '<path d="M29 7h7l-7 8h7" fill="none" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M38 17h5l-5 6h5" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  breath: {
    base: '<path d="M21 17v17c0 4-2 7-6 7.5-4 .5-6-2-6.5-6-.8-7 .5-17 5-20 3-1.8 6-.5 7.5 1.5z"/><path d="M27 17v17c0 4 2 7 6 7.5 4 .5 6-2 6.5-6 .8-7-.5-17-5-20-3-1.8-6-.5-7.5 1.5z"/>',
    accent: '<rect x="21.5" y="5" width="5" height="16" rx="2.5"/>',
  },
  cough: {
    base: '<path d="M11 33a8 8 0 0 1 2.5-15.5A10 10 0 0 1 32 18a7.5 7.5 0 0 1-1 15z"/>',
    accent: '<circle cx="37" cy="21" r="2.6"/><circle cx="41.5" cy="28" r="2.2"/><circle cx="37.5" cy="35" r="2.4"/><circle cx="42.5" cy="14.5" r="1.7"/>',
  },
  sneeze: {
    base: '<path d="M8 25h32v13a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4z"/><path d="M18 25c0-7 5-13 12-15-2 5-1 10 2 15z"/>',
    accent: '<circle cx="35" cy="9" r="2.2"/><circle cx="40.5" cy="13" r="1.8"/><circle cx="41" cy="6" r="1.5"/><rect x="14" y="31" width="20" height="3.5" rx="1.75"/>',
  },
  speech: {
    base: '<path d="M7 14a7 7 0 0 1 7-7h20a7 7 0 0 1 7 7v12a7 7 0 0 1-7 7H21l-9 8v-8.5A7 7 0 0 1 7 26z"/>',
    accent: '<circle cx="16" cy="20" r="2.8"/><circle cx="24" cy="20" r="2.8"/><circle cx="32" cy="20" r="2.8"/>',
  },
  vocal: {
    base: '<circle cx="19" cy="24" r="13"/>',
    accent: '<path d="M27 24c2.2-5 4.3-5 6.5 0s4.3 5 6.5 0 3-4 4-2" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="19" cy="28" rx="4" ry="3"/>',
  },
  brux: {
    base: '<path d="M13 9c4-3 8 0 11 0s7-3 11 0c4 3 3 10 1 15-1.5 4-2 12-5.5 12S28 28 24 28s-3 8-6.5 8S13.5 28 12 24c-2-5-3-12 1-15z"/>',
    accent: '<path d="M9 42l5-3.5 5 3.5 5-3.5 5 3.5 5-3.5 5 3.5" fill="none" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  move: {
    base: '<path d="M5 31h38v9h-3.5v-4.5h-31V40H5z"/><path d="M5 25a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v5H5z"/><path d="M22 25h16a5 5 0 0 1 5 5v1H22z"/>',
    accent: '<path d="M12 14c3.5-3.5 8.5-3.5 12 0" fill="none" stroke-width="3" stroke-linecap="round"/><path d="M27 10c3.5-3.5 8.5-3.5 12 0" fill="none" stroke-width="3" stroke-linecap="round"/>',
  },
  env: {
    base: '<path d="M14 9a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v33H14z"/>',
    accent: '<circle cx="29" cy="25" r="2.6"/><path d="M9 42h30" fill="none" stroke-width="3" stroke-linecap="round"/>',
  },
  pause: {
    base: '<circle cx="24" cy="24" r="16"/>',
    accent: '<rect x="17" y="15.5" width="5" height="17" rx="2.5"/><rect x="26" y="15.5" width="5" height="17" rx="2.5"/>',
  },
  compare: {
    base: '<circle cx="21" cy="21" r="12"/><rect x="31" y="30" width="6" height="14" rx="3" transform="rotate(-45 34 37)"/>',
    accent: '<circle cx="21" cy="21" r="6.5"/>',
  },

  /* ---------------------------------------------------------- Interface */
  wave: {
    base: '<rect x="6" y="20" width="4.5" height="8" rx="2.25"/><rect x="13" y="13" width="4.5" height="22" rx="2.25"/><rect x="30.5" y="15" width="4.5" height="18" rx="2.25"/><rect x="37.5" y="20" width="4.5" height="8" rx="2.25"/>',
    accent: '<rect x="21.75" y="7" width="4.5" height="34" rx="2.25"/>',
  },
  mic: {
    base: '<rect x="17" y="5" width="14" height="25" rx="7"/><rect x="22" y="35" width="4" height="8" rx="2"/>',
    accent: '<path d="M11 22a13 13 0 0 0 26 0" fill="none" stroke-width="3.2" stroke-linecap="round"/>',
  },
  folder: {
    base: '<path d="M5 16a4 4 0 0 1 4-4h10l4 4h16a4 4 0 0 1 4 4v16a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5z"/>',
    accent: '<path d="M5 16a4 4 0 0 1 4-4h10l4 4h16a4 4 0 0 1 4 4v1H5z"/>',
  },
  location: {
    base: '<path d="M24 5a13 13 0 0 1 13 13c0 10-13 23-13 23S11 28 11 18A13 13 0 0 1 24 5z"/>',
    accent: '<ellipse cx="24" cy="43" rx="7" ry="2.4"/><circle cx="24" cy="18" r="4.5"/>',
  },
  warning: {
    base: '<path d="M21 8.5a3.5 3.5 0 0 1 6 0l15 26A3.5 3.5 0 0 1 39 40H9a3.5 3.5 0 0 1-3-5.5z"/>',
    accent: '<rect x="22" y="17" width="4" height="12" rx="2"/><circle cx="24" cy="34" r="2.4"/>',
  },
  play: {
    base: '<path d="M14 9.5c0-2.5 2.7-4 4.8-2.7l20 13c2 1.3 2 4.2 0 5.4l-20 13C16.7 39.5 14 38 14 35.5z"/>',
    accent: '<circle cx="33" cy="31" r="5.5"/>',
  },
  pauseBtn: {
    base: '<rect x="12" y="8" width="9" height="32" rx="3.5"/><rect x="27" y="8" width="9" height="32" rx="3.5"/>',
    accent: '<circle cx="34" cy="36" r="5"/>',
  },
  rewind: {
    base: '<path d="M22 12v24L5 24z"/><path d="M42 12v24L25 24z"/>',
    accent: '<circle cx="9" cy="24" r="4.5"/>',
  },
  forward: {
    base: '<path d="M26 12v24l17-12z"/><path d="M6 12v24l17-12z"/>',
    accent: '<circle cx="39" cy="24" r="4.5"/>',
  },
  stepBack: {
    base: '<path d="M38 11v26L17 24z"/><rect x="9" y="11" width="5" height="26" rx="2.5"/>',
    accent: '<circle cx="21" cy="24" r="4.5"/>',
  },
  stepFwd: {
    base: '<path d="M10 11v26l21-13z"/><rect x="34" y="11" width="5" height="26" rx="2.5"/>',
    accent: '<circle cx="27" cy="24" r="4.5"/>',
  },
  refresh: {
    base: '<path d="M38 24a14 14 0 1 1-4.1-9.9" fill="none" stroke-width="5" stroke-linecap="round"/>',
    accent: '<path d="M30 8l9 2-2 9z"/>',
  },
  close: {
    base: '<rect x="21.5" y="7" width="5" height="34" rx="2.5" transform="rotate(45 24 24)"/><rect x="21.5" y="7" width="5" height="34" rx="2.5" transform="rotate(-45 24 24)"/>',
    accent: '<circle cx="24" cy="24" r="3.5"/>',
  },
  book: {
    base: '<path d="M6 10a3 3 0 0 1 3-3h10c2.5 0 4 1.2 5 3 1-1.8 2.5-3 5-3h10a3 3 0 0 1 3 3v24a2 2 0 0 1-2 2H30c-2.5 0-4 1-6 3-2-2-3.5-3-6-3H8a2 2 0 0 1-2-2z"/>',
    accent: '<rect x="22.5" y="11" width="3" height="27" rx="1.5"/><rect x="10" y="14" width="9" height="3" rx="1.5"/><rect x="29" y="14" width="9" height="3" rx="1.5"/>',
  },
  doc: {
    base: '<path d="M10 7a3 3 0 0 1 3-3h14l11 11v26a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3z"/>',
    accent: '<path d="M27 4v8a3 3 0 0 0 3 3h8z"/><rect x="15" y="23" width="18" height="3" rx="1.5"/><rect x="15" y="30" width="13" height="3" rx="1.5"/>',
  },
  slides: {
    base: '<rect x="5" y="8" width="38" height="26" rx="4"/><rect x="22" y="34" width="4" height="7" rx="2"/>',
    accent: '<rect x="11" y="23" width="5" height="6" rx="1.5"/><rect x="19" y="18" width="5" height="11" rx="1.5"/><rect x="27" y="14" width="5" height="15" rx="1.5"/><rect x="15" y="41" width="18" height="3" rx="1.5"/>',
  },
  chat: {
    base: '<path d="M6 13a7 7 0 0 1 7-7h16a7 7 0 0 1 7 7v8a7 7 0 0 1-7 7H18l-7 6v-6.5A7 7 0 0 1 6 21z"/>',
    accent: '<path d="M22 31h12l6 5v-5a6 6 0 0 0 4-5.6V20a6 6 0 0 0-5-6v7a10 10 0 0 1-10 10z"/>',
  },
  search: {
    base: '<circle cx="21" cy="21" r="13"/><rect x="31" y="30" width="6" height="15" rx="3" transform="rotate(-45 34 37.5)"/>',
    accent: '<circle cx="21" cy="21" r="6"/>',
  },
  export: {
    base: '<path d="M8 22a3 3 0 0 1 3-3h4v4h-3v15h24V23h-3v-4h4a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3z"/>',
    accent: '<rect x="21.75" y="5" width="4.5" height="24" rx="2.25"/><path d="M15 12l9-8 9 8z"/>',
  },
  upload: {
    base: '<path d="M14 36a10 10 0 0 1-1.5-19.9A13 13 0 0 1 37.5 15 9.5 9.5 0 0 1 36 36z"/>',
    accent: '<rect x="21.75" y="20" width="4.5" height="18" rx="2.25"/><path d="M16 25l8-8 8 8z"/>',
  },
  gear: {
    base: '<path d="M21 5h6l1 5 4 2 4.5-3 4 4-3 4.5 2 4 5 1v6l-5 1-2 4 3 4.5-4 4-4.5-3-4 2-1 5h-6l-1-5-4-2-4.5 3-4-4 3-4.5-2-4-5-1v-6l5-1 2-4-3-4.5 4-4 4.5 3 4-2z"/>',
    accent: '<circle cx="24" cy="24" r="6.5"/>',
  },
  check: {
    base: '<circle cx="24" cy="24" r="17"/>',
    accent: '<path d="M15 24.5l6 6 12-13" fill="none" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  cards: {
    base: '<rect x="13" y="7" width="27" height="33" rx="5" transform="rotate(8 26 23)"/>',
    accent: '<rect x="8" y="10" width="25" height="31" rx="5"/>',
  },
  link: {
    base: '<path d="M20 28l8-8" fill="none" stroke-width="4.5" stroke-linecap="round"/><path d="M17 23l-4 4a6 6 0 0 0 8.5 8.5l4-4" fill="none" stroke-width="4.5" stroke-linecap="round"/>',
    accent: '<path d="M31 25l4-4a6 6 0 0 0-8.5-8.5l-4 4" fill="none" stroke-width="4.5" stroke-linecap="round"/>',
  },
  trash: {
    base: '<path d="M11 15h26l-2.2 24a4 4 0 0 1-4 3.6H17.2a4 4 0 0 1-4-3.6z"/>',
    accent: '<rect x="8" y="9" width="32" height="4.5" rx="2.25"/><rect x="19" y="5" width="10" height="4.5" rx="2.25"/>',
  },
};

let defsReady = false;

/** Dégradés et filtre partagés, injectés une seule fois dans le document. */
function ensureDefs() {
  if (defsReady || typeof document === 'undefined') return;
  defsReady = true;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  svg.innerHTML = `<defs>
    <linearGradient id="gi-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2c31"/><stop offset="1" stop-color="#0c0d10"/></linearGradient>
    <linearGradient id="gi-rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity=".16"/></linearGradient>
    <linearGradient id="gi-frost" gradientUnits="userSpaceOnUse" x1="0" y1="4" x2="0" y2="44"><stop offset="0" stop-color="#7a7b82" stop-opacity=".82"/><stop offset="1" stop-color="#34353b" stop-opacity=".74"/></linearGradient>
    <linearGradient id="gi-frost-l" gradientUnits="userSpaceOnUse" x1="0" y1="4" x2="0" y2="44"><stop offset="0" stop-color="#d4d5da"/><stop offset="1" stop-color="#8b8c93"/></linearGradient>
    <radialGradient id="gi-sheen" cx=".3" cy="0" r="1"><stop offset="0" stop-color="#fff" stop-opacity=".09"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <filter id="gi-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.5"/></filter>
    <filter id="gi-haze" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="8"/></filter>
  </defs>`;
  document.body.prepend(svg);
}

/**
 * @param {string} name   glyphe (voir G)
 * @param {string} color  couleur de l'accent (hex ou var(--x))
 * @param {{tile?: boolean, title?: string}} [o]
 */
export function icon(name, color = 'var(--accent)', o = {}) {
  ensureDefs();
  const g = G[name] || G.other;
  const tile = o.tile !== false;
  const style = `fill:${color};stroke:${color}`;
  return `<svg class="gi${tile ? ' gi-tile' : ''}" viewBox="0 0 48 48" aria-hidden="${o.title ? 'false' : 'true'}" role="img">${o.title ? `<title>${o.title}</title>` : ''}
    ${tile ? '<rect x="1" y="1" width="46" height="46" rx="13" fill="url(#gi-bg)"/>' : ''}
    <g style="${style}" filter="url(#gi-haze)" opacity=".55">${g.accent}</g>
    <g style="${style}" filter="url(#gi-glow)" opacity=".95">${g.accent}</g>
    <g fill="url(#gi-frost${tile ? '' : '-l'})" stroke="url(#gi-frost${tile ? '' : '-l'})" stroke-width="0">${g.base}</g>
    <g style="${style}">${g.accent}</g>
    ${tile ? '<rect x="1" y="1" width="46" height="46" rx="13" fill="url(#gi-sheen)"/><rect x="1.5" y="1.5" width="45" height="45" rx="12.5" fill="none" stroke="url(#gi-rim)" stroke-width="1.2"/>' : ''}
  </svg>`;
}

/** Remplace chaque <i data-icon="nom" data-icon-color="…" data-tile="0"> par son SVG. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.innerHTML = icon(el.dataset.icon, el.dataset.iconColor || 'var(--accent)', { tile: el.dataset.tile !== '0' });
    el.classList.add('gi-slot');
  }
}

export const ICON_NAMES = Object.keys(G);
