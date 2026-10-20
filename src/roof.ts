import { type Grid, cellX, cellY, colOf, rowOf } from './grid';
import { type XY, DEG, distToRing, pointInPolygon, ringArea, ringCentroid, simplifyRing } from './geo';

/** Plan de toit : z = a·x + b·y + c (coordonnées Lambert-93). */
export interface Plane {
  a: number;
  b: number;
  c: number;
}

export interface RoofPan {
  id: string;
  name: string;
  ring: XY[]; // contour horizontal (Lambert-93)
  plane: Plane;
  obstacles: XY[][]; // zones interdites (cheminées, velux…)
  enabled: boolean; // pan utilisé pour poser des panneaux
  manualTilt?: number;
  manualAzimuth?: number;
}

export function planeZ(p: Plane, x: number, y: number): number {
  return p.a * x + p.b * y + p.c;
}

/** Inclinaison (°) du plan. */
export function planeTilt(p: Plane): number {
  return Math.atan(Math.hypot(p.a, p.b)) / DEG;
}

/** Azimut vrai (° depuis le nord) de la direction de la pente descendante. */
export function planeAzimuth(p: Plane, northOffset: number): number {
  const gridAz = Math.atan2(-p.a, -p.b) / DEG;
  return (((gridAz - northOffset) % 360) + 360) % 360;
}

/** Plan d'inclinaison/azimut donnés passant par (x, y, z). */
export function planeFrom(tiltDeg: number, azTrueDeg: number, northOffset: number, x: number, y: number, z: number): Plane {
  const s = Math.tan(tiltDeg * DEG);
  const g = (azTrueDeg + northOffset) * DEG;
  const a = -s * Math.sin(g);
  const b = -s * Math.cos(g);
  return { a, b, c: z - a * x - b * y };
}

/** Surface réelle (inclinée) du pan, m². */
export function panArea(pan: RoofPan): number {
  return ringArea(pan.ring) / Math.cos(planeTilt(pan.plane) * DEG);
}

// ---------- Ajustement de plan par moindres carrés ----------

interface Pt {
  x: number;
  y: number;
  z: number;
}

function solve3(m: number[], v: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  return [
    inv[0] * v[0] + inv[1] * v[1] + inv[2] * v[2],
    inv[3] * v[0] + inv[4] * v[1] + inv[5] * v[2],
    inv[6] * v[0] + inv[7] * v[1] + inv[8] * v[2],
  ];
}

/** Ajustement robuste (rejet itératif des points aberrants). */
export function fitPlane(pts: Pt[]): { plane: Plane; rms: number } | null {
  let cur = pts;
  let result: { plane: Plane; rms: number } | null = null;
  for (let it = 0; it < 4; it++) {
    if (cur.length < 3) break;
    let mx = 0;
    let my = 0;
    for (const p of cur) {
      mx += p.x;
      my += p.y;
    }
    mx /= cur.length;
    my /= cur.length;
    let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sz = 0, sxz = 0, syz = 0;
    for (const p of cur) {
      const x = p.x - mx;
      const y = p.y - my;
      sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sz += p.z; sxz += x * p.z; syz += y * p.z;
    }
    const s = solve3([sxx, sxy, sx, sxy, syy, sy, sx, sy, cur.length], [sxz, syz, sz]);
    if (!s) break;
    const plane = { a: s[0], b: s[1], c: s[2] - s[0] * mx - s[1] * my };
    let e2 = 0;
    for (const p of cur) e2 += (p.z - planeZ(plane, p.x, p.y)) ** 2;
    const rms = Math.sqrt(e2 / cur.length);
    result = { plane, rms };
    const lim = Math.max(0.12, 2.5 * rms);
    const next = cur.filter((p) => Math.abs(p.z - planeZ(plane, p.x, p.y)) <= lim);
    if (next.length === cur.length || next.length < 3) break;
    cur = next;
  }
  return result;
}

/** Ajuste le plan d'un pan à partir des points LiDAR à l'intérieur de son contour. */
export function planeFromDsm(dsm: Grid, ring: XY[]): Plane | null {
  const pts: Pt[] = [];
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const i0 = Math.max(0, colOf(dsm, Math.min(...xs)));
  const i1 = Math.min(dsm.w - 1, colOf(dsm, Math.max(...xs)));
  const j0 = Math.max(0, rowOf(dsm, Math.max(...ys)));
  const j1 = Math.min(dsm.h - 1, rowOf(dsm, Math.min(...ys)));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const x = cellX(dsm, i);
      const y = cellY(dsm, j);
      // on évite les bords (gouttière, faîtage) un peu bruités
      if (pointInPolygon(x, y, ring) && (ring.length < 3 || distToRing(x, y, ring) > 0.3)) pts.push({ x, y, z: dsm.data[j * dsm.w + i] });
    }
  if (pts.length < 6) {
    // contour trop petit : on garde tous les points
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = cellX(dsm, i);
        const y = cellY(dsm, j);
        if (pointInPolygon(x, y, ring)) pts.push({ x, y, z: dsm.data[j * dsm.w + i] });
      }
  }
  return fitPlane(pts)?.plane ?? null;
}

