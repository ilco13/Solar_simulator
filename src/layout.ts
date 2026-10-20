import { type XY, type XYZ, DEG, distToRing, pointInPolygon } from './geo';
import { type RoofPan, planeZ } from './roof';

export type Orientation = 'auto' | 'portrait' | 'paysage';

export interface LayoutOptions {
  orientation: Orientation;
  margin: number; // distance mini aux bords du pan (m)
  gap: number; // jeu entre panneaux (m)
  obstacleClearance: number; // distance mini aux obstacles (m)
}

export const DEFAULT_LAYOUT: LayoutOptions = { orientation: 'auto', margin: 0.3, gap: 0.02, obstacleClearance: 0.2 };

export interface PlacedPanel {
  id: string;
  panId: string;
  portrait: boolean;
  corners: XYZ[]; // 4 coins (Lambert-93 + altitude)
  center: XYZ;
  /** 9 points d'échantillonnage : 3 sous-chaînes (diodes bypass) × 3 points. */
  samples: XYZ[];
  enabled: boolean;
}

/** Repère du plan du pan : u le long de la gouttière, v en remontant la pente (en vraie grandeur). */
export interface PanFrame {
  ox: number;
  oy: number;
  ux: number;
  uy: number; // axe u horizontal
  upx: number;
  upy: number; // direction horizontale de montée
  cosT: number;
  tilt: number; // degrés
}

export function panFrame(pan: RoofPan, northOffset: number): PanFrame {
  const { a, b } = pan.plane;
  const g = Math.hypot(a, b);
  let upx: number;
  let upy: number;
  if (g < Math.tan(2 * DEG)) {
    // toit plat : on aligne sur le sud géographique (montée vers le nord)
    const az = northOffset * DEG;
    upx = Math.sin(az);
    upy = Math.cos(az);
  } else {
    upx = a / g;
    upy = b / g;
  }
  const xs = pan.ring.map((p) => p[0]);
  const ys = pan.ring.map((p) => p[1]);
  return {
    ox: (Math.min(...xs) + Math.max(...xs)) / 2,
    oy: (Math.min(...ys) + Math.max(...ys)) / 2,
    ux: upy,
    uy: -upx,
    upx,
    upy,
    cosT: 1 / Math.sqrt(1 + g * g),
    tilt: Math.atan(g) / DEG,
  };
}

export function toPlane(f: PanFrame, x: number, y: number): XY {
  const dx = x - f.ox;
  const dy = y - f.oy;
  return [dx * f.ux + dy * f.uy, (dx * f.upx + dy * f.upy) / f.cosT];
}

export function fromPlane(f: PanFrame, u: number, v: number): XY {
  return [f.ox + u * f.ux + v * f.cosT * f.upx, f.oy + u * f.uy + v * f.cosT * f.upy];
}

interface Rect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  portrait: boolean;
}

const R = 0.01; // pas de la grille de calepinage (1 cm)

/**
 * Pose le maximum de panneaux sur un pan.
 * Essaie portrait / paysage / mixte, et tous les décalages de grille au pas de 1 cm.
 */
export function layoutPan(pan: RoofPan, northOffset: number, panelL: number, panelW: number, opts: LayoutOptions): PlacedPanel[] {
  const f = panFrame(pan, northOffset);
  const poly = pan.ring.map((p) => toPlane(f, p[0], p[1]));
  const obst = pan.obstacles.map((o) => o.map((p) => toPlane(f, p[0], p[1])));
  const us = poly.map((p) => p[0]);
  const vs = poly.map((p) => p[1]);
  const uMin = Math.min(...us);
  const vMin = Math.min(...vs);
  const nu = Math.ceil((Math.max(...us) - uMin) / R);
  const nv = Math.ceil((Math.max(...vs) - vMin) / R);
  if (nu <= 0 || nv <= 0 || nu * nv > 4e6) return [];

  // Masque des cellules interdites
  const blocked = new Uint8Array(nu * nv);
  for (let j = 0; j < nv; j++) {
    const v = vMin + (j + 0.5) * R;
    for (let i = 0; i < nu; i++) {
      const u = uMin + (i + 0.5) * R;
      let bad = !pointInPolygon(u, v, poly) || distToRing(u, v, poly) < opts.margin;
      if (!bad)
        for (const o of obst)
          if (pointInPolygon(u, v, o) || distToRing(u, v, o) < opts.obstacleClearance) {
            bad = true;
            break;
          }
      blocked[j * nu + i] = bad ? 1 : 0;
    }
  }

  const tries: Rect[][] = [];
  const P = { cw: Math.round(panelW / R), ch: Math.round(panelL / R), portrait: true };
  const L = { cw: Math.round(panelL / R), ch: Math.round(panelW / R), portrait: false };
  const g = Math.max(0, Math.round(opts.gap / R));
  const pack = (mask: Uint8Array, s: typeof P) => packGrid(mask, nu, nv, s.cw, s.ch, g, s.portrait);
  if (opts.orientation !== 'paysage') tries.push(pack(blocked, P));
  if (opts.orientation !== 'portrait') tries.push(pack(blocked, L));
  if (opts.orientation === 'auto') {
    // mixte : on complète la meilleure solution avec l'autre orientation
    for (const [first, second] of [[P, L], [L, P]]) {
      const base = pack(blocked, first);
      const m = blocked.slice();
      for (const r of base) markRect(m, nu, nv, r, g);
      tries.push([...base, ...pack(m, second)]);
    }
  }
  let best: Rect[] = [];
  for (const t of tries) if (t.length > best.length) best = t;

  return best.map((r, idx) => {
    const u0 = uMin + r.u0 * R;
    const v0 = vMin + r.v0 * R;
    const u1 = uMin + r.u1 * R;
    const v1 = vMin + r.v1 * R;
    const to3 = (u: number, v: number): XYZ => {
      const [x, y] = fromPlane(f, u, v);
      return [x, y, planeZ(pan.plane, x, y)];
    };
    const corners = [to3(u0, v0), to3(u1, v0), to3(u1, v1), to3(u0, v1)];
    const samples: XYZ[] = [];
    const fr = [1 / 6, 1 / 2, 5 / 6];
    // Les 3 sous-chaînes courent le long du grand côté du panneau.
    for (const a of fr)
      for (const b of fr) {
        if (r.portrait) samples.push(to3(u0 + a * (u1 - u0), v0 + b * (v1 - v0)));
        else samples.push(to3(u0 + b * (u1 - u0), v0 + a * (v1 - v0)));
      }
    return {
      id: `${pan.id}-${idx + 1}`,
      panId: pan.id,
      portrait: r.portrait,
      corners,
      center: to3((u0 + u1) / 2, (v0 + v1) / 2),
      samples,
      enabled: true,
    };
  });
}

