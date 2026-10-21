import proj4 from 'proj4';

// Lambert-93 : projection native des données LiDAR HD de l'IGN.
proj4.defs(
  'EPSG:2154',
  '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
);

export type XY = [number, number];
export type XYZ = [number, number, number];

const conv = proj4('EPSG:4326', 'EPSG:2154');

/** WGS84 (lat, lon) -> Lambert-93 (x, y) en mètres. */
export function toL93(lat: number, lon: number): XY {
  const [x, y] = conv.forward([lon, lat]);
  return [x, y];
}

/** Lambert-93 -> WGS84 [lat, lon]. */
export function toWGS(x: number, y: number): XY {
  const [lon, lat] = conv.inverse([x, y]);
  return [lat, lon];
}

/**
 * Azimut "grille" (Lambert-93) du nord géographique, en degrés.
 * azimutGrille = azimutVrai + northOffset.
 */
export function gridNorthOffset(lat: number, lon: number): number {
  const a = toL93(lat, lon);
  const b = toL93(lat + 0.001, lon);
  return (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
}

export function pointInPolygon(x: number, y: number, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

export function distToRing(px: number, py: number, ring: XY[]): number {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    d = Math.min(d, distToSegment(px, py, ring[j][0], ring[j][1], ring[i][0], ring[i][1]));
  }
  return d;
}

export function ringArea(ring: XY[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a / 2);
}

export function ringCentroid(ring: XY[]): XY {
  let sx = 0;
  let sy = 0;
  for (const p of ring) {
    sx += p[0];
    sy += p[1];
  }
  return [sx / ring.length, sy / ring.length];
}

/** Simplification Douglas-Peucker d'un anneau fermé (sans répétition du 1er point). */
export function simplifyRing(ring: XY[], tol: number): XY[] {
  if (ring.length <= 4) return ring.slice();
  // On coupe l'anneau au point le plus éloigné du premier pour obtenir 2 polylignes.
  let far = 0;
  let best = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = dp(ring.slice(0, far + 1), tol);
  const b = dp([...ring.slice(far), ring[0]], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : ring.slice();
}

function dp(pts: XY[], tol: number): XY[] {
  if (pts.length <= 2) return pts.slice();
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  let idx = -1;
  let dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i][0], pts[i][1], ax, ay, bx, by);
    if (d > dmax) {
      dmax = d;
      idx = i;
    }
  }
  if (dmax <= tol) return [pts[0], pts[pts.length - 1]];
  const l = dp(pts.slice(0, idx + 1), tol);
  const r = dp(pts.slice(idx), tol);
  return [...l.slice(0, -1), ...r];
}

export const DEG = Math.PI / 180;

export function compass(azDeg: number): string {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
  return names[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
}

/** Rectangle à angles droits : côté A→B, largeur = distance signée de C à la droite AB. */
export function rectFrom3(a: XY, b: XY, c: XY): XY[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  const w = (c[0] - a[0]) * nx + (c[1] - a[1]) * ny;
  return [a, b, [b[0] + w * nx, b[1] + w * ny], [a[0] + w * nx, a[1] + w * ny]];
}

/** Point C contraint pour que le côté B→C soit parallèle ou perpendiculaire au côté A→B. */
export function orthoSnap(a: XY, b: XY, c: XY): XY {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const dx = (b[0] - a[0]) / len;
  const dy = (b[1] - a[1]) / len;
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  const along = vx * dx + vy * dy;
  const across = -vx * dy + vy * dx;
  return Math.abs(along) > Math.abs(across) ? [b[0] + along * dx, b[1] + along * dy] : [b[0] - across * dy, b[1] + across * dx];
}