// ---------- Détection automatique des pans ----------

export interface DetectOptions {
  buffer: number; // marge autour de l'emprise cadastrale (débords de toit), m
  minArea: number; // surface mini d'un pan (m², horizontale)
}

/**
 * Découpe le toit d'un bâtiment en pans plans à partir du MNS LiDAR :
 * normales locales -> croissance de régions -> fusion -> réaffectation -> contours.
 */
export function detectPans(dsm: Grid, dtm: Grid, footprint: XY[], opts: DetectOptions = { buffer: 1.0, minArea: 4 }): RoofPan[] {
  const res = dsm.res;
  const xs = footprint.map((p) => p[0]);
  const ys = footprint.map((p) => p[1]);
  const pad = opts.buffer + 1;
  const gi0 = Math.max(1, colOf(dsm, Math.min(...xs) - pad));
  const gi1 = Math.min(dsm.w - 2, colOf(dsm, Math.max(...xs) + pad));
  const gj0 = Math.max(1, rowOf(dsm, Math.max(...ys) + pad));
  const gj1 = Math.min(dsm.h - 2, rowOf(dsm, Math.min(...ys) - pad));
  const bw = gi1 - gi0 + 1;
  const bh = gj1 - gj0 + 1;
  if (bw < 3 || bh < 3) return [];
  const n = bw * bh;
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  const Z = new Float64Array(n);
  const mask = new Uint8Array(n);
  for (let j = 0; j < bh; j++)
    for (let i = 0; i < bw; i++) {
      const k = j * bw + i;
      const gk = (gj0 + j) * dsm.w + gi0 + i;
      X[k] = cellX(dsm, gi0 + i);
      Y[k] = cellY(dsm, gj0 + j);
      Z[k] = dsm.data[gk];
      const h = dsm.data[gk] - dtm.data[gk];
      const inside = pointInPolygon(X[k], Y[k], footprint) || distToRing(X[k], Y[k], footprint) <= opts.buffer;
      if (inside && h > 1.8) mask[k] = 1;
    }

  // Normales locales (fenêtre 3x3)
  const la = new Float64Array(n);
  const lb = new Float64Array(n);
  const lrms = new Float64Array(n).fill(Infinity);
  const lcount = new Uint8Array(n);
  for (let j = 0; j < bh; j++)
    for (let i = 0; i < bw; i++) {
      const k = j * bw + i;
      if (!mask[k]) continue;
      const pts: Pt[] = [];
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= bw || jj >= bh) continue;
          const kk = jj * bw + ii;
          if (mask[kk]) pts.push({ x: X[kk] - X[k], y: Y[kk] - Y[k], z: Z[kk] });
        }
      lcount[k] = pts.length;
      if (pts.length < 6) continue;
      const f = fitPlaneSimple(pts);
      if (!f) continue;
      la[k] = f.a;
      lb[k] = f.b;
      lrms[k] = f.rms;
    }

  // Croissance de régions
  const label = new Int32Array(n).fill(-1);
  const seeds: number[] = [];
  for (let k = 0; k < n; k++) if (mask[k] && lcount[k] === 9 && lrms[k] < 0.06) seeds.push(k);
  seeds.sort((p, q) => lrms[p] - lrms[q]);
  const planes: Plane[] = [];
  const minCells = Math.max(6, Math.round(opts.minArea / (res * res) / 2));
  const nb4 = [-1, 1, -bw, bw];
  for (const seed of seeds) {
    if (label[seed] !== -1) continue;
    const id = planes.length;
    let plane: Plane = { a: la[seed], b: lb[seed], c: Z[seed] - la[seed] * X[seed] - lb[seed] * Y[seed] };
    const members: number[] = [seed];
    label[seed] = id;
    let nextRefit = 8;
    for (let q = 0; q < members.length; q++) {
      const k = members[q];
      const i = k % bw;
      for (const d of nb4) {
        const kk = k + d;
        if (kk < 0 || kk >= n) continue;
        if ((d === -1 && i === 0) || (d === 1 && i === bw - 1)) continue;
        if (!mask[kk] || label[kk] !== -1) continue;
        const dist = Math.abs(Z[kk] - planeZ(plane, X[kk], Y[kk]));
        if (dist > 0.12) continue;
        if (lrms[kk] < 0.1 && normalAngle(la[kk], lb[kk], plane.a, plane.b) > 15) continue;
        label[kk] = id;
        members.push(kk);
      }
      if (members.length >= nextRefit) {
        const f = fitPlane(members.map((m) => ({ x: X[m], y: Y[m], z: Z[m] })));
        if (f) plane = f.plane;
        nextRefit *= 2;
      }
    }
    if (members.length < minCells) {
      for (const m of members) label[m] = -2; // essayé, trop petit
      planes.push({ a: 0, b: 0, c: NaN });
      continue;
    }
    const f = fitPlane(members.map((m) => ({ x: X[m], y: Y[m], z: Z[m] })));
    planes.push(f ? f.plane : plane);
  }
  for (let k = 0; k < n; k++) if (label[k] === -2) label[k] = -1;

  // Fusion des régions voisines quasi coplanaires
  const parent = planes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const adj = new Set<string>();
  for (let k = 0; k < n; k++) {
    if (label[k] < 0) continue;
    const i = k % bw;
    for (const d of [1, bw, bw + 1, bw - 1]) {
      const kk = k + d;
      if (kk >= n || (d === 1 && i === bw - 1) || (d === bw + 1 && i === bw - 1) || (d === bw - 1 && i === 0)) continue;
      if (label[kk] >= 0 && label[kk] !== label[k]) adj.add(`${Math.min(label[k], label[kk])},${Math.max(label[k], label[kk])}`);
    }
  }
  const centroidOf = (id: number) => {
    let sx = 0, sy = 0, c = 0;
    for (let k = 0; k < n; k++)
      if (label[k] === id) {
        sx += X[k];
        sy += Y[k];
        c++;
      }
    return c ? [sx / c, sy / c] : [0, 0];
  };
  for (const e of adj) {
    const [p, q] = e.split(',').map(Number);
    const P = planes[p];
    const Q = planes[q];
    if (Number.isNaN(P.c) || Number.isNaN(Q.c)) continue;
    if (normalAngle(P.a, P.b, Q.a, Q.b) > 6) continue;
    const [cx, cy] = centroidOf(q);
    if (Math.abs(planeZ(P, cx, cy) - planeZ(Q, cx, cy)) > 0.2) continue;
    parent[find(q)] = find(p);
  }
  for (let k = 0; k < n; k++) if (label[k] >= 0) label[k] = find(label[k]);
  const roots = [...new Set(Array.from(label).filter((l) => l >= 0))];
  for (const r of roots) {
    const pts: Pt[] = [];
    for (let k = 0; k < n; k++) if (label[k] === r) pts.push({ x: X[k], y: Y[k], z: Z[k] });
    const f = fitPlane(pts);
    if (f) planes[r] = f.plane;
  }

  // Réaffectation de chaque cellule au plan voisin le plus proche (bords plus nets)
  for (let pass = 0; pass < 2; pass++) {
    const next = label.slice();
    for (let k = 0; k < n; k++) {
      if (!mask[k]) continue;
      const i = k % bw;
      const j = (k - i) / bw;
      let best = -1;
      let bestD = 0.2;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= bw || jj >= bh) continue;
          const l = label[jj * bw + ii];
          if (l < 0) continue;
          const d = Math.abs(Z[k] - planeZ(planes[l], X[k], Y[k]));
          if (d < bestD) {
            bestD = d;
            best = l;
          }
        }
      next[k] = best;
    }
    label.set(next);
  }

  // Contours
  const pans: RoofPan[] = [];
  for (const r of roots) {
    const cells = keepLargestComponent(label, r, bw, bh);
    if (cells * res * res < opts.minArea) continue;
    const ring = traceOutline(label, r, bw, bh).map(([ci, cj]) => [dsm.x0 + (gi0 + ci) * res, dsm.y0 - (gj0 + cj) * res] as XY);
    // Pan quasi convexe (cas courant) : enveloppe convexe, plus propre que l'escalier des pixels.
    const hull = convexHull(ring);
    let simple =
      ringArea(ring) / Math.max(1e-6, ringArea(hull)) > 0.85
        ? removeCollinear(simplifyRing(hull, 0.3), 10)
        : removeCollinear(simplifyRing(ring, 0.45), 10);
    if (simple.length < 3) continue;
    simple = regularize(simple, planes[r]);
    const plane = planes[r];
    pans.push({ id: '', name: '', ring: simple, plane, obstacles: [], enabled: true });
  }
  pans.sort((p, q) => ringArea(q.ring) - ringArea(p.ring));
  pans.forEach((p, i) => {
    p.id = `pan${i + 1}`;
    p.name = `Pan ${i + 1}`;
    p.obstacles = detectObstacles(dsm, p);
  });
  return pans;
}

