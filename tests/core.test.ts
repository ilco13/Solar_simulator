import { describe, it, expect } from 'vitest';
import { sunPosition, localToUtc, parisOffset } from '../src/sun';
import { packGrid, layoutPan, DEFAULT_LAYOUT } from '../src/layout';
import { bypassStringPower, simulate } from '../src/sim';
import { rayTransmission, type Scene } from '../src/shading';
import { planeFrom, planeTilt, planeAzimuth, fitPlane, type RoofPan } from '../src/roof';

describe('position du soleil', () => {
  it('midi solaire au solstice d\'été à Peynier (~70°, plein sud)', () => {
    // 21 juin 2025, midi solaire ≈ 11h38 UTC à 5,64°E
    const s = sunPosition(Date.UTC(2025, 5, 21, 11, 38), 43.45, 5.64);
    expect(s.elevation).toBeGreaterThan(69.5);
    expect(s.elevation).toBeLessThan(70.6);
    expect(Math.abs(s.azimuth - 180)).toBeLessThan(2);
  });
  it('solstice d\'hiver : ~23° à midi', () => {
    const s = sunPosition(Date.UTC(2025, 11, 21, 11, 39), 43.45, 5.64);
    expect(s.elevation).toBeGreaterThan(22.5);
    expect(s.elevation).toBeLessThan(23.6);
  });
  it('matin : soleil à l\'est', () => {
    const s = sunPosition(Date.UTC(2025, 2, 20, 7, 0), 43.45, 5.64);
    expect(s.azimuth).toBeGreaterThan(90);
    expect(s.azimuth).toBeLessThan(130);
  });
  it('heure légale', () => {
    expect(parisOffset(Date.UTC(2025, 0, 10))).toBe(1);
    expect(parisOffset(Date.UTC(2025, 6, 10))).toBe(2);
    expect(new Date(localToUtc(182, 14)).getUTCHours()).toBe(12); // 1er juillet 14h -> 12h UTC
  });
});

describe('plans', () => {
  it('inclinaison/azimut aller-retour', () => {
    const p = planeFrom(30, 200, -1.9, 1000, 2000, 50);
    expect(planeTilt(p)).toBeCloseTo(30, 6);
    expect(planeAzimuth(p, -1.9)).toBeCloseTo(200, 6);
  });
  it('ajustement robuste ignore une cheminée', () => {
    const pts = [];
    for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) pts.push({ x, y, z: 0.3 * x + 5 + (x === 5 && y === 5 ? 1.5 : 0) });
    const f = fitPlane(pts)!;
    expect(f.plane.a).toBeCloseTo(0.3, 3);
    expect(f.plane.b).toBeCloseTo(0, 3);
  });
});

describe('calepinage', () => {
  it('rectangle libre : nombre maximal attendu', () => {
    // 10 m × 4 m à 2 cm, panneaux 1,0 × 1,7 (50 × 85 cellules), jeu 1 cellule
    const nu = 500, nv = 200;
    const r = packGrid(new Uint8Array(nu * nv), nu, nv, 50, 85, 1, true);
    expect(r.length).toBe(9 * 2);
  });
  it('pan réel : plus de panneaux en "auto" qu\'en orientation imposée', () => {
    const plane = planeFrom(17, 180, 0, 0, 0, 10);
    const pan: RoofPan = { id: 'p', name: 'p', ring: [[0, 0], [11, 0], [11, 5.2], [0, 5.2]], plane, obstacles: [], enabled: true };
    const auto = layoutPan(pan, 0, 1.722, 1.134, DEFAULT_LAYOUT).length;
    const por = layoutPan(pan, 0, 1.722, 1.134, { ...DEFAULT_LAYOUT, orientation: 'portrait' }).length;
    const pay = layoutPan(pan, 0, 1.722, 1.134, { ...DEFAULT_LAYOUT, orientation: 'paysage' }).length;
    expect(auto).toBeGreaterThanOrEqual(Math.max(por, pay));
    // u : 11 - 2×0,3 = 10,4 m -> 9 colonnes de 1,134 ; v : 5,2/cos17° - 0,6 = 4,84 m -> 2 rangées de 1,722
    expect(por).toBe(18);
  });
  it('un obstacle retire des panneaux', () => {
    const plane = planeFrom(30, 180, 0, 0, 0, 10);
    const pan: RoofPan = { id: 'p', name: 'p', ring: [[0, 0], [8, 0], [8, 4], [0, 4]], plane, obstacles: [], enabled: true };
    const n0 = layoutPan(pan, 0, 1.722, 1.134, DEFAULT_LAYOUT).length;
    pan.obstacles = [[[3.5, 1.5], [4.5, 1.5], [4.5, 2.5], [3.5, 2.5]]];
    const n1 = layoutPan(pan, 0, 1.722, 1.134, DEFAULT_LAYOUT).length;
    expect(n1).toBeLessThan(n0);
  });
});

