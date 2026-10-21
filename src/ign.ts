import type { Grid } from './grid';
import type { XY } from './geo';

// Géoplateforme IGN : services ouverts, gratuits, sans clé, avec CORS.
const WMS = 'https://data.geopf.fr/wms-r/wms';
const WFS = 'https://data.geopf.fr/wfs/ows';
const GEOCODE = 'https://data.geopf.fr/geocodage';

export const ORTHO_URL =
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
export const PLAN_URL =
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/png&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

export type ElevationLayer = 'MNS' | 'MNT';

/**
 * Télécharge un modèle d'élévation LiDAR HD (MNS = surface avec bâtiments et arbres,
 * MNT = sol nu) en Lambert-93, résolution 0,5 m.
 */
export async function fetchElevation(layer: ElevationLayer, cx: number, cy: number, halfSize: number, res = 0.5): Promise<Grid> {
  const x0 = Math.round(cx - halfSize);
  const y1 = Math.round(cy + halfSize);
  const size = Math.round((2 * halfSize) / res) * res;
  const n = Math.round(size / res);
  const bbox = [x0, y1 - size, x0 + size, y1].join(',');
  const url =
    `${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=IGNF_LIDAR-HD_${layer}_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93` +
    `&STYLES=&CRS=EPSG:2154&BBOX=${bbox}&WIDTH=${n}&HEIGHT=${n}&FORMAT=image/x-bil;bits=32`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`IGN ${layer} : HTTP ${r.status}`);
  const ct = r.headers.get('content-type') ?? '';
  if (!ct.includes('bil')) throw new Error(`IGN ${layer} : réponse inattendue (${ct}). Zone non couverte par le LiDAR HD ?`);
  const buf = await r.arrayBuffer();
  const data = new Float32Array(buf.slice(0));
  if (data.length !== n * n) throw new Error(`IGN ${layer} : taille inattendue`);
  fillNoData(data, n, n);
  return { x0, y0: y1, res, w: n, h: n, data };
}

/** Remplace les valeurs absentes (-99999…) par la moyenne des voisins valides. */
function fillNoData(d: Float32Array, w: number, h: number): void {
  const bad = (v: number) => !(v > -1000 && v < 9000);
  let missing = 0;
  for (let k = 0; k < d.length; k++) if (bad(d[k])) missing++;
  if (missing === d.length) throw new Error('Aucune donnée LiDAR HD sur cette zone');
  for (let pass = 0; pass < 50 && missing > 0; pass++) {
    const copy = d.slice();
    missing = 0;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!bad(copy[k])) continue;
        let s = 0;
        let c = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
            const v = copy[jj * w + ii];
            if (!bad(v)) {
              s += v;
              c++;
            }
          }
        if (c > 0) d[k] = s / c;
        else missing++;
      }
  }
}

export interface Building {
  id: string;
  ring: XY[]; // Lambert-93
  height: number | null;
  nature: string;
}

/** Emprises des bâtiments (BD TOPO) dans un carré centré. */
export async function fetchBuildings(cx: number, cy: number, halfSize: number): Promise<Building[]> {
  const bbox = [cx - halfSize, cy - halfSize, cx + halfSize, cy + halfSize].map((v) => v.toFixed(1)).join(',');
  const url =
    `${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:batiment` +
    `&OUTPUTFORMAT=application/json&SRSNAME=EPSG:2154&BBOX=${bbox},EPSG:2154&COUNT=2000`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`BD TOPO : HTTP ${r.status}`);
  const gj = await r.json();
  const out: Building[] = [];
  for (const f of gj.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    const polys: number[][][][] = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    polys.forEach((poly, k) => {
      const ring = poly[0].map((c) => [c[0], c[1]] as XY);
      if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
      out.push({
        id: `${f.properties?.cleabs ?? f.id}${k ? '_' + k : ''}`,
        ring,
        height: f.properties?.hauteur ?? null,
        nature: f.properties?.nature ?? '',
      });
    });
  }
  return out;
}

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
}

export async function geocode(q: string): Promise<GeocodeResult[]> {
  const r = await fetch(`${GEOCODE}/search?q=${encodeURIComponent(q)}&limit=6`);
  if (!r.ok) return [];
  const gj = await r.json();
  return (gj.features ?? []).map((f: any) => ({
    label: f.properties.label,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
}

export interface LidarInfo {
  start: string; // date de début d'acquisition (AAAA-MM-JJ)
  end: string;
  mission: string;
}

/** Date du survol LiDAR HD sur la dalle contenant (x, y). */
export async function fetchLidarDate(x: number, y: number): Promise<LidarInfo | null> {
  const bbox = [x - 1, y - 1, x + 1, y + 1].join(',');
  try {
    const r = await fetch(
      `${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=IGNF_LIDAR-HD_METADONNEE:metadata&OUTPUTFORMAT=application/json&SRSNAME=EPSG:2154&BBOX=${bbox},EPSG:2154&COUNT=1`,
    );
    const p = (await r.json()).features?.[0]?.properties;
    if (!p) return null;
    const d = (s: string) => String(s ?? '').slice(0, 10);
    return { start: d(p.date_debut_acquisition), end: d(p.date_fin_acquisition), mission: p.code_mission ?? '' };
  } catch {
    return null;
  }
}

/** Date de prise de vue de la photo aérienne (BD ORTHO) en (x, y). */
export async function fetchOrthoDate(x: number, y: number): Promise<string | null> {
  const bbox = [x - 1, y - 1, x + 1, y + 1].join(',');
  try {
    const r = await fetch(
      `${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ORTHOIMAGERY.ORTHOPHOTOS.GRAPHE-MOSAIQUAGE:graphe_bdortho&OUTPUTFORMAT=application/json&SRSNAME=EPSG:2154&BBOX=${bbox},EPSG:2154&COUNT=5`,
    );
    const fs = (await r.json()).features ?? [];
    // la plus fine (plus petite échelle de mosaïquage)
    fs.sort((a: any, b: any) => (a.properties.echelle ?? 99) - (b.properties.echelle ?? 99));
    return fs[0] ? String(fs[0].properties.date_vol).slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Photo aérienne en Lambert-93, pixels alignés sur la grille LiDAR (luminance 0-255, ligne 0 = nord). */
export async function fetchOrthoGray(x0: number, y1: number, size: number, n: number): Promise<Float32Array> {
  const url =
    `${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ORTHOIMAGERY.ORTHOPHOTOS&STYLES=&CRS=EPSG:2154` +
    `&BBOX=${x0},${y1 - size},${x0 + size},${y1}&WIDTH=${n}&HEIGHT=${n}&FORMAT=image/jpeg`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Photo IGN : HTTP ${r.status}`);
  const bmp = await createImageBitmap(await r.blob());
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;
  const out = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) out[k] = 0.299 * d[4 * k] + 0.587 * d[4 * k + 1] + 0.114 * d[4 * k + 2];
  return out;
}
