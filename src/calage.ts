/**
 * Calage photo aérienne / LiDAR.
 * La photo IGN n'est pas une "vraie ortho" : les toits y sont décalés (inclinaison de la prise de vue,
 * ~0,5 à 2 m pour une maison). On cherche le décalage qui superpose au mieux les arêtes de la photo
 * et les arêtes des bâtiments mesurées par le LiDAR (corrélation normalisée).
 */

export interface CalageResult {
  dx: number; // décalage à appliquer à la photo vers l'est (m)
  dy: number; // vers le nord (m)
  confidence: number; // netteté du pic (écarts-types au-dessus de la moyenne)
}

function gradMag(a: Float32Array, n: number): Float32Array {
  const g = new Float32Array(n * n);
  for (let j = 1; j < n - 1; j++)
    for (let i = 1; i < n - 1; i++) {
      const k = j * n + i;
      const gx = a[k - n + 1] + 2 * a[k + 1] + a[k + n + 1] - a[k - n - 1] - 2 * a[k - 1] - a[k + n - 1];
      const gy = a[k + n - 1] + 2 * a[k + n] + a[k + n + 1] - a[k - n - 1] - 2 * a[k - n] - a[k - n + 1];
      g[k] = Math.hypot(gx, gy);
    }
  return g;
}

/** Arêtes des bâtiments LiDAR : gradient de la hauteur (plafonnée) dans les emprises de bâtiments. */
export function lidarEdges(ndsm: Float32Array, buildingMask: Uint8Array, n: number): Float32Array {
  const h = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) h[k] = Math.max(0, Math.min(ndsm[k], 10));
  const g = gradMag(h, n);
  for (let k = 0; k < n * n; k++) if (!buildingMask[k]) g[k] = 0;
  return g;
}

/**
 * Meilleur décalage entre la photo (luminance) et les arêtes LiDAR, grilles n×n au pas `res`.
 * maxShift en cellules.
 */
export function findOffset(photo: Float32Array, edges: Float32Array, n: number, res: number, maxShift: number): CalageResult {
  const ep = gradMag(photo, n);
  let mean = 0;
  for (let k = 0; k < n * n; k++) mean += ep[k];
  mean /= n * n;
  for (let k = 0; k < n * n; k++) ep[k] -= mean;
  const S = 2 * maxShift + 1;
  const score = new Float64Array(S * S);
  let el2 = 0;
  for (let k = 0; k < n * n; k++) el2 += edges[k] * edges[k];
  for (let sy = -maxShift; sy <= maxShift; sy++)
    for (let sx = -maxShift; sx <= maxShift; sx++) {
      let s = 0;
      let p2 = 0;
      for (let j = maxShift; j < n - maxShift; j++)
        for (let i = maxShift; i < n - maxShift; i++) {
          const e = edges[j * n + i];
          if (e === 0) continue;
          const p = ep[(j + sy) * n + i + sx];
          s += e * p;
          p2 += p * p;
        }
      score[(sy + maxShift) * S + sx + maxShift] = p2 > 0 && el2 > 0 ? s / Math.sqrt(p2 * el2) : 0;
    }
  let best = 0;
  for (let k = 1; k < S * S; k++) if (score[k] > score[best]) best = k;
  const bx = best % S;
  const by = (best - bx) / S;
  // affinage sub-cellule (parabole)
  const para = (a: number, b: number, c: number) => {
    const d = a - 2 * b + c;
    return d < 0 ? (0.5 * (a - c)) / d : 0;
  };
  const fx = bx > 0 && bx < S - 1 ? para(score[by * S + bx - 1], score[best], score[by * S + bx + 1]) : 0;
  const fy = by > 0 && by < S - 1 ? para(score[(by - 1) * S + bx], score[best], score[(by + 1) * S + bx]) : 0;
  let m = 0;
  for (const v of score) m += v;
  m /= score.length;
  let sd = 0;
  for (const v of score) sd += (v - m) ** 2;
  sd = Math.sqrt(sd / score.length) || 1e-9;
  const sx = bx - maxShift + fx;
  const sy = by - maxShift + fy;
  // la photo est décalée de (sx, sy) cellules par rapport au LiDAR (ligne = vers le sud) : on la ramène
  return { dx: -sx * res, dy: sy * res, confidence: (score[best] - m) / sd };
}