function markRect(m: Uint8Array, nu: number, nv: number, r: Rect, g: number): void {
  for (let j = Math.max(0, r.v0 - g); j < Math.min(nv, r.v1 + g); j++)
    for (let i = Math.max(0, r.u0 - g); i < Math.min(nu, r.u1 + g); i++) m[j * nu + i] = 1;
}

/** Grille régulière : meilleur décalage (u, v) + rangées libres de glisser. */
export function packGrid(blocked: Uint8Array, nu: number, nv: number, cw: number, ch: number, g: number, portrait: boolean): Rect[] {
  if (cw > nu || ch > nv) return [];
  // préfixes cumulés par colonne
  const pref = new Int32Array((nv + 1) * nu);
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) pref[(j + 1) * nu + i] = pref[j * nu + i] + blocked[j * nu + i];
  const pitchV = ch + g;
  const pitchU = cw + g;
  let best: Rect[] = [];
  let bestScore = -Infinity;
  const free = new Uint8Array(nu);
  const fpref = new Int32Array(nu + 1);
  for (let ov = 0; ov < pitchV && ov + ch <= nv; ov++) {
    const rows: { v0: number; fp: Int32Array; runs: [number, number][] }[] = [];
    for (let v0 = ov; v0 + ch <= nv; v0 += pitchV) {
      for (let i = 0; i < nu; i++) free[i] = pref[(v0 + ch) * nu + i] - pref[v0 * nu + i] === 0 ? 1 : 0;
      fpref[0] = 0;
      for (let i = 0; i < nu; i++) fpref[i + 1] = fpref[i] + free[i];
      const runs: [number, number][] = [];
      let s = -1;
      for (let i = 0; i <= nu; i++) {
        if (i < nu && free[i]) {
          if (s < 0) s = i;
        } else if (s >= 0) {
          runs.push([s, i]);
          s = -1;
        }
      }
      rows.push({ v0, fp: fpref.slice(), runs });
    }
    // a) colonnes alignées sur tout le pan
    for (let ou = 0; ou < pitchU; ou++) {
      const rects: Rect[] = [];
      for (const r of rows)
        for (let u0 = ou; u0 + cw <= nu; u0 += pitchU)
          if (r.fp[u0 + cw] - r.fp[u0] === cw) rects.push({ u0, v0: r.v0, u1: u0 + cw, v1: r.v0 + ch, portrait });
      const sc = score(rects, nu, nv) + 0.5; // léger bonus à l'alignement
      if (rects.length > best.length || (rects.length === best.length && sc > bestScore)) {
        best = rects;
        bestScore = sc;
      }
    }
    // b) chaque rangée centrée dans ses segments libres
    const rects: Rect[] = [];
    for (const r of rows)
      for (const [a, b] of r.runs) {
        const k = Math.floor((b - a + g) / pitchU);
        if (k <= 0) continue;
        const start = a + Math.floor((b - a - (k * pitchU - g)) / 2);
        for (let m = 0; m < k; m++) rects.push({ u0: start + m * pitchU, v0: r.v0, u1: start + m * pitchU + cw, v1: r.v0 + ch, portrait });
      }
    const sc = score(rects, nu, nv);
    if (rects.length > best.length || (rects.length === best.length && sc > bestScore)) {
      best = rects;
      bestScore = sc;
    }
  }
  return best;
}

/** À nombre égal : on préfère un champ bien centré sur le pan. */
function score(rects: Rect[], nu: number, nv: number): number {
  if (!rects.length) return -Infinity;
  let su = 0;
  let sv = 0;
  for (const r of rects) {
    su += (r.u0 + r.u1) / 2;
    sv += (r.v0 + r.v1) / 2;
  }
  return -Math.hypot(su / rects.length - nu / 2, sv / rects.length - nv / 2) / Math.max(nu, nv);
}
