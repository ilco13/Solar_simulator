import { type Grid, cellX, cellY, colOf, rowOf } from './grid';
import { type XY, distToRing, pointInPolygon } from './geo';

export interface Tree {
  id: number; // >= 1, valeur dans la grille d'étiquettes
  key: string; // identifiant stable (position arrondie) pour mémoriser le choix persistant/caduc
  x: number;
  y: number;
  height: number; // hauteur au-dessus du sol (m)
  crownRadius: number; // m
  deciduous: boolean;
}

export interface TreeDetection {
  trees: Tree[];
  /** Pour chaque cellule de la grille : n° d'arbre (0 = pas un arbre). */
  label: Int32Array;
}

/**
 * Repère les arbres dans le modèle de hauteur (MNS - MNT) hors bâtiments :
 * sommets locaux -> couronnes par propagation depuis les sommets.
 */
export function detectTrees(dsm: Grid, dtm: Grid, buildings: XY[][]): TreeDetection {
  const { w, h, res } = dsm;
  const n = w * h;
  const ndsm = new Float32Array(n);
  for (let k = 0; k < n; k++) ndsm[k] = dsm.data[k] - dtm.data[k];

  // Masque des bâtiments (avec 0,8 m de marge pour les débords de toit)
  const isBuilding = new Uint8Array(n);
  for (const ring of buildings) {
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const i0 = Math.max(0, colOf(dsm, Math.min(...xs) - 1));
    const i1 = Math.min(w - 1, colOf(dsm, Math.max(...xs) + 1));
    const j0 = Math.max(0, rowOf(dsm, Math.max(...ys) + 1));
    const j1 = Math.min(h - 1, rowOf(dsm, Math.min(...ys) - 1));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = cellX(dsm, i);
        const y = cellY(dsm, j);
        if (pointInPolygon(x, y, ring) || distToRing(x, y, ring) < 0.8) isBuilding[j * w + i] = 1;
      }
  }

  const veg = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (ndsm[k] > 2 && !isBuilding[k]) veg[k] = 1;

  // Lissage 3x3 pour trouver des sommets stables
  const smooth = new Float32Array(n);
  for (let j = 1; j < h - 1; j++)
    for (let i = 1; i < w - 1; i++) {
      const k = j * w + i;
      if (!veg[k]) continue;
      let s = 0;
      let c = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const kk = k + dj * w + di;
          if (veg[kk]) {
            s += ndsm[kk];
            c++;
          }
        }
      smooth[k] = s / c;
    }

  // Sommets : maximum local dans un rayon de 2 m, hauteur >= 3 m
  const r = Math.round(2 / res);
  const tops: number[] = [];
  for (let j = r; j < h - r; j++)
    for (let i = r; i < w - r; i++) {
      const k = j * w + i;
      if (!veg[k] || smooth[k] < 3) continue;
      let isMax = true;
      for (let dj = -r; dj <= r && isMax; dj++)
        for (let di = -r; di <= r; di++) {
          if (di * di + dj * dj > r * r || (di === 0 && dj === 0)) continue;
          const kk = k + dj * w + di;
          if (smooth[kk] > smooth[k] || (smooth[kk] === smooth[k] && kk < k)) {
            isMax = false;
            break;
          }
        }
      if (isMax && !isPlanar(dsm, i, j)) tops.push(k);
    }
  tops.sort((a, b) => smooth[b] - smooth[a]);
  // Suppression des sommets trop proches d'un plus haut
  const kept: number[] = [];
  for (const t of tops) {
    const ti = t % w;
    const tj = (t - ti) / w;
    const minD = Math.max(2.5, 0.2 * ndsm[t]) / res;
    if (kept.every((q) => ((q % w) - ti) ** 2 + (Math.floor(q / w) - tj) ** 2 >= minD * minD)) kept.push(t);
  }

  // Couronnes : propagation en largeur depuis tous les sommets (limite 9 m)
  const label = new Int32Array(n);
  const dist = new Float32Array(n).fill(Infinity);
  let queue: number[] = [];
  kept.forEach((t, idx) => {
    label[t] = idx + 1;
    dist[t] = 0;
    queue.push(t);
  });
  const maxD = 9 / res;
  while (queue.length) {
    const next: number[] = [];
    for (const k of queue) {
      const i = k % w;
      for (const [d, ok] of [[-1, i > 0], [1, i < w - 1], [-w, k >= w], [w, k < n - w]] as [number, boolean][]) {
        if (!ok) continue;
        const kk = k + d;
        if (!veg[kk] || label[kk]) continue;
        // une couronne ne "remonte" pas fortement : on ne franchit pas un autre sommet
        if (ndsm[kk] > ndsm[k] + 1.5) continue;
        if (dist[k] + 1 > maxD) continue;
        label[kk] = label[k];
        dist[kk] = dist[k] + 1;
        next.push(kk);
      }
    }
    queue = next;
  }

  const counts = new Int32Array(kept.length + 1);
  for (let k = 0; k < n; k++) counts[label[k]]++;
  const trees: Tree[] = kept.map((t, idx) => {
    const i = t % w;
    const j = (t - i) / w;
    const x = cellX(dsm, i);
    const y = cellY(dsm, j);
    return {
      id: idx + 1,
      key: `${Math.round(x)}_${Math.round(y)}`,
      x,
      y,
      height: ndsm[t],
      crownRadius: Math.sqrt((counts[idx + 1] * res * res) / Math.PI),
      deciduous: false,
    };
  });
  return { trees, label };
}

/** Surface très plane (abri, mur, auvent) : ce n'est pas un arbre. */
function isPlanar(g: Grid, i: number, j: number): boolean {
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sz = 0, sxz = 0, syz = 0, c = 0;
  const z: number[] = [];
  for (let dj = -2; dj <= 2; dj++)
    for (let di = -2; di <= 2; di++) {
      const v = g.data[(j + dj) * g.w + i + di];
      sxx += di * di; sxy += di * dj; syy += dj * dj; sx += di; sy += dj; sz += v; sxz += di * v; syz += dj * v; c++;
      z.push(v);
    }
  // grille symétrique : sx = sy = sxy = 0
  const a = sxz / sxx;
  const b = syz / syy;
  const m = sz / c;
  let e = 0;
  let idx = 0;
  for (let dj = -2; dj <= 2; dj++)
    for (let di = -2; di <= 2; di++) e += (z[idx++] - (m + a * di + b * dj)) ** 2;
  void sx; void sy; void sxy;
  return Math.sqrt(e / c) < 0.06;
}
