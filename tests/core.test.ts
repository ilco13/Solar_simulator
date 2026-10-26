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

describe('toit automatique', async () => {
  const { generateRoof, panRun, virtualPlane, planeZ, azimuthFromEdge } = await import('../src/roof');
  const dtm = { x0: -20, y0: 30, res: 0.5, w: 120, h: 120, data: new Float32Array(14400).fill(100) };
  // maison 12 × 8 m, coins cliqués un peu de travers
  const corners: [number, number][] = [[0, 0], [12, 0.05], [12, 8], [0.05, 8]];
  it('4 pans : 2 trapèzes + 2 triangles, faîtage commun à la même hauteur', () => {
    const pans = generateRoof(corners, 'quatre');
    expect(pans.map((p) => p.ring.length).sort()).toEqual([3, 3, 4, 4]);
    const ridges = pans.map((p) => {
      const az = azimuthFromEdge(p.ring, p.gutter, 0);
      const pl = virtualPlane(p.ring, 30, az, 3, 0, dtm, 100);
      return Math.max(...p.ring.map((q) => planeZ(pl, q[0], q[1])));
    });
    for (const r of ridges) expect(r).toBeCloseTo(103 + 4 * Math.tan(Math.PI / 6), 1);
  });
  it('2 pans sur la longueur : largeur gouttière → faîtage = demi-largeur', () => {
    const pans = generateRoof(corners, 'deux-long');
    expect(pans).toHaveLength(2);
    expect(panRun(pans[0].ring, 0)).toBeCloseTo(4, 1);
  });
  it('faîtage saisi -> pente', () => {
    // gouttière 3 m, faîtage 5,3 m, demi-largeur 4 m -> atan(2,3/4) = 29,9°
    expect((Math.atan((5.3 - 3) / 4) * 180) / Math.PI).toBeCloseTo(29.9, 1);
  });
});

describe('calage photo / LiDAR', async () => {
  const { findOffset, lidarEdges } = await import('../src/calage');
  it('retrouve un décalage connu', () => {
    const n = 120;
    const ndsm = new Float32Array(n * n);
    const mask = new Uint8Array(n * n).fill(1);
    const photo = new Float32Array(n * n).fill(80);
    // 3 "maisons" ; sur la photo elles sont décalées de +3 colonnes (est) et +2 lignes (sud)
    for (const [i0, j0, w, h] of [[20, 30, 16, 12], [60, 50, 20, 14], [40, 85, 14, 18]])
      for (let j = j0; j < j0 + h; j++)
        for (let i = i0; i < i0 + w; i++) {
          ndsm[j * n + i] = 6;
          photo[(j + 2) * n + i + 3] = 200;
        }
    const r = findOffset(photo, lidarEdges(ndsm, mask, n), n, 0.5, 8);
    // il faut ramener la photo de 1,5 m vers l'ouest et 1 m vers le nord
    expect(r.dx).toBeCloseTo(-1.5, 1);
    expect(r.dy).toBeCloseTo(1.0, 1);
    expect(r.confidence).toBeGreaterThan(3);
  });
});

describe('tracé rectangle', async () => {
  const { rectFrom3, orthoSnap } = await import('../src/geo');
  it('3 clics -> rectangle à angles droits, même si le 3e clic est de travers', () => {
    const r = rectFrom3([0, 0], [10, 1], [3, 7]);
    for (let i = 0; i < 4; i++) {
      const a = r[i], b = r[(i + 1) % 4], c = r[(i + 2) % 4];
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
      expect(Math.abs(dot)).toBeLessThan(1e-9);
    }
  });
  it('Maj : côté perpendiculaire au précédent', () => {
    const c = orthoSnap([0, 0], [10, 0], [10.4, 5]);
    expect(c[0]).toBeCloseTo(10, 9);
    expect(c[1]).toBeCloseTo(5, 9);
  });
});

describe('heures de soleil sur la journée', async () => {
  const { daySunHours } = await import('../src/shading');
  it('au pied nord d\'un mur de 10 m : aucun soleil le 21 décembre, plein soleil loin du mur', () => {
    const w = 200, h = 200;
    const dsm = new Float32Array(w * h).fill(100);
    // mur est-ouest à y = 60 m (lignes 80-81)
    for (let i = 0; i < w; i++) for (let j = 80; j < 82; j++) dsm[j * w + i] = 110;
    const s = {
      x0: 0, y0: 100, res: 0.5, w, h, dsm, maxZ: 110,
      treeLabel: new Int32Array(w * h), deciduous: new Uint8Array(1), leafless: Array(12).fill(false),
      leaflessTransmission: 0.5, northOffset: 0, horizon: new Float32Array(360),
    };
    const sun: { az: number; el: number }[] = [];
    for (let t = 0.125; t < 24; t += 0.25) {
      const p = sunPosition(Date.UTC(2025, 11, 21, 0, 0) + t * 3600e3, 43.45, 5.64);
      if (p.elevation > 0) sun.push({ az: p.azimuth, el: p.elevation });
    }
    const hours = daySunHours(s, sun, 0.25, 11, 0, 0, w, h);
    const at = (x: number, y: number) => hours[Math.floor(100 - y) / 0.5 * w + Math.floor(x / 0.5)];
    expect(at(50, 63)).toBe(0); // 2 m au nord du mur
    expect(at(50, 20)).toBeGreaterThan(8.5); // loin au sud : toute la journée (~9 h 15)
  });
});

describe('carte d\'ombre par balayage', async () => {
  const { shadowMap, rayTransmission } = await import('../src/shading');
  it('concorde avec le lancer de rayons (> 97 % des cellules)', () => {
    const w = 160, h = 160;
    const dsm = new Float32Array(w * h).fill(100);
    // quelques bâtiments et un "arbre"
    for (const [i0, j0, bw, bh, z] of [[30, 40, 20, 14, 107], [90, 70, 16, 24, 112], [60, 110, 10, 10, 115]])
      for (let j = j0; j < j0 + bh; j++) for (let i = i0; i < i0 + bw; i++) dsm[j * w + i] = z;
    const s = {
      x0: 0, y0: 80, res: 0.5, w, h, dsm, maxZ: 115,
      treeLabel: new Int32Array(w * h), deciduous: new Uint8Array(1), leafless: Array(12).fill(false),
      leaflessTransmission: 0.5, northOffset: -1.9, horizon: new Float32Array(360),
    };
    for (const [az, el] of [[135, 20], [180, 25], [230, 12], [95, 35], [300, 15]]) {
      const m = shadowMap(s, az, el, 0, 0, 0, w, h);
      let agree = 0;
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++) {
          const x = (i + 0.5) * 0.5, y = 80 - (j + 0.5) * 0.5;
          const r = rayTransmission(s, x, y, dsm[j * w + i] + 0.05, az, el, false, 0.6, 0.25);
          if (r === m[j * w + i]) agree++;
        }
      expect(agree / (w * h)).toBeGreaterThan(0.97);
    }
  });
});
