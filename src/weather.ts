
/** Année météo type (8760 h, UTC) + profil d'horizon lointain. */
export interface Weather {
  source: string;
  lat: number;
  lon: number;
  elevation: number;
  radiationDb: string;
  years: [number, number];
  timeOffsetH: number;
  ghi: Float32Array;
  dni: Float32Array;
  dhi: Float32Array;
  t2m: Float32Array;
  ws: Float32Array;
  horizon: Float32Array; // hauteur (°) de l'horizon pour chaque degré d'azimut vrai (0-359)
}

const CACHE_PREFIX = 'pvgis:';

export function roundedKey(lat: number, lon: number): { lat: number; lon: number; file: string } {
  const rl = Math.round(lat / 0.05) * 0.05;
  const ro = Math.round(lon / 0.05) * 0.05;
  return { lat: +rl.toFixed(2), lon: +ro.toFixed(2), file: `tmy_${rl.toFixed(2)}_${ro.toFixed(2)}.json` };
}

export function pvgisUrls(lat: number, lon: number): { tmy: string; horizon: string } {
  const k = roundedKey(lat, lon);
  return {
    tmy: `https://re.jrc.ec.europa.eu/api/v5_3/tmy?lat=${k.lat}&lon=${k.lon}&usehorizon=0&outputformat=json`,
    horizon: `https://re.jrc.ec.europa.eu/api/v5_3/printhorizon?lat=${k.lat}&lon=${k.lon}&outputformat=json`,
  };
}

function horizonTable(h: { az: number; h: number }[]): Float32Array {
  const out = new Float32Array(360);
  if (!h.length) return out;
  const pts = [...h].sort((a, b) => a.az - b.az);
  for (let a = 0; a < 360; a++) {
    let lo = pts[pts.length - 1];
    let hi = pts[0];
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].az <= a) lo = pts[i];
      if (pts[i].az >= a) {
        hi = pts[i];
        break;
      }
    }
    let span = hi.az - lo.az;
    if (span < 0) span += 360;
    let t = a - lo.az;
    if (t < 0) t += 360;
    out[a] = span === 0 ? lo.h : lo.h + ((hi.h - lo.h) * t) / span;
  }
  return out;
}

/** Format compact produit par tools/fetch_pvgis.py. */
export function parseCompact(j: any): Weather {
  return {
    source: j.source,
    lat: j.lat,
    lon: j.lon,
    elevation: j.elevation,
    radiationDb: j.radiation_db,
    years: j.years,
    timeOffsetH: j.time_offset_h ?? 0.5,
    ghi: Float32Array.from(j.ghi),
    dni: Float32Array.from(j.dni),
    dhi: Float32Array.from(j.dhi),
    t2m: Float32Array.from(j.t2m),
    ws: Float32Array.from(j.ws ?? []),
    horizon: horizonTable(j.horizon ?? []),
  };
}

/** Réponses brutes de l'API PVGIS (tmy + printhorizon) -> format compact. */
export function compactFromRaw(tmy: any, horizon: any | null): any {
  const rows = tmy.outputs.tmy_hourly;
  const md = tmy.inputs.meteo_data ?? {};
  return {
    source: 'PVGIS 5.3 (JRC, Commission européenne) – année météo type',
    lat: tmy.inputs.location.latitude,
    lon: tmy.inputs.location.longitude,
    elevation: tmy.inputs.location.elevation,
    radiation_db: md.radiation_db ?? 'PVGIS',
    years: [md.year_min, md.year_max],
    time_offset_h: tmy.inputs.location.irradiance_time_offset ?? 0.5,
    ghi: rows.map((r: any) => r['G(h)']),
    dni: rows.map((r: any) => r['Gb(n)']),
    dhi: rows.map((r: any) => r['Gd(h)']),
    t2m: rows.map((r: any) => r['T2m']),
    ws: rows.map((r: any) => r['WS10m']),
    horizon: horizon
      ? horizon.outputs.horizon_profile.map((h: any) => ({ az: (h.A + 180 + 360) % 360, h: h.H_hor }))
      : [],
  };
}

export class NeedManualWeather extends Error {}

/**
 * Charge la météo PVGIS : 1) cache navigateur, 2) fichier fourni avec l'appli,
 * 3) proxy local (npm run dev). Sinon -> import manuel.
 */
export async function loadWeather(lat: number, lon: number): Promise<Weather> {
  const k = roundedKey(lat, lon);
  try {
    const c = localStorage.getItem(CACHE_PREFIX + k.file);
    if (c) return parseCompact(JSON.parse(c));
  } catch {
    /* stockage indisponible */
  }
  try {
    const r = await fetch(`./data/pvgis/${k.file}`);
    if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) return parseCompact(await r.json());
  } catch {
    /* pas de fichier embarqué */
  }
  try {
    const [t, h] = await Promise.all([
      fetch(`./pvgis-api/tmy?lat=${k.lat}&lon=${k.lon}&usehorizon=0&outputformat=json`),
      fetch(`./pvgis-api/printhorizon?lat=${k.lat}&lon=${k.lon}&outputformat=json`),
    ]);
    if (t.ok && (t.headers.get('content-type') ?? '').includes('json')) {
      const compact = compactFromRaw(await t.json(), h.ok ? await h.json() : null);
      cacheWeather(k.file, compact);
      return parseCompact(compact);
    }
  } catch {
    /* pas de proxy */
  }
  throw new NeedManualWeather('Données PVGIS indisponibles');
}

export function cacheWeather(file: string, compact: any): void {
  try {
    localStorage.setItem(CACHE_PREFIX + file, JSON.stringify(compact));
  } catch {
    /* quota dépassé : tant pis */
  }
}

export function horizonAt(w: { horizon: Float32Array }, azTrue: number): number {
  const a = ((azTrue % 360) + 360) % 360;
  const i = Math.floor(a);
  const t = a - i;
  return w.horizon[i] * (1 - t) + w.horizon[(i + 1) % 360] * t;
}