function fitPlaneSimple(pts: Pt[]): { a: number; b: number; rms: number } | null {
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sz = 0, sxz = 0, syz = 0;
  for (const p of pts) {
    sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y; sx += p.x; sy += p.y; sz += p.z; sxz += p.x * p.z; syz += p.y * p.z;
  }
  const s = solve3([sxx, sxy, sx, sxy, syy, sy, sx, sy, pts.length], [sxz, syz, sz]);
  if (!s) return null;
  let e2 = 0;
  for (const p of pts) e2 += (p.z - (s[0] * p.x + s[1] * p.y + s[2])) ** 2;
  return { a: s[0], b: s[1], rms: Math.sqrt(e2 / pts.length) };
}

function normalAngle(a1: number, b1: number, a2: number, b2: number): number {
  const n1 = Math.hypot(a1, b1, 1);
  const n2 = Math.hypot(a2, b2, 1);
  const c = (a1 * a2 + b1 * b2 + 1) / (n1 * n2);
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

/** Ne garde que la plus grande composante connexe d'une étiquette ; renvoie sa taille. */
function keepLargestComponent(label: Int32Array, r: number, bw: number, bh: number): number {
  const n = bw * bh;
  const comp = new Int32Array(n).fill(-1);
  let best = -1;
  let bestSize = 0;
  let c = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] !== r || comp[s] !== -1) continue;
    const stack = [s];
    comp[s] = c;
    let size = 0;
    while (stack.length) {
      const k = stack.pop()!;
      size++;
      const i = k % bw;
      const j = (k - i) / bw;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= bw || jj >= bh) continue;
        const kk = jj * bw + ii;
        if (label[kk] === r && comp[kk] === -1) {
          comp[kk] = c;
          stack.push(kk);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = c;
    }
    c++;
  }
  for (let k = 0; k < n; k++) if (label[k] === r && comp[k] !== best) label[k] = -1;
  return bestSize;
}

