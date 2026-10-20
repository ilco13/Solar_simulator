import { DEG } from './geo';
import { type Scene, horizonBlocks, rayTransmission } from './shading';
import { BASE_YEAR, extraterrestrial, sunPosition } from './sun';

export interface SimPanel {
  id: string;
  panIndex: number;
  samples: number[]; // 9 points × (x,y,z)
}

export interface SimPan {
  id: string;
  tilt: number; // °
  azimuth: number; // ° vrai
  a: number;
  b: number;
  c: number;
}

export interface SimWeather {
  lat: number;
  lon: number;
  timeOffsetH: number;
  ghi: Float32Array;
  dni: Float32Array;
  dhi: Float32Array;
  t2m: Float32Array;
}

export interface SimElec {
  wp: number;
  gamma: number; // %/°C
  noct: number;
  microEff: number;
  microAcMax: number; // W par panneau
  centralEff: number;
  centralAcMax: number; // W (0 = illimité)
  losses: number; // 0-1
  albedo: number;
}

export interface SimInput {
  pans: SimPan[];
  panels: SimPanel[];
  weather: SimWeather;
  elec: SimElec;
}

/** Résultats mensuels (12 valeurs par panneau / par pan, à plat dans des tableaux). */
export interface SimResult {
  nPanels: number;
  nPans: number;
  poaFree: Float64Array; // kWh/m² reçus sans aucun masque
  poaHorizon: Float64Array; // avec relief lointain seulement
  poaShaded: Float64Array; // avec relief + arbres + bâtiments
  eMicro: Float64Array; // kWh AC, micro-onduleurs
  eIdeal: Float64Array; // kWh AC, micro-onduleurs sans aucune ombre
  eCentral: Float64Array; // kWh AC par pan, onduleur central 1 MPPT/pan
  eCentralIdeal: Float64Array;
  svf: Float64Array; // part du ciel diffus vue par chaque panneau (feuilles)
  ms: number;
}

/**
 * Puissance d'une chaîne de sous-chaînes en série protégées par diodes bypass.
 * Le courant est imposé ; une sous-chaîne moins éclairée que ce courant est court-circuitée.
 * Le MPPT trouve le meilleur courant. g = éclairement (∝ courant), c = "tension" (W par W/m²).
 */
export function bypassStringPower(g: Float64Array, c: Float64Array, n: number, idx: Int32Array): number {
  for (let i = 0; i < n; i++) idx[i] = i;
  const sub = idx.subarray(0, n);
  sub.sort((p, q) => g[q] - g[p]);
  let cum = 0;
  let best = 0;
  for (let k = 0; k < n; k++) {
    cum += c[sub[k]];
    const p = g[sub[k]] * cum;
    if (p > best) best = p;
  }
  return best;
}

