import { DEG } from './geo';

/** Tout ce qu'il faut pour lancer des rayons vers le soleil (transférable à un worker). */
export interface Scene {
  x0: number;
  y0: number;
  res: number;
  w: number;
  h: number;
  dsm: Float32Array;
  maxZ: number;
  treeLabel: Int32Array; // 0 = pas un arbre
  deciduous: Uint8Array; // indexé par n° d'arbre
  leafless: boolean[]; // 12 mois : true = arbres caducs sans feuilles
  leaflessTransmission: number; // part du direct qui traverse un arbre caduc sans feuilles
  northOffset: number;
  horizon: Float32Array; // 360 valeurs (° au-dessus de l'horizon par azimut vrai)
}

export function sceneMaxZ(dsm: Float32Array): number {
  let m = -Infinity;
  for (let k = 0; k < dsm.length; k++) if (dsm[k] > m) m = dsm[k];
  return m;
}

export function horizonBlocks(s: Scene, azTrue: number, el: number): boolean {
  const a = ((azTrue % 360) + 360) % 360;
  const i = Math.floor(a);
  const t = a - i;
  const h = s.horizon[i] * (1 - t) + s.horizon[(i + 1) % 360] * t;
  return el < h;
}

export interface IgnoreSurface {
  // on ignore la surface du pan lui-même (bruit LiDAR) : cellules à moins de `tol` du plan
  a: number;
  b: number;
  c: number;
  tol: number;
}

/**
 * Transmission du rayonnement direct (0 = ombre totale, 1 = plein soleil) depuis (px,py,pz)
 * vers la direction (azimut vrai, hauteur), par marche le long du rayon sur le MNS.
 * N'inclut pas l'horizon lointain (voir horizonBlocks).
 */
export function rayTransmission(
  s: Scene,
  px: number,
  py: number,
  pz: number,
  azTrue: number,
  el: number,
  leafless: boolean,
  startDist: number,
  tol: number,
  ignore?: IgnoreSurface,
): number {
  if (el <= 0) return 0;
  const g = (azTrue + s.northOffset) * DEG;
  const dx = Math.sin(g);
  const dy = Math.cos(g);
  const tanE = Math.tan(el * DEG);
  const step = s.res * 0.6;
  let t = 1;
  let lastTree = 0;
  const { x0, y0, res, w, h, dsm, treeLabel, deciduous } = s;
  for (let d = startDist; ; d += step) {
    const z = pz + d * tanE;
    if (z > s.maxZ) break;
    const x = px + d * dx;
    const y = py + d * dy;
    const i = Math.floor((x - x0) / res);
    const j = Math.floor((y0 - y) / res);
    if (i < 0 || j < 0 || i >= w || j >= h) break;
    const k = j * w + i;
    const surf = dsm[k];
    if (surf <= z + tol) continue;
    if (ignore && Math.abs(surf - (ignore.a * x + ignore.b * y + ignore.c)) < ignore.tol) continue;
    const lbl = treeLabel[k];
    if (lbl > 0 && leafless && deciduous[lbl]) {
      if (lbl !== lastTree) {
        t *= s.leaflessTransmission;
        lastTree = lbl;
        if (t < 0.02) return 0;
      }
      continue;
    }
    return 0;
  }
  return t;
}

/**
 * Carte d'ombre instantanée d'une fenêtre de la grille : 1 = soleil, 0 = ombre.
 * Utilisée pour l'affichage avec le curseur date/heure.
 */
export function shadowMap(s: Scene, azTrue: number, el: number, month: number, i0: number, j0: number, cw: number, chh: number): Float32Array {
  const out = new Float32Array(cw * chh);
  if (el <= 0 || horizonBlocks(s, azTrue, el)) return out;
  for (let j = 0; j < chh; j++)
    for (let i = 0; i < cw; i++) {
      const gi = i0 + i;
      const gj = j0 + j;
      const x = s.x0 + (gi + 0.5) * s.res;
      const y = s.y0 - (gj + 0.5) * s.res;
      out[j * cw + i] = rayTransmission(s, x, y, s.dsm[gj * s.w + gi] + 0.05, azTrue, el, s.leafless[month], s.res * 1.2, 0.25);
    }
  return out;
}
