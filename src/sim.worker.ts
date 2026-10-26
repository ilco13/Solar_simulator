/// <reference lib="webworker" />
import { type Scene, daySunHours, shadowMap } from './shading';
import { localToUtc, monthOfDay, sunPosition } from './sun';
import { type SimInput, simulate } from './sim';

let scene: Scene | null = null;

export type WorkerRequest =
  | { type: 'scene'; scene: Scene }
  | { type: 'trees'; leafless: boolean[]; deciduous: Uint8Array; leaflessTransmission: number }
  | { type: 'day'; reqId: number; day: number; lat: number; lon: number; stepMin: number; i0: number; j0: number; w: number; h: number }
  | { type: 'shadow'; reqId: number; az: number; el: number; month: number; i0: number; j0: number; w: number; h: number }
  | { type: 'simulate'; reqId: number; input: SimInput; leafless: boolean[]; deciduous: Uint8Array; leaflessTransmission: number };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  if (m.type === 'scene') {
    scene = m.scene;
    return;
  }
  if (!scene) return;
  if (m.type === 'trees') {
    scene = { ...scene, leafless: m.leafless, deciduous: m.deciduous, leaflessTransmission: m.leaflessTransmission };
    return;
  }
  if (m.type === 'shadow') {
    const data = shadowMap(scene, m.az, m.el, m.month, m.i0, m.j0, m.w, m.h);
    (self as unknown as Worker).postMessage({ type: 'shadow', reqId: m.reqId, data }, [data.buffer]);
  } else if (m.type === 'day') {
    // positions du soleil sur la journée (heure locale), au milieu de chaque pas
    const stepH = m.stepMin / 60;
    const sun: { az: number; el: number }[] = [];
    let dayLength = 0;
    for (let t = stepH / 2; t < 24; t += stepH) {
      const sp = sunPosition(localToUtc(m.day, t), m.lat, m.lon);
      if (sp.elevation > 0) {
        sun.push({ az: sp.azimuth, el: sp.elevation });
        dayLength += stepH;
      }
    }
    const data = daySunHours(scene, sun, stepH, monthOfDay(m.day), m.i0, m.j0, m.w, m.h);
    (self as unknown as Worker).postMessage({ type: 'day', reqId: m.reqId, data, dayLength }, [data.buffer]);
  } else if (m.type === 'simulate') {
    const s: Scene = { ...scene, leafless: m.leafless, deciduous: m.deciduous, leaflessTransmission: m.leaflessTransmission };
    const result = simulate(s, m.input, (f) => (self as unknown as Worker).postMessage({ type: 'progress', reqId: m.reqId, f }));
    (self as unknown as Worker).postMessage({ type: 'result', reqId: m.reqId, result });
  }
};
