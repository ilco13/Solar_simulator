import { DEG } from './geo';

/** Tout ce qu'il faut pour lancer des rayons vers le soleil (transférable à un worker). */
export interface Scene {
  x0: number;
  y0: number;
  res: number;
  w: number;
  h: number;
  dsm: Float32Array;
  dtm?: Float32Array; // sol (pour « déshabiller » les arbres caducs dans les cartes d'ombre)
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
 * Ombre portée sur toute la grille par balayage (O(N) par position du soleil) :
 * on parcourt les cellules depuis le côté du soleil en propageant la « hauteur d'ombre »
 * H = max(surface, H_amont − distance × tan(hauteur du soleil)).
 * Renvoie 1 si la cellule est au soleil, 0 sinon.
 */
function sweep(s: Scene, heights: Float32Array, azTrue: number, el: number, tol: number): Uint8Array {
  const { w, h, res } = s;
  const lit = new Uint8Array(w * h);
  const H = new Float32Array(w * h);
  const g = (azTrue + s.northOffset) * DEG;
  const ux = Math.sin(g); // vers le soleil, est
  const uy = Math.cos(g); // vers le soleil, nord
  const tanE = Math.tan(el * DEG);
  if (Math.abs(ux) >= Math.abs(uy)) {
    // balayage par colonnes ; la colonne amont est du côté du soleil
    const si = ux > 0 ? 1 : -1;
    const dRow = -uy / Math.abs(ux); // décalage de ligne vers l'amont (ligne = vers le sud)
    const drop = (res / Math.abs(ux)) * tanE;
    const iStart = si > 0 ? w - 1 : 0;
    for (let j = 0; j < h; j++) {
      H[j * w + iStart] = heights[j * w + iStart];
      lit[j * w + iStart] = 1;
    }
    for (let i = iStart - si; i >= 0 && i < w; i -= si) {
      const up = i + si;
      for (let j = 0; j < h; j++) {
        const k = j * w + i;
        const z = heights[k];
        const jj = j + dRow;
        const j0 = Math.floor(jj);
        let hu = -Infinity;
        if (j0 >= 0 && j0 + 1 < h) {
          const t = jj - j0;
          hu = H[j0 * w + up] * (1 - t) + H[(j0 + 1) * w + up] * t;
        } else if (j0 === h - 1 && jj === j0) hu = H[j0 * w + up];
        const shadowZ = hu - drop;
        H[k] = z > shadowZ ? z : shadowZ;
        lit[k] = z + tol >= shadowZ ? 1 : 0;
      }
    }
  } else {
    // balayage par lignes ; la ligne amont est du côté du soleil (nord => ligne précédente)
    const sj = uy > 0 ? -1 : 1;
    const dCol = ux / Math.abs(uy);
    const drop = (res / Math.abs(uy)) * tanE;
    const jStart = sj < 0 ? 0 : h - 1;
    for (let i = 0; i < w; i++) {
      H[jStart * w + i] = heights[jStart * w + i];
      lit[jStart * w + i] = 1;
    }
    for (let j = jStart - sj; j >= 0 && j < h; j -= sj) {
      const up = (j + sj) * w;
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const z = heights[k];
        const ii = i + dCol;
        const i0 = Math.floor(ii);
        let hu = -Infinity;
        if (i0 >= 0 && i0 + 1 < w) {
          const t = ii - i0;
          hu = H[up + i0] * (1 - t) + H[up + i0 + 1] * t;
        } else if (i0 === w - 1 && ii === i0) hu = H[up + i0];
        const shadowZ = hu - drop;
        H[k] = z > shadowZ ? z : shadowZ;
        lit[k] = z + tol >= shadowZ ? 1 : 0;
      }
    }
  }
  return lit;
}

/** Hauteurs avec les arbres caducs retirés (pour les mois sans feuilles). */
function leaflessHeights(s: Scene): Float32Array | null {
  if (!s.dtm) return null;
  let any = false;
  for (let k = 1; k < s.deciduous.length; k++) if (s.deciduous[k]) any = true;
  if (!any) return null;
  const out = s.dsm.slice();
  for (let k = 0; k < out.length; k++) {
    const l = s.treeLabel[k];
    if (l > 0 && s.deciduous[l]) out[k] = s.dtm[k];
  }
  return out;
}

/** Ensoleillement de chaque cellule de la grille entière (1 soleil, 0 ombre, transmission sous arbre caduc). */
function litGrid(s: Scene, azTrue: number, el: number, leafless: boolean, bare: Float32Array | null): Float32Array {
  const out = new Float32Array(s.w * s.h);
  if (el <= 0 || horizonBlocks(s, azTrue, el)) return out;
  const tol = 0.25;
  const opaque = sweep(s, s.dsm, azTrue, el, tol);
  const thin = leafless && bare ? sweep(s, bare, azTrue, el, tol) : null;
  for (let k = 0; k < out.length; k++) out[k] = opaque[k] ? 1 : thin && thin[k] ? s.leaflessTransmission : 0;
  return out;
}

function crop(src: Float32Array, s: Scene, i0: number, j0: number, cw: number, chh: number, into?: Float32Array, scale = 1): Float32Array {
  const out = into ?? new Float32Array(cw * chh);
  for (let j = 0; j < chh; j++) {
    const row = (j0 + j) * s.w + i0;
    for (let i = 0; i < cw; i++) out[j * cw + i] += scale * src[row + i];
  }
  return out;
}

/**
 * Carte d'ombre instantanée d'une fenêtre de la grille : 1 = soleil, 0 = ombre.
 * Utilisée pour l'affichage avec le curseur date/heure.
 */
export function shadowMap(s: Scene, azTrue: number, el: number, month: number, i0: number, j0: number, cw: number, chh: number): Float32Array {
  const leafless = s.leafless[month];
  return crop(litGrid(s, azTrue, el, leafless, leafless ? leaflessHeights(s) : null), s, i0, j0, cw, chh);
}

/**
 * Heures de soleil direct de chaque cellule sur une journée.
 * sun : positions du soleil échantillonnées (pas de `stepH` heures), déjà filtrées (soleil levé).
 * Renvoie des heures (transmission des arbres caducs comprise).
 */
export function daySunHours(
  s: Scene,
  sun: { az: number; el: number }[],
  stepH: number,
  month: number,
  i0: number,
  j0: number,
  cw: number,
  chh: number,
): Float32Array {
  const out = new Float32Array(cw * chh);
  const leafless = s.leafless[month];
  const bare = leafless ? leaflessHeights(s) : null;
  for (const p of sun) {
    if (p.el <= 0 || horizonBlocks(s, p.az, p.el)) continue;
    crop(litGrid(s, p.az, p.el, leafless, bare), s, i0, j0, cw, chh, out, stepH);
  }
  return out;
}
