import { DEG } from './geo';

export interface SunPos {
  elevation: number; // degrés, réfraction incluse
  azimuth: number; // degrés depuis le nord, sens horaire
  zenith: number; // degrés (sans réfraction)
}

/** Position du soleil (algorithme NOAA), date en millisecondes UTC. */
export function sunPosition(ms: number, lat: number, lon: number): SunPos {
  const jd = ms / 86400000 + 2440587.5;
  const jc = (jd - 2451545) / 36525;
  const L0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const Mr = M * DEG;
  const C =
    Math.sin(Mr) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * jc;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);
  const meanObliq = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(omega * DEG);
  const decl = Math.asin(Math.sin(obliq * DEG) * Math.sin(appLong * DEG));
  const y = Math.tan((obliq * DEG) / 2) ** 2;
  const L0r = L0 * DEG;
  const eqTime =
    (4 / DEG) *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr));
  const minutes = (((ms % 86400000) + 86400000) % 86400000) / 60000;
  let tst = (minutes + eqTime + 4 * lon) % 1440;
  if (tst < 0) tst += 1440;
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const latr = lat * DEG;
  let cosZ = Math.sin(latr) * Math.sin(decl) + Math.cos(latr) * Math.cos(decl) * Math.cos(ha * DEG);
  cosZ = Math.max(-1, Math.min(1, cosZ));
  const zen = Math.acos(cosZ) / DEG;
  const denom = Math.cos(latr) * Math.sin(zen * DEG);
  let az: number;
  if (Math.abs(denom) < 1e-9) az = 180;
  else {
    let c = (Math.sin(latr) * cosZ - Math.sin(decl)) / denom;
    c = Math.max(-1, Math.min(1, c));
    const a = Math.acos(c) / DEG;
    az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  }
  const elev = 90 - zen;
  return { elevation: elev + refraction(elev), azimuth: az, zenith: zen };
}

function refraction(el: number): number {
  if (el > 85) return 0;
  const te = Math.tan(el * DEG);
  let r: number;
  if (el > 5) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (el > -0.575) r = 1735 + el * (-518.2 + el * (103.4 + el * (-12.79 + el * 0.711)));
  else r = -20.772 / te;
  return r / 3600;
}

/** Éclairement extraterrestre normal (W/m²) selon le jour de l'année. */
export function extraterrestrial(dayOfYear: number): number {
  return 1367 * (1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365));
}

// ---- Heure légale française (Europe/Paris) ----
export const BASE_YEAR = 2025; // année non bissextile utilisée pour l'année type

function lastSundayUTC(year: number, month: number): number {
  const d = new Date(Date.UTC(year, month + 1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getTime();
}

/** Décalage UTC (heures) en France pour un instant UTC donné. */
export function parisOffset(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  const start = lastSundayUTC(y, 2) + 3600e3; // dernier dimanche de mars, 1h UTC
  const end = lastSundayUTC(y, 9) + 3600e3; // dernier dimanche d'octobre, 1h UTC
  return ms >= start && ms < end ? 2 : 1;
}

/** Jour de l'année (1-365) + heure locale -> ms UTC. */
export function localToUtc(day: number, localHour: number): number {
  const midnightUtc = Date.UTC(BASE_YEAR, 0, day);
  let ms = midnightUtc + localHour * 3600e3 - 3600e3;
  ms = midnightUtc + localHour * 3600e3 - parisOffset(ms) * 3600e3;
  return ms;
}

export const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

export function dayLabel(day: number): string {
  const d = new Date(Date.UTC(BASE_YEAR, 0, day));
  return `${d.getUTCDate()} ${MONTHS_FR[d.getUTCMonth()]}`;
}

export function monthOfDay(day: number): number {
  return new Date(Date.UTC(BASE_YEAR, 0, day)).getUTCMonth();
}