describe('diodes bypass', () => {
  it('sans ombre = somme des puissances', () => {
    const g = Float64Array.from([800, 800, 800]);
    const c = Float64Array.from([1, 1, 1]);
    expect(bypassStringPower(g, c, 3, new Int32Array(3))).toBeCloseTo(2400);
  });
  it('une sous-chaîne ombrée est contournée', () => {
    const g = Float64Array.from([800, 100, 800]);
    const c = Float64Array.from([1, 1, 1]);
    expect(bypassStringPower(g, c, 3, new Int32Array(3))).toBeCloseTo(1600);
  });
});

function flatScene(): Scene {
  const w = 200, h = 200;
  const dsm = new Float32Array(w * h).fill(100);
  return {
    x0: 0, y0: 100, res: 0.5, w, h, dsm, maxZ: 100,
    treeLabel: new Int32Array(w * h), deciduous: new Uint8Array(10), leafless: Array(12).fill(false),
    leaflessTransmission: 0.5, northOffset: 0, horizon: new Float32Array(360),
  };
}

describe('ombres', () => {
  it('un mur de 10 m au sud ombre un point au sol quand le soleil est bas', () => {
    const s = flatScene();
    // mur à y = 40 m (ligne j = 120), le point est à y = 50 m
    for (let i = 0; i < s.w; i++) for (let j = 120; j < 122; j++) s.dsm[j * s.w + i] = 110;
    s.maxZ = 110;
    expect(rayTransmission(s, 50, 50, 100.05, 180, 20, false, 0.5, 0.2)).toBe(0); // tan20*10 = 3,6 m < 10 m
    expect(rayTransmission(s, 50, 50, 100.05, 180, 60, false, 0.5, 0.2)).toBe(1); // tan60*9 = 15,6 m > 10 m
    expect(rayTransmission(s, 50, 50, 100.05, 0, 20, false, 0.5, 0.2)).toBe(1); // soleil au nord
  });
  it('arbre caduc sans feuilles laisse passer une partie du soleil', () => {
    const s = flatScene();
    for (let j = 120; j < 124; j++) for (let i = 98; i < 102; i++) {
      s.dsm[j * s.w + i] = 108;
      s.treeLabel[j * s.w + i] = 1;
    }
    s.maxZ = 108;
    s.deciduous[1] = 1;
    expect(rayTransmission(s, 50, 50, 100.05, 180, 15, false, 0.5, 0.2)).toBe(0);
    expect(rayTransmission(s, 50, 50, 100.05, 180, 15, true, 0.5, 0.2)).toBeCloseTo(0.5);
  });
});

describe('simulation annuelle', () => {
  it('sans obstacle : perte nulle, ordre de grandeur de production cohérent', () => {
    const s = flatScene();
    const ghi = new Float32Array(8760), dni = new Float32Array(8760), dhi = new Float32Array(8760), t2m = new Float32Array(8760).fill(15);
    // ciel clair simplifié
    for (let h = 0; h < 8760; h++) {
      const sp = sunPosition(Date.UTC(2025, 0, 1) + (h + 0.5) * 3600e3, 43.45, 5.64);
      if (sp.elevation > 0) {
        const sinE = Math.sin((sp.elevation * Math.PI) / 180);
        dni[h] = 800 * sinE ** 0.3;
        dhi[h] = 100;
        ghi[h] = dni[h] * sinE + dhi[h];
      }
    }
    const plane = planeFrom(30, 180, 0, 50, 50, 100);
    const samples: number[] = [];
    for (let k = 0; k < 9; k++) samples.push(50 + (k % 3) * 0.3, 50 + Math.floor(k / 3) * 0.5, 100);
    const r = simulate(s, {
      pans: [{ id: 'p', tilt: 30, azimuth: 180, ...plane }],
      panels: [{ id: 'x', panIndex: 0, samples: samples.map((v, i) => (i % 3 === 2 ? plane.a * samples[i - 2] + plane.b * samples[i - 1] + plane.c : v)) }],
      weather: { lat: 43.45, lon: 5.64, timeOffsetH: 0.5, ghi, dni, dhi, t2m },
      elec: { wp: 400, gamma: -0.3, noct: 45, microEff: 0.97, microAcMax: 1000, centralEff: 0.975, centralAcMax: 0, losses: 0.03, albedo: 0.2 },
    });
    const sum = (a: Float64Array) => a.reduce((x, y) => x + y, 0);
    expect(sum(r.poaShaded) / sum(r.poaFree)).toBeGreaterThan(0.999);
    const kwhPerKwp = sum(r.eMicro) / 0.4;
    expect(kwhPerKwp).toBeGreaterThan(1200);
    expect(kwhPerKwp).toBeLessThan(2600);
    expect(sum(r.eCentral)).toBeGreaterThan(0);
  });
});