/** Contour extérieur (coins de cellules) d'une étiquette. */
export function traceOutline(label: Int32Array, r: number, bw: number, bh: number): XY[] {
  const isIn = (i: number, j: number) => i >= 0 && j >= 0 && i < bw && j < bh && label[j * bw + i] === r;
  const edges = new Map<string, XY[]>();
  const add = (a: XY, b: XY) => {
    const key = `${a[0]},${a[1]}`;
    const l = edges.get(key);
    if (l) l.push(b);
    else edges.set(key, [b]);
  };
  for (let j = 0; j < bh; j++)
    for (let i = 0; i < bw; i++) {
      if (!isIn(i, j)) continue;
      if (!isIn(i, j - 1)) add([i, j], [i + 1, j]);
      if (!isIn(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
      if (!isIn(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
      if (!isIn(i - 1, j)) add([i, j + 1], [i, j]);
    }
  let bestLoop: XY[] = [];
  let bestArea = 0;
  for (const [startKey, list] of edges) {
    while (list.length) {
      const start = startKey.split(',').map(Number) as XY;
      const loop: XY[] = [start];
      let cur = list.pop()!;
      let guard = 0;
      while (!(cur[0] === start[0] && cur[1] === start[1]) && guard++ < 1e6) {
        loop.push(cur);
        const nx = edges.get(`${cur[0]},${cur[1]}`);
        if (!nx || !nx.length) break;
        cur = nx.pop()!;
      }
      const a = ringArea(loop);
      if (a > bestArea) {
        bestArea = a;
        bestLoop = loop;
      }
    }
  }
  return bestLoop;
}

function removeCollinear(ring: XY[], angleTol: number): XY[] {
  let out = ring.slice();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const p = out[(i - 1 + out.length) % out.length];
      const c = out[i];
      const nx = out[(i + 1) % out.length];
      const a1 = Math.atan2(c[1] - p[1], c[0] - p[0]);
      const a2 = Math.atan2(nx[1] - c[1], nx[0] - c[0]);
      let d = Math.abs(a1 - a2) / DEG;
      if (d > 180) d = 360 - d;
      if (d < angleTol || Math.hypot(c[0] - p[0], c[1] - p[1]) < 0.3) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Redresse les côtés presque parallèles / perpendiculaires à la ligne de gouttière
 * (le LiDAR à 50 cm donne des bords en escalier).
 */
function regularize(ring: XY[], plane: Plane): XY[] {
  const g = Math.hypot(plane.a, plane.b);
  if (g < 0.05) return ring;
  // axe de gouttière (horizontal, perpendiculaire à la pente)
  const ux = -plane.b / g;
  const uy = plane.a / g;
  const n = ring.length;
  // direction de chaque côté, recalée si proche de l'axe ou de sa perpendiculaire
  const lines: { px: number; py: number; dx: number; dy: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    const along = Math.abs(dx * ux + dy * uy);
    if (along > Math.cos(12 * DEG)) {
      const s = Math.sign(dx * ux + dy * uy);
      dx = s * ux;
      dy = s * uy;
    } else if (along < Math.sin(12 * DEG)) {
      const s = Math.sign(dx * -uy + dy * ux);
      dx = -s * uy;
      dy = s * ux;
    }
    lines.push({ px: (a[0] + b[0]) / 2, py: (a[1] + b[1]) / 2, dx, dy });
  }
  const out: XY[] = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i - 1 + n) % n];
    const L2 = lines[i];
    const det = L1.dx * -L2.dy - L1.dy * -L2.dx;
    if (Math.abs(det) < 1e-6) {
      out.push(ring[i]);
      continue;
    }
    const t = ((L2.px - L1.px) * -L2.dy - (L2.py - L1.py) * -L2.dx) / det;
    const p: XY = [L1.px + t * L1.dx, L1.py + t * L1.dy];
    // sécurité : on refuse un déplacement de sommet trop grand
    out.push(Math.hypot(p[0] - ring[i][0], p[1] - ring[i][1]) < 1.2 ? p : ring[i]);
  }
  return out;
}

/** Cheminées, chiens-assis… : cellules nettement hors du plan à l'intérieur du pan. */
export function detectObstacles(dsm: Grid, pan: RoofPan): XY[][] {
  const xs = pan.ring.map((p) => p[0]);
  const ys = pan.ring.map((p) => p[1]);
  const i0 = Math.max(0, colOf(dsm, Math.min(...xs)));
  const i1 = Math.min(dsm.w - 1, colOf(dsm, Math.max(...xs)));
  const j0 = Math.max(0, rowOf(dsm, Math.max(...ys)));
  const j1 = Math.min(dsm.h - 1, rowOf(dsm, Math.min(...ys)));
  const bw = i1 - i0 + 1;
  const bh = j1 - j0 + 1;
  if (bw <= 0 || bh <= 0) return [];
  const flag = new Uint8Array(bw * bh);
  for (let j = 0; j < bh; j++)
    for (let i = 0; i < bw; i++) {
      const x = cellX(dsm, i0 + i);
      const y = cellY(dsm, j0 + j);
      if (!pointInPolygon(x, y, pan.ring) || distToRing(x, y, pan.ring) < 0.4) continue;
      const d = dsm.data[(j0 + j) * dsm.w + i0 + i] - planeZ(pan.plane, x, y);
      if (d > 0.35) flag[j * bw + i] = 1;
    }
  const seen = new Uint8Array(bw * bh);
  const out: XY[][] = [];
  for (let s = 0; s < bw * bh; s++) {
    if (!flag[s] || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let mi = Infinity, ma = -Infinity, mj = Infinity, mb = -Infinity, cnt = 0;
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % bw;
      const j = (k - i) / bw;
      cnt++;
      mi = Math.min(mi, i); ma = Math.max(ma, i); mj = Math.min(mj, j); mb = Math.max(mb, j);
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= bw || jj >= bh) continue;
          const kk = jj * bw + ii;
          if (flag[kk] && !seen[kk]) {
            seen[kk] = 1;
            stack.push(kk);
          }
        }
    }
    if (cnt < 2) continue; // bruit isolé
    const xA = dsm.x0 + (i0 + mi) * dsm.res;
    const xB = dsm.x0 + (i0 + ma + 1) * dsm.res;
    const yA = dsm.y0 - (j0 + mj) * dsm.res;
    const yB = dsm.y0 - (j0 + mb + 1) * dsm.res;
    out.push([[xA, yA], [xB, yA], [xB, yB], [xA, yB]]);
  }
  return out;
}

export function convexHull(pts: XY[]): XY[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XY[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: XY[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export { ringCentroid };