export function simulate(scene: Scene, input: SimInput, onProgress?: (f: number) => void): SimResult {
  const t0 = performance.now();
  const { pans, panels, weather: wx, elec } = input;
  const nP = panels.length;
  const nPan = pans.length;
  const res: SimResult = {
    nPanels: nP,
    nPans: nPan,
    poaFree: new Float64Array(nP * 12),
    poaHorizon: new Float64Array(nP * 12),
    poaShaded: new Float64Array(nP * 12),
    eMicro: new Float64Array(nP * 12),
    eIdeal: new Float64Array(nP * 12),
    eCentral: new Float64Array(nPan * 12),
    eCentralIdeal: new Float64Array(nPan * 12),
    svf: new Float64Array(nP),
    ms: 0,
  };

  // Géométrie des pans
  const geo = pans.map((p) => {
    const b = p.tilt * DEG;
    const g = p.azimuth * DEG;
    return { cosB: Math.cos(b), sinB: Math.sin(b), az: g, nx: Math.sin(b) * Math.sin(g), ny: Math.sin(b) * Math.cos(g), nz: Math.cos(b) };
  });
  const byPan: number[][] = pans.map(() => []);
  panels.forEach((p, i) => byPan[p.panIndex].push(i));

  // Facteurs de vue du ciel (diffus isotrope) par panneau : relief seul / feuilles / sans feuilles
  const svfH = new Float64Array(nP);
  const svfOn = new Float64Array(nP);
  const svfOff = new Float64Array(nP);
  panels.forEach((p, i) => {
    const pg = geo[p.panIndex];
    const pan = pans[p.panIndex];
    const [x, y, z] = [p.samples[12], p.samples[13], p.samples[14]]; // point central
    let wTot = 0, wH = 0, wOn = 0, wOff = 0;
    for (let az = 5; az < 360; az += 10)
      for (let el = 3; el < 90; el += 6) {
        const ca = Math.cos(el * DEG);
        const dir = [ca * Math.sin(az * DEG), ca * Math.cos(az * DEG), Math.sin(el * DEG)];
        const cosI = dir[0] * pg.nx + dir[1] * pg.ny + dir[2] * pg.nz;
        if (cosI <= 0) continue;
        const wgt = cosI * ca;
        wTot += wgt;
        if (horizonBlocks(scene, az, el)) continue;
        wH += wgt;
        const ign = { a: pan.a, b: pan.b, c: pan.c, tol: 0.35 };
        wOn += wgt * rayTransmission(scene, x, y, z + 0.1, az, el, false, 0.5, 0.15, ign);
        wOff += wgt * rayTransmission(scene, x, y, z + 0.1, az, el, true, 0.5, 0.15, ign);
      }
    svfH[i] = wTot ? wH / wTot : 1;
    svfOn[i] = wTot ? wOn / wTot : 1;
    svfOff[i] = wTot ? wOff / wTot : 1;
    res.svf[i] = svfOn[i];
  });

  const tPts = new Float64Array(9);
  const gSub = new Float64Array(3);
  const cSub = new Float64Array(3);
  const idx3 = new Int32Array(3);
  const maxSub = Math.max(3, ...byPan.map((l) => l.length * 3));
  const gStr = new Float64Array(maxSub);
  const cStr = new Float64Array(maxSub);
  const idxStr = new Int32Array(maxSub);
  const panDc = new Float64Array(nPan);
  const panDcIdeal = new Float64Array(nPan);
  const cUnit = elec.wp / 3 / 1000;
  const lossF = 1 - elec.losses;
  const start = Date.UTC(BASE_YEAR, 0, 1);
  const n = Math.min(8760, wx.ghi.length);

  for (let h = 0; h < n; h++) {
    if (onProgress && h % 240 === 0) onProgress(h / n);
    const ghi = wx.ghi[h];
    if (ghi <= 0) continue;
    const ms = start + (h + wx.timeOffsetH) * 3600e3;
    const month = new Date(ms).getUTCMonth();
    const sp = sunPosition(ms, wx.lat, wx.lon);
    const el = sp.elevation;
    const zen = (90 - el) * DEG;
    const cosZ = Math.cos(zen);
    const sinZ = Math.sin(zen);
    const dni = el > 0 ? wx.dni[h] : 0;
    const dhi = wx.dhi[h];
    const hb = el > 0 && horizonBlocks(scene, sp.azimuth, el);
    const Ai = Math.min(1, dni / extraterrestrial(Math.floor(h / 24) + 1));
    const leafless = scene.leafless[month];
    const tair = wx.t2m[h];
    let centralTotal = 0;
    let centralIdealTotal = 0;

    for (let pi = 0; pi < nPan; pi++) {
      const pg = geo[pi];
      const list = byPan[pi];
      if (!list.length) continue;
      const pan = pans[pi];
      const ign = { a: pan.a, b: pan.b, c: pan.c, tol: 0.35 };
      const cosAOI = cosZ * pg.cosB + sinZ * pg.sinB * Math.cos(sp.azimuth * DEG - pg.az);
      const c0 = Math.max(0, cosAOI);
      const beam = dni * c0;
      const circ = (dhi * Ai * c0) / Math.max(cosZ, 0.087);
      const iso = dhi * (1 - Ai) * (1 + pg.cosB) / 2;
      const grd = ghi * elec.albedo * (1 - pg.cosB) / 2;
      const iam = c0 > 0 ? Math.max(0, 1 - 0.05 * (1 / c0 - 1)) : 0;
      const direct = beam + circ;
      const directIam = direct * iam;
      const needRays = direct > 0 && !hb && el > 0;
      let ns = 0;
      for (const p of list) {
        const panel = panels[p];
        if (needRays) {
          for (let k = 0; k < 9; k++)
            tPts[k] = rayTransmission(scene, panel.samples[3 * k], panel.samples[3 * k + 1], panel.samples[3 * k + 2] + 0.1, sp.azimuth, el, leafless, 0.5, 0.15, ign);
        } else tPts.fill(hb ? 0 : 1);
        let tMean = 0;
        for (let k = 0; k < 9; k++) tMean += tPts[k];
        tMean /= 9;
        const svf = leafless ? svfOff[p] : svfOn[p];
        const free = direct + iso + grd;
        const horiz = (hb ? 0 : direct) + iso * svfH[p] + grd;
        const shaded = (hb ? 0 : direct * tMean) + iso * svf + grd;
        const o = p * 12 + month;
        res.poaFree[o] += free / 1000;
        res.poaHorizon[o] += horiz / 1000;
        res.poaShaded[o] += shaded / 1000;

        // Électrique : chaque sous-chaîne est limitée par son point le plus ombré
        const diffuse = iso * svf + grd;
        let gMean = 0;
        for (let s = 0; s < 3; s++) {
          const tm = Math.min(tPts[3 * s], tPts[3 * s + 1], tPts[3 * s + 2]);
          gSub[s] = directIam * tm + diffuse;
          gMean += gSub[s] / 3;
        }
        const gIdeal = directIam + iso + grd;
        const ft = 1 + (elec.gamma / 100) * (tair + ((elec.noct - 20) / 800) * gMean - 25);
        const ftIdeal = 1 + (elec.gamma / 100) * (tair + ((elec.noct - 20) / 800) * gIdeal - 25);
        const c = cUnit * ft;
        for (let s = 0; s < 3; s++) {
          cSub[s] = c;
          gStr[ns] = gSub[s];
          cStr[ns] = c;
          ns++;
        }
        const dc = bypassStringPower(gSub, cSub, 3, idx3);
        const dcIdeal = cUnit * ftIdeal * 3 * gIdeal;
        res.eMicro[o] += (Math.min(dc * elec.microEff, elec.microAcMax) * lossF) / 1000;
        res.eIdeal[o] += (Math.min(dcIdeal * elec.microEff, elec.microAcMax) * lossF) / 1000;
        panDcIdeal[pi] += dcIdeal;
      }
      panDc[pi] = bypassStringPower(gStr, cStr, ns, idxStr);
      centralTotal += panDc[pi];
      centralIdealTotal += panDcIdeal[pi];
    }
    // Onduleur central : rendement + écrêtage éventuel, réparti au prorata des pans
    const clip = elec.centralAcMax > 0 ? Math.min(1, elec.centralAcMax / Math.max(1e-9, centralTotal * elec.centralEff)) : 1;
    const clipI = elec.centralAcMax > 0 ? Math.min(1, elec.centralAcMax / Math.max(1e-9, centralIdealTotal * elec.centralEff)) : 1;
    for (let pi = 0; pi < nPan; pi++) {
      res.eCentral[pi * 12 + month] += (panDc[pi] * elec.centralEff * clip * lossF) / 1000;
      res.eCentralIdeal[pi * 12 + month] += (panDcIdeal[pi] * elec.centralEff * clipI * lossF) / 1000;
      panDc[pi] = 0;
      panDcIdeal[pi] = 0;
    }
  }
  onProgress?.(1);
  res.ms = performance.now() - t0;
  return res;
}