describe('toit dessiné (absent du LiDAR)', async () => {
  const { virtualPlane, azimuthFromEdge, guessGutter, planeZ } = await import('../src/roof');
  const azimuthFromGutter = (r: [number, number][], no: number) => azimuthFromEdge(r, guessGutter(r), no);
  const dtm = { x0: 0, y0: 100, res: 0.5, w: 200, h: 200, data: new Float32Array(200 * 200).fill(250) };
  it('la gouttière (1er côté) donne l\'azimut, pente vers l\'extérieur', () => {
    // gouttière au sud (y = 40), pan qui monte vers le nord
    const ring: [number, number][] = [[40, 40], [50, 40], [50, 45], [40, 45]];
    expect(azimuthFromGutter(ring, 0)).toBeCloseTo(180, 6);
    // gouttière à l'ouest
    expect(azimuthFromGutter([[40, 45], [40, 40], [45, 40], [45, 45]], 0)).toBeCloseTo(270, 6);
  });
  it('gouttière à la bonne hauteur, faîtage plus haut', () => {
    const ring: [number, number][] = [[40, 40], [50, 40], [50, 45], [40, 45]];
    const p = virtualPlane(ring, 30, 180, 3, 0, dtm);
    expect(planeZ(p, 45, 40)).toBeCloseTo(253, 6);
    expect(planeZ(p, 45, 45)).toBeCloseTo(253 + 5 * Math.tan(Math.PI / 6), 6);
  });
});

describe('toit 4 pans (trapèze)', async () => {
  const { guessGutter, azimuthFromEdge, virtualPlane } = await import('../src/roof');
  const { layoutPan, DEFAULT_LAYOUT } = await import('../src/layout');
  // trapèze : gouttière au sud (12 m), faîtage au nord (6 m), dessiné en commençant par un arêtier
  const ring: [number, number][] = [[0, 0], [3, 4], [9, 4], [12, 0]];
  const dtm = { x0: -10, y0: 20, res: 0.5, w: 80, h: 80, data: new Float32Array(6400).fill(100) };
  it('la gouttière est le plus long des côtés parallèles', () => {
    expect(guessGutter(ring)).toBe(3); // [12,0] -> [0,0]
    expect(azimuthFromEdge(ring, 3, 0)).toBeCloseTo(180, 6);
  });
  it('les rangées de panneaux sont parallèles à la gouttière', () => {
    const plane = virtualPlane(ring, 30, 180, 3, 0, dtm);
    const pan = { id: 'p', name: 'p', ring, plane, obstacles: [], enabled: true, eaveHeight: 3, gutter: 3 };
    const panels = layoutPan(pan, 0, 1.722, 1.134, DEFAULT_LAYOUT);
    expect(panels.length).toBeGreaterThan(4);
    for (const p of panels) {
      const [a, b] = p.corners;
      expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-6); // côté "u" horizontal, parallèle à y = 0
    }
  });
  it('pan LiDAR dont l\'azimut mesuré dévie de 4° : rangées calées sur la gouttière', () => {
    const plane = virtualPlane(ring, 30, 184, 3, 0, dtm);
    const pan = { id: 'p', name: 'p', ring, plane, obstacles: [], enabled: true };
    const panels = layoutPan(pan, 0, 1.722, 1.134, DEFAULT_LAYOUT);
    for (const p of panels) {
      const [a, b] = p.corners;
      expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-6);
    }
  });
});
