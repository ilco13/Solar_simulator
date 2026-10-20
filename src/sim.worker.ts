/// <reference lib="webworker" />
import { type Scene, shadowMap } from './shading';
import { type SimInput, simulate } from './sim';

let scene: Scene | null = null;

export type WorkerRequest =
  | { type: 'scene'; scene: Scene }
  | { type: 'trees'; leafless: boolean[]; deciduous: Uint8Array; leaflessTransmission: number }
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
  } else if (m.type === 'simulate') {
    const s: Scene = { ...scene, leafless: m.leafless, deciduous: m.deciduous, leaflessTransmission: m.leaflessTransmission };
    const result = simulate(s, m.input, (f) => (self as unknown as Worker).postMessage({ type: 'progress', reqId: m.reqId, f }));
    (self as unknown as Worker).postMessage({ type: 'result', reqId: m.reqId, result });
  }
};
