/** Grille raster en Lambert-93 : ligne 0 = bord nord, colonne 0 = bord ouest. */
export interface Grid {
  x0: number; // x du bord ouest
  y0: number; // y du bord nord
  res: number; // taille d'une cellule (m)
  w: number;
  h: number;
  data: Float32Array;
}

export function cellX(g: Grid, i: number): number {
  return g.x0 + (i + 0.5) * g.res;
}
export function cellY(g: Grid, j: number): number {
  return g.y0 - (j + 0.5) * g.res;
}
export function colOf(g: Grid, x: number): number {
  return Math.floor((x - g.x0) / g.res);
}
export function rowOf(g: Grid, y: number): number {
  return Math.floor((g.y0 - y) / g.res);
}

/** Valeur la plus proche (NaN hors grille). */
export function sampleNearest(g: Grid, x: number, y: number): number {
  const i = colOf(g, x);
  const j = rowOf(g, y);
  if (i < 0 || j < 0 || i >= g.w || j >= g.h) return NaN;
  return g.data[j * g.w + i];
}
