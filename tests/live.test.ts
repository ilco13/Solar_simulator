// Tests sur données réelles IGN (réseau requis) : LIVE=1 npx vitest run tests/live.test.ts
import { describe, it, expect } from 'vitest';
import { installCurlFetch } from './curlFetch';
if (process.env.LIVE) installCurlFetch();
import { fetchElevation, fetchBuildings } from '../src/ign';
import { detectPans, planeTilt, planeAzimuth, panArea } from '../src/roof';
import { gridNorthOffset, toWGS, pointInPolygon, compass } from '../src/geo';

const X = Number(process.env.LX ?? 913759);
const Y = Number(process.env.LY ?? 6264720);

describe.skipIf(!process.env.LIVE)('données IGN réelles', () => {
  it('détecte les pans d\'une maison', async () => {
    const [dsm, dtm, bats] = await Promise.all([
      fetchElevation('MNS', X, Y, 60),
      fetchElevation('MNT', X, Y, 60),
      fetchBuildings(X, Y, 60),
    ]);
    const b = bats.find((b) => pointInPolygon(X, Y, b.ring))!;
    expect(b).toBeTruthy();
    const [lat, lon] = toWGS(X, Y);
    const no = gridNorthOffset(lat, lon);
    const t0 = performance.now();
    const pans = detectPans(dsm, dtm, b.ring);
    console.log('north offset', no.toFixed(2), 'temps', (performance.now() - t0).toFixed(0), 'ms', 'bâtiment', b.id, b.ring.length);
    for (const p of pans)
      console.log(p.name, 'incl', planeTilt(p.plane).toFixed(1), 'az', planeAzimuth(p.plane, no).toFixed(0), compass(planeAzimuth(p.plane, no)), 'surf', panArea(p).toFixed(1), 'sommets', p.ring.length, 'obst', p.obstacles.length);
    expect(pans.length).toBeGreaterThan(0);
  }, 60000);
});
