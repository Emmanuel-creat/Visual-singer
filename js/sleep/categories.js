/**
 * categories.js : Catégories d'événements nocturnes et correspondance avec les classes YAMNet.
 *
 * `icon` = nom du glyphe de js/icons.js.
 * Couleurs : palette catégorielle validée pour fond sombre (ordre fixe),
 * l'environnement est en gris neutre. Chaque catégorie a aussi une icône
 * et un libellé : l'identité ne repose jamais sur la couleur seule.
 */

/** Indices YAMNet (models/yamnet/yamnet_class_map.csv) par catégorie. */
const GROUPS = {
  snore:  [38],                                        // Snoring
  breath: [36, 37, 39, 40, 41],                        // Breathing, Wheeze, Gasp, Pant, Snort
  cough:  [42, 43],                                    // Cough, Throat clearing
  sneeze: [44],                                        // Sneeze
  speech: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],  // Parole, cris, chuchotements
  vocal:  [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 32, 33, 34], // Rires, pleurs, gémissements, soupirs, grognements
  brux:   [49, 50, 485, 493],                          // Mastication, morsure, cliquetis, craquement
  move:   [47, 116, 278, 355, 454, 455, 467, 468, 469, 470, 471, 473, 480, 481], // Froissements, grincements, chocs sourds
};

/** Classes jamais utilisées comme événement (silence, acoustique de la pièce, bruit de fond). */
const IGNORED = new Set([494, 500, 501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 512, 513, 514, 515, 516, 517, 520, 279]);

export const CATS = {
  snore:  { code: 1, label: 'Ronflement',        short: 'Ronfl.',   icon: 'snore', color: '#3987e5', thr: 0.22, rise: 2, gap: 20, clipLen: 6 },
  breath: { code: 2, label: 'Respiration',       short: 'Resp.',    icon: 'breath', color: '#5b6b80', thr: 0.18, rise: 0, gap: 0,  clipLen: 0 },
  cough:  { code: 3, label: 'Toux',              short: 'Toux',     icon: 'cough', color: '#d95926', thr: 0.3,  rise: 5, gap: 4,  clipLen: 5 },
  sneeze: { code: 4, label: 'Éternuement',       short: 'Étern.',   icon: 'sneeze', color: '#199e70', thr: 0.3,  rise: 5, gap: 4,  clipLen: 5 },
  speech: { code: 5, label: 'Paroles',           short: 'Paroles',  icon: 'speech', color: '#c98500', thr: 0.45, rise: 4, gap: 5,  clipLen: 8 },
  vocal:  { code: 6, label: 'Gémissement / vocalisation', short: 'Vocal.', icon: 'vocal', color: '#d55181', thr: 0.3, rise: 4, gap: 4, clipLen: 6 },
  brux:   { code: 7, label: 'Mâchoire / grincement', short: 'Mâchoire', icon: 'brux', color: '#2f9e44', thr: 0.28, rise: 3, gap: 4, clipLen: 5 },
  move:   { code: 8, label: 'Mouvement dans le lit', short: 'Mouv.', icon: 'move', color: '#9085e9', thr: 0.2,  rise: 3, gap: 5,  clipLen: 5 },
  env:    { code: 9, label: 'Bruit environnant', short: 'Env.',     icon: 'env', color: '#8a8c93', thr: 0.4,  rise: 6, gap: 6,  clipLen: 6 },
  pause:  { code: 10, label: 'Pause respiratoire suspecte', short: 'Pause', icon: 'pause', color: '#e66767', thr: 0, rise: 0, gap: 0, clipLen: 0 },
};

/** Catégories affichées comme « événements » (la respiration sert à l'analyse du rythme). */
export const EVENT_CATS = ['snore', 'pause', 'cough', 'sneeze', 'speech', 'vocal', 'brux', 'move', 'env'];
export const CODE_TO_CAT = Object.fromEntries(Object.entries(CATS).map(([k, v]) => [v.code, k]));

/** Table indice YAMNet → catégorie (les classes non listées sont « environnement »). */
export const CLASS_TO_CAT = (() => {
  const t = new Array(521).fill('env');
  for (const [cat, idx] of Object.entries(GROUPS)) for (const i of idx) t[i] = cat;
  for (const i of IGNORED) t[i] = null;
  return t;
})();

export const GASP_SNORT = [39, 41];
