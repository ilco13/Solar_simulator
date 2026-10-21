import 'leaflet/dist/leaflet.css';
import './style.css';
import L from 'leaflet';
import { type XY, compass, distToRing, orthoSnap, rectFrom3, gridNorthOffset, pointInPolygon, ringArea, ringCentroid, toL93, toWGS } from './geo';
import type { Grid } from './grid';
import { type Building, ORTHO_URL, fetchBuildings, fetchElevation, fetchLidarDate, fetchOrthoDate, fetchOrthoGray, geocode } from './ign';
import { findOffset, lidarEdges } from './calage';
import { type RoofPan, type RoofKind, azimuthFromEdge, detectObstacles, edgeForAzimuth, generateRoof, groundUnder, guessGutter, gutterEdge, panRun, detectPans, panArea, planeAzimuth, planeFrom, planeFromDsm, planeTilt, planeZ, virtualPlane } from './roof';
import { type Tree, detectTrees } from './trees';
import { type Scene, sceneMaxZ } from './shading';
import { type LayoutOptions, type PlacedPanel, DEFAULT_LAYOUT, fromPlane, layoutPan, panFrame, toPlane } from './layout';
import { DEFAULT_ELEC, type ElecSettings, MICROS, PANELS, type PanelSpec } from './catalog';
import { type Weather, NeedManualWeather, cacheWeather, compactFromRaw, loadWeather, parseCompact, pvgisUrls, roundedKey } from './weather';
import type { SimInput, SimResult } from './sim';
import { MONTHS_FR, dayLabel, localToUtc, monthOfDay, sunPosition } from './sun';
import { GridOverlay } from './overlay';
import { renderMonthlyChart } from './chart';
import type { WorkerRequest } from './sim.worker';

// ======================================================================
// État
// ======================================================================

interface Project {
  version: number;
  building: { id: string; ring: XY[] } | null;
  pans: RoofPan[] | null;
  deciduousTrees: string[];
  leafless: boolean[];
  leaflessTransmission: number;
  panelId: string;
  customPanel: PanelSpec;
  layout: LayoutOptions;
  elec: ElecSettings;
  disabledPanels: string[];
  removedTrees: string[]; // arbres abattus depuis le survol LiDAR
  volumes: { ring: XY[]; height: number }[]; // constructions récentes absentes du LiDAR
  lidarMissing?: boolean; // maison construite après le survol LiDAR : pans dessinés
  photoOffset?: { dx: number; dy: number };
  drawShape?: 'rect' | 'free'; // tracé des pans / volumes / toits : rectangle 3 clics ou polygone libre // décalage de la photo aérienne pour la caler sur le LiDAR (m, est/nord)
  view?: { lat: number; lon: number; zoom: number };
}

const STORAGE_KEY = 'solar-sim-project-v1';
const PEYNIER: [number, number] = [43.4487, 5.6405];
const DATA_HALF = 150; // m : demi-côté de la zone LiDAR chargée
const SHADOW_HALF = 100; // m : demi-côté de la carte d'ombres affichée
const TREE_RADIUS = 60; // m : arbres affichés (cliquables) autour de la maison
const PAN_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

function defaultProject(): Project {
  return {
    version: 2,
    building: null,
    pans: null,
    deciduousTrees: [],
    leafless: [true, true, true, false, false, false, false, false, false, false, true, true],
    leaflessTransmission: 0.5,
    panelId: PANELS[0].id,
    customPanel: { ...PANELS[PANELS.length - 1] },
    layout: { ...DEFAULT_LAYOUT },
    elec: { ...DEFAULT_ELEC },
    disabledPanels: [],
    removedTrees: [],
    volumes: [],
  };
}

function loadProject(): Project {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) return { ...defaultProject(), ...JSON.parse(s) };
  } catch {
    /* rien */
  }
  return defaultProject();
}

const st = {
  project: loadProject(),
  pickMode: true,
  dsm: null as Grid | null,
  dsmBase: null as Float32Array | null, // MNS d'origine (avant ajout du toit dessiné, des volumes…)
  lastTilt: 17,
  lastEave: 2.8,
  dtm: null as Grid | null,
  buildings: [] as Building[],
  trees: [] as Tree[],
  treeLabel: null as Int32Array | null,
  northOffset: 0,
  lat: PEYNIER[0],
  lon: PEYNIER[1],
  weather: null as Weather | null,
  pans: [] as RoofPan[],
  panels: [] as PlacedPanel[],
  result: null as SimResult | null,
  resultPanels: [] as string[], // id des panneaux, dans l'ordre du résultat
  resultPans: [] as string[],
  selectedPan: null as string | null,
  mode: 'none' as 'none' | 'vertices' | 'addpan' | 'addobs' | 'addvol' | 'addroof',
  roofGen: { kind: 'quatre' as RoofKind, tilt: 17, eave: 2.8 },
  draft: [] as XY[],
  hoverPanel: null as string | null,
};

function save(): void {
  st.project.pans = st.pans.length ? st.pans : st.project.pans;
  const c = map.getCenter();
  st.project.view = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(st.project));
  } catch {
    /* stockage plein ou bloqué */
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number, d = 0) => v.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (v: number, d = 1) => `${fmt(v * 100, d)} %`;
const ll = (x: number, y: number) => L.latLng(toWGS(x, y) as L.LatLngTuple);

function panelSpec(): PanelSpec {
  return st.project.panelId === 'custom' ? st.project.customPanel : PANELS.find((p) => p.id === st.project.panelId) ?? PANELS[0];
}

function panelKey(p: PlacedPanel): string {
  return `${p.panId}:${Math.round(p.center[0] * 5)}:${Math.round(p.center[1] * 5)}`;
}

// ======================================================================
// Carte
// ======================================================================

const v0 = st.project.view;
const map = L.map('map', { maxZoom: 22, zoomSnap: 0.5, doubleClickZoom: false }).setView(v0 ? [v0.lat, v0.lon] : PEYNIER, v0?.zoom ?? 16);
map.createPane('photo').style.zIndex = '200';
L.tileLayer(ORTHO_URL, { pane: 'photo', maxNativeZoom: 19, maxZoom: 22, attribution: 'Orthophotos, LiDAR HD, BD TOPO © IGN · Ensoleillement PVGIS © Commission européenne' }).addTo(map);
map.createPane('relief').classList.add('relief-pane');
map.createPane('edges').style.zIndex = '460';
map.getPane('edges')!.style.pointerEvents = 'none';
map.createPane('shadow').classList.add('shadow-pane');
map.getPane('shadow')!.style.pointerEvents = 'none';

const layers = {
  pans: L.layerGroup().addTo(map),
  panels: L.layerGroup().addTo(map),
  labels: L.layerGroup().addTo(map),
  trees: L.layerGroup().addTo(map),
  edit: L.layerGroup().addTo(map),
  pick: L.layerGroup().addTo(map),
};
let reliefOverlay: GridOverlay | null = null;
let shadowOverlay: GridOverlay | null = null;
const panelPolys = new Map<string, L.Polygon>();

function setBusy(msg: string | null): void {
  $('busy').hidden = !msg;
  $('busy-msg').textContent = msg ?? '';
}

function status(msg: string, err = false): void {
  const el = $('loc-status');
  el.hidden = !msg;
  el.textContent = msg;
  el.classList.toggle('err', err);
}

// ======================================================================
// Workers (calcul des ombres et simulation annuelle hors du fil principal)
// ======================================================================

const shadowWorker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
const simWorker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
let shadowReq = 0;
let shadowBusy = false;
let shadowPending = false;
let simReq = 0;

function post(w: Worker, m: WorkerRequest): void {
  w.postMessage(m);
}

function deciduousArray(): Uint8Array {
  const a = new Uint8Array(st.trees.length + 1);
  for (const t of st.trees) a[t.id] = t.deciduous ? 1 : 0;
  return a;
}

function buildScene(): Scene | null {
  if (!st.dsm || !st.treeLabel) return null;
  return {
    x0: st.dsm.x0,
    y0: st.dsm.y0,
    res: st.dsm.res,
    w: st.dsm.w,
    h: st.dsm.h,
    dsm: st.dsm.data,
    maxZ: sceneMaxZ(st.dsm.data),
    treeLabel: st.treeLabel,
    deciduous: deciduousArray(),
    leafless: st.project.leafless,
    leaflessTransmission: st.project.leaflessTransmission,
    northOffset: st.northOffset,
    horizon: st.weather?.horizon ?? new Float32Array(360),
  };
}

function pushScene(): void {
  const s = buildScene();
  if (!s) return;
  post(shadowWorker, { type: 'scene', scene: s });
  post(simWorker, { type: 'scene', scene: s });
}

function pushTrees(): void {
  const m: WorkerRequest = { type: 'trees', leafless: st.project.leafless, deciduous: deciduousArray(), leaflessTransmission: st.project.leaflessTransmission };
  post(shadowWorker, m);
  post(simWorker, m);
}

shadowWorker.onmessage = (e) => {
  const m = e.data;
  if (m.type !== 'shadow') return;
  shadowBusy = false;
  drawShadow(m.data as Float32Array);
  if (shadowPending) {
    shadowPending = false;
    requestShadow();
  }
};

simWorker.onmessage = (e) => {
  const m = e.data;
  if (m.reqId !== simReq) return;
  if (m.type === 'progress') {
    ($('sim-progress').firstElementChild as HTMLElement).style.width = `${Math.round(m.f * 100)}%`;
  } else if (m.type === 'result') {
    $('sim-progress').hidden = true;
    st.result = m.result;
    renderResults();
  }
};

// ======================================================================
// 1. Localisation
// ======================================================================

let searchTimer = 0;
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = ($('q') as HTMLInputElement).value.trim();
  if (q.length < 3) {
    $('q-res').hidden = true;
    return;
  }
  searchTimer = window.setTimeout(async () => {
    const res = await geocode(q);
    const ul = $('q-res');
    ul.innerHTML = '';
    for (const r of res) {
      const li = document.createElement('li');
      li.textContent = r.label;
      li.onclick = () => {
        ul.hidden = true;
        ($('q') as HTMLInputElement).value = r.label;
        map.setView([r.lat, r.lon], 19);
        startPick();
      };
      ul.appendChild(li);
    }
    ul.hidden = !res.length;
  }, 300);
});

function startPick(): void {
  st.pickMode = true;
  $('loc-hint').innerHTML = 'Cliquez sur le <b>toit de votre maison</b> sur la carte.';
  map.getContainer().style.cursor = 'crosshair';
}

async function onPick(lat: number, lon: number): Promise<void> {
  const [x, y] = toL93(lat, lon);
  setBusy('Recherche du bâtiment…');
  try {
    const bats = await fetchBuildings(x, y, 40);
    let b = bats.find((q) => pointInPolygon(x, y, q.ring));
    if (!b) {
      const near = bats.map((q) => ({ q, d: distToRing(x, y, q.ring) })).sort((p, q) => p.d - q.d)[0];
      if (near && near.d < 6) b = near.q;
    }
    st.project.pans = null;
    st.project.disabledPanels = [];
    if (!b) {
      setBusy(null);
      if (!confirm('Aucun bâtiment cadastré ici (construction récente ?).\n\nDessiner la maison à la main à cet endroit ?')) {
        status('Cliquez au milieu du toit de votre maison.', true);
        return;
      }
      const h = 8;
      await analyze({ id: 'dessin', ring: [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]] }, null, true);
      return;
    }
    await analyze({ id: b.id, ring: b.ring });
  } catch (e) {
    status(`Erreur : ${(e as Error).message}`, true);
  } finally {
    setBusy(null);
  }
}

map.on('click', (e: L.LeafletMouseEvent) => {
  if (st.pickMode) {
    void onPick(e.latlng.lat, e.latlng.lng);
    return;
  }
  const p = toL93(e.latlng.lat, e.latlng.lng);
  if (st.mode === 'addpan' || st.mode === 'addvol' || st.mode === 'addroof') addDraftPoint(p, e.originalEvent.shiftKey);
  else if (st.mode === 'addobs') addObstaclePoint(p);
});

// ======================================================================
// Analyse : LiDAR, bâtiments, arbres, pans, météo
// ======================================================================

async function analyze(building: { id: string; ring: XY[] }, savedPans: RoofPan[] | null = null, forceManual = false): Promise<void> {
  const [cx, cy] = ringCentroid(building.ring);
  [st.lat, st.lon] = toWGS(cx, cy);
  st.northOffset = gridNorthOffset(st.lat, st.lon);
  st.pickMode = false;
  map.getContainer().style.cursor = '';
  setBusy('Téléchargement du LiDAR HD (IGN)…');
  status('');
  const weatherP = loadWeather(st.lat, st.lon).catch((e) => e as Error);
  void Promise.all([fetchLidarDate(cx, cy), fetchOrthoDate(cx, cy)]).then(([li, od]) => renderDates(li, od));
  const [dsm, dtm, bats] = await Promise.all([
    fetchElevation('MNS', cx, cy, DATA_HALF),
    fetchElevation('MNT', cx, cy, DATA_HALF),
    fetchBuildings(cx, cy, DATA_HALF),
  ]);
  st.dsm = dsm;
  st.dsmBase = dsm.data.slice();
  st.dtm = dtm;
  st.buildings = bats;
  st.project.building = building;

  setBusy('Repérage des arbres…');
  await tick();
  const td = detectTrees(dsm, dtm, bats.map((b) => b.ring));
  const dec = new Set(st.project.deciduousTrees);
  for (const t of td.trees) t.deciduous = dec.has(t.key);
  st.trees = td.trees;
  st.treeLabel = td.label;

  setBusy('Détection des pans de toit…');
  await tick();
  // Toit absent du LiDAR (survol IGN antérieur à la construction) ?
  st.project.lidarMissing = forceManual || roofHeight(building.ring) < 1.5;
  st.pans = savedPans ?? (st.project.lidarMissing ? [] : detectPans(dsm, dtm, building.ring));
  if ((st.project.version ?? 1) < 2) {
    // v1 : la gouttière était toujours le 1er côté dessiné -> on la redétecte (côtés parallèles)
    for (const pan of st.pans)
      if (pan.eaveHeight !== undefined) {
        pan.gutter = guessGutter(pan.ring);
        pan.manualAzimuth = azimuthFromEdge(pan.ring, pan.gutter, st.northOffset);
        rebuildVirtual(pan);
      }
    st.project.version = 2;
  }
  st.selectedPan = null;
  renderLidarNotice();
  if (!st.pans.length && !st.project.lidarMissing) status('Aucun pan détecté : dessinez-les avec « ＋ Pan ».', true);
  rebuildDsm();

  setBusy('Données d\'ensoleillement PVGIS…');
  const w = await weatherP;
  st.weather = w instanceof Error ? null : w;
  renderWeatherBox(w instanceof Error ? w : null);

  pushScene();
  drawRelief();
  ensureShadowOverlay();
  for (const id of ['s-roof', 's-trees', 's-panels', 's-elec', 's-res']) $(id).hidden = false;
  $('timebar').hidden = false;
  $('loc-hint').innerHTML = 'Maison sélectionnée. <a href="#" id="repick">Changer de maison</a>';
  $('repick').onclick = (ev) => {
    ev.preventDefault();
    startPick();
  };
  applyPhotoOffset();
  layers.pick.clearLayers();
  if (building.id !== 'dessin') L.polygon(building.ring.map((p) => ll(p[0], p[1])), { color: '#fff', weight: 1, dashArray: '4 4', fill: false, interactive: false }).addTo(layers.pick);
  const bounds = L.latLngBounds(building.ring.map((p) => ll(p[0], p[1])));
  map.fitBounds(bounds.pad(0.6), { maxZoom: 21 });
  renderTrees();
  relayout();
  setBusy(null);
  requestShadow();
  save();
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- Pente en degrés <-> pourcentage ----------
const degToPct = (d: number) => Math.tan((d * Math.PI) / 180) * 100;
const pctToDeg = (p: number) => (Math.atan(p / 100) * 180) / Math.PI;

/** Relie un champ « pente en ° » et un champ « pente en % » : chacun met l'autre à jour. */
function linkSlope(degId: string, pctId: string, onCommit: () => void): void {
  const d = $(degId) as HTMLInputElement;
  const p = $(pctId) as HTMLInputElement;
  const fromDeg = () => {
    if (d.value !== '') p.value = degToPct(Number(d.value)).toFixed(1);
  };
  const fromPct = () => {
    if (p.value !== '') d.value = pctToDeg(Number(p.value)).toFixed(2);
  };
  d.oninput = fromDeg;
  p.oninput = fromPct;
  d.onchange = () => {
    fromDeg();
    onCommit();
  };
  p.onchange = () => {
    fromPct();
    onCommit();
  };
}

// ---------- Dates des données ----------

const frDate = (iso: string) => new Date(iso + 'T12:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

function renderDates(li: { start: string; end: string; mission: string } | null, ortho: string | null): void {
  let el = document.getElementById('data-dates');
  if (!el) {
    el = document.createElement('div');
    el.id = 'data-dates';
    el.className = 'small';
    $('loc-hint').after(el);
  }
  const lidar = li ? (li.start === li.end ? frDate(li.start) : `${frDate(li.start)} → ${frDate(li.end)}`) : 'date inconnue';
  const years = li && ortho ? (Date.parse(ortho) - Date.parse(li.end)) / (365.25 * 86400e3) : 0;
  el.innerHTML = `📅 <b>LiDAR HD</b> (relief, arbres) : relevé le ${lidar}${li?.mission ? ` (mission ${li.mission})` : ''}<br>
    📷 <b>Photo aérienne</b> : prise le ${ortho ? frDate(ortho) : 'date inconnue'}
    ${years > 1 ? `<br><span class="warn">La photo a ${Math.round(years)} an(s) de plus que le LiDAR : ce qui a été construit, planté ou abattu entre-temps n'est pas dans le relief (voir « ＋ Volume », toit dessiné, clic droit sur un arbre).</span>` : ''}`;
}

// ---------- Calage photo / LiDAR ----------

let edgesOverlay: GridOverlay | null = null;

function applyPhotoOffset(): void {
  const o = st.project.photoOffset ?? { dx: 0, dy: 0 };
  const pane = map.getPane('photo')!;
  if (!o.dx && !o.dy) {
    pane.style.transform = '';
    return;
  }
  const [x, y] = st.dsm ? [st.dsm.x0 + (st.dsm.w * st.dsm.res) / 2, st.dsm.y0 - (st.dsm.h * st.dsm.res) / 2] : toL93(map.getCenter().lat, map.getCenter().lng);
  const p0 = map.latLngToLayerPoint(ll(x, y));
  const p1 = map.latLngToLayerPoint(ll(x + o.dx, y + o.dy));
  pane.style.transform = `translate(${p1.x - p0.x}px, ${p1.y - p0.y}px)`;
}
map.on('zoomend viewreset', applyPhotoOffset);

/** Masque des emprises de bâtiments (BD TOPO, +1 m) sur une fenêtre de la grille. */
function buildingMask(i0: number, j0: number, n: number): Uint8Array {
  const g = st.dsm!;
  const m = new Uint8Array(n * n);
  for (const b of st.buildings) {
    const xs = b.ring.map((p) => p[0]);
    const ys = b.ring.map((p) => p[1]);
    const a0 = Math.max(0, Math.floor((Math.min(...xs) - 1 - g.x0) / g.res) - i0);
    const a1 = Math.min(n - 1, Math.floor((Math.max(...xs) + 1 - g.x0) / g.res) - i0);
    const b0 = Math.max(0, Math.floor((g.y0 - Math.max(...ys) - 1) / g.res) - j0);
    const b1 = Math.min(n - 1, Math.floor((g.y0 - Math.min(...ys) + 1) / g.res) - j0);
    for (let j = b0; j <= b1; j++)
      for (let i = a0; i <= a1; i++) {
        const x = g.x0 + (i0 + i + 0.5) * g.res;
        const y = g.y0 - (j0 + j + 0.5) * g.res;
        if (pointInPolygon(x, y, b.ring) || distToRing(x, y, b.ring) < 1) m[j * n + i] = 1;
      }
  }
  return m;
}

function calageWindow(half: number) {
  const g = st.dsm!;
  const n = Math.min(g.w, Math.round((2 * half) / g.res));
  const i0 = Math.floor((g.w - n) / 2);
  const ndsm = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = (i0 + j) * g.w + i0 + i;
      ndsm[j * n + i] = st.dsmBase![k] - st.dtm!.data[k];
    }
  return { n, i0, j0: i0, ndsm, mask: buildingMask(i0, i0, n) };
}

function showEdges(on: boolean): void {
  if (edgesOverlay) {
    map.removeLayer(edgesOverlay);
    edgesOverlay = null;
  }
  if (!on || !st.dsm) return;
  const g = st.dsm;
  const w = calageWindow(SHADOW_HALF);
  const e = lidarEdges(w.ndsm, w.mask, w.n);
  edgesOverlay = new GridOverlay(g.x0 + w.i0 * g.res, g.y0 - w.j0 * g.res, w.n * g.res, w.n * g.res, w.n, w.n, 'edges');
  const ctx = edgesOverlay.canvas.getContext('2d')!;
  const img = ctx.createImageData(w.n, w.n);
  for (let k = 0; k < e.length; k++) {
    if (e[k] < 6) continue;
    img.data.set([255, 40, 200, Math.min(255, e[k] * 12)], k * 4);
  }
  ctx.putImageData(img, 0, 0);
  edgesOverlay.addTo(map);
}

function renderCalage(msg = ''): void {
  const o = st.project.photoOffset ?? { dx: 0, dy: 0 };
  $('cal-v').innerHTML = `Décalage de la photo : <b>${o.dx >= 0 ? 'est' : 'ouest'} ${fmt(Math.abs(o.dx), 2)} m</b>, <b>${o.dy >= 0 ? 'nord' : 'sud'} ${fmt(Math.abs(o.dy), 2)} m</b>${msg ? `<br>${msg}` : ''}`;
}

function nudge(dx: number, dy: number): void {
  const o = st.project.photoOffset ?? { dx: 0, dy: 0 };
  st.project.photoOffset = { dx: Math.round((o.dx + dx) * 100) / 100, dy: Math.round((o.dy + dy) * 100) / 100 };
  applyPhotoOffset();
  renderCalage();
  save();
}

async function autoCalage(): Promise<void> {
  if (!st.dsm) return;
  setBusy('Calage automatique photo / LiDAR…');
  try {
    const g = st.dsm;
    // fenêtre de plus en plus grande tant que le pic de corrélation n'est pas net
    // (lotissement récent : peu de bâtiments dans le LiDAR autour de la maison)
    let r = { dx: 0, dy: 0, confidence: 0 };
    for (const half of [50, 90, DATA_HALF - 5]) {
      const w = calageWindow(half);
      const photo = await fetchOrthoGray(g.x0 + w.i0 * g.res, g.y0 - w.j0 * g.res, w.n * g.res, w.n);
      const c = findOffset(photo, lidarEdges(w.ndsm, w.mask, w.n), w.n, g.res, 8);
      if (c.confidence > r.confidence) r = c;
      if (r.confidence >= 5) break;
    }
    if (r.confidence < 4) {
      renderCalage(`<span class="warn">Calage automatique peu fiable (trop peu de bâtiments LiDAR nets autour). Ajustez avec les flèches.</span>`);
      return;
    }
    st.project.photoOffset = { dx: Math.round(r.dx * 100) / 100, dy: Math.round(r.dy * 100) / 100 };
    applyPhotoOffset();
    renderCalage(`Calage automatique OK (confiance ${fmt(r.confidence, 1)}). Vérifiez que les contours roses tombent sur les bords des toits.`);
    save();
  } catch (e) {
    renderCalage(`<span class="warn">Erreur : ${(e as Error).message}</span>`);
  } finally {
    setBusy(null);
  }
}

$('btn-calage').onclick = () => {
  if (!st.dsm) {
    alert('Sélectionnez d\'abord votre maison.');
    return;
  }
  const box = $('calage');
  box.hidden = !box.hidden;
  $('btn-calage').classList.toggle('on', !box.hidden);
  showEdges(!box.hidden);
  renderCalage();
};
$('cal-close').onclick = () => $('btn-calage').click();
$('cal-auto').onclick = () => void autoCalage();
$('cal-reset').onclick = () => {
  st.project.photoOffset = { dx: 0, dy: 0 };
  applyPhotoOffset();
  renderCalage();
  save();
};
document.querySelectorAll<HTMLButtonElement>('#calage [data-n]').forEach((b) =>
  b.addEventListener('click', (e) => {
    const step = (e as MouseEvent).shiftKey ? 0.5 : 0.1;
    const [dx, dy] = b.dataset.n!.split(',').map(Number);
    nudge(dx * step, dy * step);
  }),
);

/** Recalcule le plan d'un pan dessiné : pente + azimut + hauteur de gouttière au-dessus du sol naturel. */
function rebuildVirtual(pan: RoofPan): void {
  if (pan.eaveHeight === undefined || !st.dtm) return;
  if (pan.ground === undefined) pan.ground = groundUnder(pan.ring, st.dtm);
  pan.plane = virtualPlane(pan.ring, pan.manualTilt ?? st.lastTilt, pan.manualAzimuth ?? 180, pan.eaveHeight, st.northOffset, st.dtm, pan.ground);
}

/** Hauteur médiane (MNS − MNT) dans une emprise : ~0 si la maison n'existait pas lors du survol LiDAR. */
function roofHeight(ring: XY[]): number {
  const g = st.dsm!;
  const vals: number[] = [];
  for (let j = 0; j < g.h; j++)
    for (let i = 0; i < g.w; i++) {
      const x = g.x0 + (i + 0.5) * g.res;
      const y = g.y0 - (j + 0.5) * g.res;
      if (pointInPolygon(x, y, ring)) vals.push(st.dsmBase![j * g.w + i] - st.dtm!.data[j * g.w + i]);
    }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

function renderLidarNotice(): void {
  let el = document.getElementById('lidar-notice');
  if (!st.project.lidarMissing) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'lidar-notice';
    el.className = 'weather-warn';
    $('pan-list').before(el);
  }
  el.innerHTML = `<b>Maison absente du LiDAR IGN</b> (survol antérieur à la construction). Le plus simple : <b>« 🏠 Toit auto »</b> (2 pans, 4 pans ou monopente), puis tracez le rectangle du toit : 2 coins d'un côté, un 3e clic pour la largeur. Sinon, dessinez chaque pan avec <b>« ＋ Pan »</b>. La <b>gouttière</b> (trait épais) est déduite des côtés parallèles, ou du 1er côté dessiné ; les panneaux s'alignent dessus. Réglez ensuite la pente et la hauteur de gouttière : le toit est ajouté au modèle 3D pour les ombres.
    Des voisins construits récemment ? Ajoutez-les avec <b>« ＋ Volume »</b>. Un arbre abattu depuis ? <b>Clic droit</b> sur son icône.`;
}

/**
 * MNS utilisé pour les ombres = MNS LiDAR + toits dessinés + volumes ajoutés − arbres abattus.
 */
function rebuildDsm(): void {
  const g = st.dsm;
  const base = st.dsmBase;
  const dtm = st.dtm?.data;
  if (!g || !base || !dtm) return;
  const d = base.slice();
  const removed = new Set(st.project.removedTrees);
  if (removed.size && st.treeLabel) {
    const ids = new Set(st.trees.filter((t) => removed.has(t.key)).map((t) => t.id));
    for (let k = 0; k < d.length; k++) if (ids.has(st.treeLabel[k])) d[k] = dtm[k];
  }
  const burn = (ring: XY[], z: (k: number, x: number, y: number) => number) => {
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - g.x0) / g.res));
    const i1 = Math.min(g.w - 1, Math.floor((Math.max(...xs) - g.x0) / g.res));
    const j0 = Math.max(0, Math.floor((g.y0 - Math.max(...ys)) / g.res));
    const j1 = Math.min(g.h - 1, Math.floor((g.y0 - Math.min(...ys)) / g.res));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = g.x0 + (i + 0.5) * g.res;
        const y = g.y0 - (j + 0.5) * g.res;
        if (!pointInPolygon(x, y, ring)) continue;
        const k = j * g.w + i;
        d[k] = Math.max(d[k], z(k, x, y));
      }
  };
  for (const v of st.project.volumes) burn(v.ring, (k) => dtm[k] + v.height);
  for (const pan of st.pans) if (pan.eaveHeight !== undefined) burn(pan.ring, (_k, x, y) => planeZ(pan.plane, x, y));
  g.data = d;
}

/** Après un changement du modèle 3D : workers, relief, ombres. */
function onSceneChanged(): void {
  rebuildDsm();
  pushScene();
  if (reliefOverlay && map.hasLayer(reliefOverlay)) drawRelief();
  requestShadow();
}

// ---------- Météo ----------

function renderWeatherBox(err: Error | null): void {
  const box = $('weather-box');
  if (st.weather) {
    const w = st.weather;
    const ghi = w.ghi.reduce((a, b) => a + b, 0) / 1000;
    box.innerHTML = `<p class="small">☀️ <b>${w.radiationDb}</b> ${w.years[0]}–${w.years[1]} (PVGIS 5.3), maille ${w.lat.toFixed(2)}° N / ${w.lon.toFixed(2)}° E · ${fmt(ghi)} kWh/m²/an à l'horizontale.</p>`;
    return;
  }
  const u = pvgisUrls(st.lat, st.lon);
  const k = roundedKey(st.lat, st.lon);
  box.innerHTML = `<div class="weather-warn">
    <b>Données PVGIS à charger.</b> PVGIS ne peut pas être interrogé directement depuis cette page${err instanceof NeedManualWeather ? '' : ` (${err?.message ?? ''})`}.
    <ol>
      <li>Ouvrez <a href="${u.tmy}" target="_blank" rel="noopener">l'année type PVGIS</a> et enregistrez la page (fichier .json).</li>
      <li>Facultatif : <a href="${u.horizon}" target="_blank" rel="noopener">le profil d'horizon</a>, enregistré de même.</li>
      <li>Importez le ou les fichiers : <input type="file" id="wx-file" accept=".json,application/json" multiple /></li>
    </ol>
    <span class="small">Ou lancez l'appli en local (<code>npm run dev</code>), ou <code>python3 tools/fetch_pvgis.py ${k.lat} ${k.lon}</code>.</span>
  </div>`;
  $('wx-file').addEventListener('change', async (ev) => {
    const files = Array.from((ev.target as HTMLInputElement).files ?? []);
    let tmy: any = null;
    let hor: any = null;
    for (const f of files) {
      const j = JSON.parse(await f.text());
      if (j.outputs?.tmy_hourly) tmy = j;
      else if (j.outputs?.horizon_profile) hor = j;
      else if (j.ghi) tmy = { compact: j };
    }
    if (!tmy) {
      alert('Fichier PVGIS "tmy" non reconnu.');
      return;
    }
    const compact = tmy.compact ?? compactFromRaw(tmy, hor);
    cacheWeather(k.file, compact);
    st.weather = parseCompact(compact);
    renderWeatherBox(null);
    pushScene();
    scheduleSim();
    requestShadow();
  });
}

// ======================================================================
// Relief (ombrage du MNS) et carte d'ombres
// ======================================================================

function drawRelief(): void {
  if (reliefOverlay) map.removeLayer(reliefOverlay);
  const g = st.dsm!;
  reliefOverlay = new GridOverlay(g.x0, g.y0, g.w * g.res, g.h * g.res, g.w, g.h, 'relief', 0.75);
  const ctx = reliefOverlay.canvas.getContext('2d')!;
  const img = ctx.createImageData(g.w, g.h);
  const az = 315 * (Math.PI / 180);
  const alt = 45 * (Math.PI / 180);
  for (let j = 1; j < g.h - 1; j++)
    for (let i = 1; i < g.w - 1; i++) {
      const k = j * g.w + i;
      const dzdx = (g.data[k + 1] - g.data[k - 1]) / (2 * g.res);
      const dzdy = (g.data[k - g.w] - g.data[k + g.w]) / (2 * g.res);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(-dzdx, -dzdy);
      const v = Math.cos(alt) * Math.cos(slope) + Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect);
      const c = Math.max(0, Math.min(255, 255 * v));
      img.data.set([c, c, c, 255], k * 4);
    }
  ctx.putImageData(img, 0, 0);
  if (($('ly-relief') as HTMLInputElement).checked) reliefOverlay.addTo(map);
}

function shadowWindow() {
  const g = st.dsm!;
  const n = Math.min(g.w, Math.round((2 * SHADOW_HALF) / g.res));
  const i0 = Math.floor((g.w - n) / 2);
  return { i0, j0: i0, w: n, h: n };
}

function ensureShadowOverlay(): void {
  if (shadowOverlay) map.removeLayer(shadowOverlay);
  const g = st.dsm!;
  const win = shadowWindow();
  shadowOverlay = new GridOverlay(g.x0 + win.i0 * g.res, g.y0 - win.j0 * g.res, win.w * g.res, win.h * g.res, win.w, win.h, 'shadow');
  if (($('ly-shadow') as HTMLInputElement).checked) shadowOverlay.addTo(map);
}

function currentTime() {
  const day = Number(($('day') as HTMLInputElement).value);
  const hour = Number(($('hour') as HTMLInputElement).value);
  const ms = localToUtc(day, hour);
  return { day, hour, ms, month: monthOfDay(day), sun: sunPosition(ms, st.lat, st.lon) };
}

function updateTimeLabels(): void {
  const t = currentTime();
  $('day-v').textContent = dayLabel(t.day);
  const hh = Math.floor(t.hour);
  const mm = Math.round((t.hour - hh) * 60);
  $('hour-v').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const s = t.sun;
  const hz = st.weather ? horizonAtUi(s.azimuth) : 0;
  $('sun-v').textContent =
    s.elevation <= 0
      ? '🌙 Soleil couché'
      : s.elevation < hz
        ? `⛰️ Soleil caché par le relief (azimut ${fmt(s.azimuth)}° ${compass(s.azimuth)}, hauteur ${fmt(s.elevation, 1)}° < horizon ${fmt(hz, 1)}°)`
        : `☀️ Soleil : azimut ${fmt(s.azimuth)}° (${compass(s.azimuth)}), hauteur ${fmt(s.elevation, 1)}°`;
}

function horizonAtUi(az: number): number {
  const h = st.weather!.horizon;
  const a = ((az % 360) + 360) % 360;
  const i = Math.floor(a);
  return h[i] + (h[(i + 1) % 360] - h[i]) * (a - i);
}

function requestShadow(): void {
  updateTimeLabels();
  if (!st.dsm || !shadowOverlay) return;
  if (shadowBusy) {
    shadowPending = true;
    return;
  }
  const t = currentTime();
  const win = shadowWindow();
  shadowBusy = true;
  post(shadowWorker, { type: 'shadow', reqId: ++shadowReq, az: t.sun.azimuth, el: t.sun.elevation, month: t.month, ...win });
}

function drawShadow(data: Float32Array): void {
  if (!shadowOverlay) return;
  const c = shadowOverlay.canvas;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(c.width, c.height);
  for (let k = 0; k < data.length; k++) {
    const a = (1 - data[k]) * 150;
    if (a <= 0) continue;
    img.data[k * 4] = 10;
    img.data[k * 4 + 1] = 14;
    img.data[k * 4 + 2] = 40;
    img.data[k * 4 + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
}

for (const id of ['day', 'hour']) $(id).addEventListener('input', requestShadow);
document.querySelectorAll<HTMLButtonElement>('#timebar .presets button').forEach((b) =>
  b.addEventListener('click', () => {
    ($('day') as HTMLInputElement).value = b.dataset.day!;
    requestShadow();
  }),
);
let playTimer = 0;
$('play').addEventListener('click', () => {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = 0;
    $('play').textContent = '▶';
    return;
  }
  $('play').textContent = '⏸';
  playTimer = window.setInterval(() => {
    const h = $('hour') as HTMLInputElement;
    let v = Number(h.value) + 0.25;
    if (v > Number(h.max)) v = Number(h.min);
    h.value = String(v);
    requestShadow();
  }, 150);
});
{
  // date du jour par défaut, midi
  const now = new Date();
  const doy = Math.min(365, Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(now.getFullYear(), 0, 0)) / 86400e3));
  ($('day') as HTMLInputElement).value = String(doy);
  updateTimeLabels();
}

// ======================================================================
// 2. Pans de toit
// ======================================================================

function panColor(pan: RoofPan): string {
  return PAN_COLORS[Math.max(0, st.pans.indexOf(pan)) % PAN_COLORS.length];
}

function panInfo(pan: RoofPan) {
  const tilt = planeTilt(pan.plane);
  const az = Math.round(planeAzimuth(pan.plane, st.northOffset) * 10) / 10 % 360;
  return { tilt, az, area: panArea(pan), label: tilt < 3 ? 'plat' : `${compass(az)} ${fmt(az)}°` };
}

function renderPans(): void {
  layers.pans.clearLayers();
  if (!($('ly-pans') as HTMLInputElement).checked) return;
  for (const pan of st.pans) {
    const sel = pan.id === st.selectedPan;
    const col = panColor(pan);
    const poly = L.polygon(
      pan.ring.map((p) => ll(p[0], p[1])),
      { color: col, weight: sel ? 3 : 2, fillColor: col, fillOpacity: pan.enabled ? 0.12 : 0.03, dashArray: pan.enabled ? undefined : '5 5', bubblingMouseEvents: false },
    ).addTo(layers.pans);
    const info = panInfo(pan);
    poly.bindTooltip(`<b>${pan.name}</b><br>${info.label}, pente ${fmt(info.tilt)}°<br>${fmt(info.area, 1)} m²`, { sticky: true });
    const ge = gutterEdge(pan);
    if (ge !== null) {
      const a = pan.ring[ge];
      const b = pan.ring[(ge + 1) % pan.ring.length];
      L.polyline([ll(a[0], a[1]), ll(b[0], b[1])], { color: col, weight: sel ? 7 : 5, opacity: 0.9, interactive: false }).addTo(layers.pans);
    }
    poly.on('click', (e) => {
      if (st.mode === 'addpan' || st.mode === 'addobs' || st.mode === 'addvol' || st.mode === 'addroof') {
        map.fire('click', e);
        return;
      }
      selectPan(pan.id);
    });
    for (const o of pan.obstacles) {
      const r = L.polygon(o.map((p) => ll(p[0], p[1])), { color: '#ff3b30', weight: 1.5, dashArray: '3 3', fillOpacity: 0.15, bubblingMouseEvents: false }).addTo(layers.pans);
      r.bindTooltip(st.mode === 'none' ? 'Obstacle' : 'Obstacle : cliquer pour le supprimer');
      r.on('click', () => {
        if (st.mode === 'none') return;
        pan.obstacles = pan.obstacles.filter((q) => q !== o);
        onPansChanged();
      });
    }
  }
  st.project.volumes.forEach((v) => {
    const r = L.polygon(v.ring.map((p) => ll(p[0], p[1])), { color: '#888', weight: 1.5, fillColor: '#888', fillOpacity: 0.35, bubblingMouseEvents: false }).addTo(layers.pans);
    r.bindTooltip(`Volume ajouté : ${fmt(v.height, 1)} m${st.mode === 'none' ? '' : ' (cliquer pour supprimer)'}`);
    r.on('click', () => {
      if (st.mode === 'none') return;
      if (!confirm('Supprimer ce volume ?')) return;
      st.project.volumes = st.project.volumes.filter((q) => q !== v);
      onSceneChanged();
      renderPans();
      scheduleSim();
      save();
    });
  });
  renderPanList();
  renderVertexHandles();
}

function renderPanList(): void {
  const el = $('pan-list');
  el.innerHTML = '';
  const counts = new Map<string, number>();
  for (const p of st.panels) if (p.enabled) counts.set(p.panId, (counts.get(p.panId) ?? 0) + 1);
  for (const pan of st.pans) {
    const info = panInfo(pan);
    const div = document.createElement('div');
    div.className = `pan-item${pan.id === st.selectedPan ? ' sel' : ''}${pan.enabled ? '' : ' off'}`;
    div.innerHTML = `<span class="sw" style="background:${panColor(pan)}"></span>
      <span><b>${pan.name}</b> · ${info.label} · ${fmt(info.tilt)}° (${fmt(degToPct(info.tilt))} %) · ${fmt(info.area)} m²</span>
      <span class="small">${pan.enabled ? `${counts.get(pan.id) ?? 0} pann.` : 'exclu'}</span>`;
    div.onclick = () => selectPan(pan.id);
    el.appendChild(div);
  }
  renderPanDetail();
}

let renderingDetail = false;
function renderPanDetail(): void {
  // Remplacer le contenu pendant qu'un de ses champs a le focus déclenche blur/change
  // en cascade : on retire le focus d'abord et on évite la ré-entrée.
  if (renderingDetail) return;
  renderingDetail = true;
  try {
    const active = document.activeElement as HTMLElement | null;
    if (active && $('pan-detail').contains(active)) active.blur();
    renderPanDetailInner();
  } finally {
    renderingDetail = false;
  }
}

function renderPanDetailInner(): void {
  const el = $('pan-detail');
  const pan = st.pans.find((p) => p.id === st.selectedPan);
  if (!pan) {
    el.innerHTML = '';
    return;
  }
  const info = panInfo(pan);
  const virt = pan.eaveHeight !== undefined;
  el.innerHTML = `<div class="box">
    <div class="grid2">
      <label class="field">Nom<input id="pd-name" value="${pan.name.replace(/"/g, '&quot;')}" /></label>
      <label class="field">Utiliser ce pan<select id="pd-en"><option value="1">Oui</option><option value="0"${pan.enabled ? '' : ' selected'}>Non</option></select></label>
      <label class="field">Pente (°)<input id="pd-tilt" type="number" min="0" max="70" step="0.5" value="${info.tilt.toFixed(1)}" /></label>
      <label class="field">Pente (%)<input id="pd-tiltpct" type="number" min="0" max="275" step="1" value="${degToPct(info.tilt).toFixed(1)}" /></label>
      <label class="field">Azimut (° depuis le nord)<input id="pd-az" type="number" min="0" max="359" step="1" value="${info.az.toFixed(0)}" /></label>
      ${virt ? `<label class="field">Hauteur de gouttière (m)<input id="pd-eave" type="number" min="0" max="30" step="0.1" value="${pan.eaveHeight!.toFixed(2)}" /></label>
      <label class="field">Hauteur de faîtage (m)<input id="pd-ridge" type="number" min="0" max="40" step="0.1" value="${(pan.eaveHeight! + panRun(pan.ring, pan.gutter ?? 0) * Math.tan((info.tilt * Math.PI) / 180)).toFixed(2)}" /></label>
      <label class="field">Sol naturel (m NGF)<input id="pd-ground" type="number" step="0.1" value="${(pan.ground ?? 0).toFixed(2)}" /></label>` : ''}
    </div>
    ${virt ? `<div class="small">Hauteurs mesurées depuis le sol naturel : terrain LiDAR IGN relevé avant les travaux. Pente et faîtage sont liés (largeur gouttière → faîtage : ${fmt(panRun(pan.ring, pan.gutter ?? 0), 2)} m).${pan.group ? ' <b>Pente, hauteurs et sol s\'appliquent à tous les pans de ce toit.</b>' : ''}</div>` : ''}
    <div class="small">${virt ? 'Pan dessiné (absent du LiDAR) : pente, azimut et hauteur saisis.' : pan.manualTilt !== undefined || pan.manualAzimuth !== undefined ? 'Pente/azimut saisis à la main.' : 'Pente et azimut mesurés sur le LiDAR.'}
      ${pan.obstacles.length} obstacle(s).</div>
    <div class="row wrap">
      ${virt ? '<button id="pd-gutter" title="La gouttière (trait épais) fixe le sens de la pente et l\'alignement des panneaux">↻ Changer de gouttière</button>' : '<button id="pd-refit">↻ Recalculer depuis le LiDAR</button><button id="pd-obs">↻ Obstacles</button>'}
      <button id="pd-del">🗑 Supprimer</button>
    </div></div>`;
  $('pd-name').onchange = (e) => {
    pan.name = (e.target as HTMLInputElement).value || pan.name;
    onPansChanged(false);
  };
  $('pd-en').onchange = (e) => {
    pan.enabled = (e.target as HTMLSelectElement).value === '1';
    onPansChanged();
  };
  const manual = () => {
    const tilt = Number(($('pd-tilt') as HTMLInputElement).value);
    const az = Number(($('pd-az') as HTMLInputElement).value);
    const [cx, cy] = ringCentroid(pan.ring);
    pan.manualTilt = tilt;
    pan.manualAzimuth = az;
    if (virt) {
      pan.gutter = edgeForAzimuth(pan.ring, az, st.northOffset);
      const eave = Number(($('pd-eave') as HTMLInputElement).value);
      const ground = Number(($('pd-ground') as HTMLInputElement).value);
      st.lastTilt = tilt;
      st.lastEave = eave;
      const roof = pan.group ? st.pans.filter((q) => q.group === pan.group) : [pan];
      for (const q of roof) {
        q.manualTilt = tilt;
        q.eaveHeight = eave;
        q.ground = ground;
        rebuildVirtual(q);
      }
    } else pan.plane = planeFrom(tilt, az, st.northOffset, cx, cy, planeZ(pan.plane, cx, cy));
    onPansChanged();
  };
  linkSlope('pd-tilt', 'pd-tiltpct', manual);
  $('pd-az').onchange = manual;
  if (virt) {
    $('pd-eave').onchange = manual;
    $('pd-ground').onchange = manual;
    // faîtage saisi -> pente recalculée
    $('pd-ridge').onchange = () => {
      const eave = Number(($('pd-eave') as HTMLInputElement).value);
      const ridge = Number(($('pd-ridge') as HTMLInputElement).value);
      const run = panRun(pan.ring, pan.gutter ?? 0);
      if (ridge <= eave || run <= 0) {
        alert('Le faîtage doit être plus haut que la gouttière.');
        return;
      }
      ($('pd-tilt') as HTMLInputElement).value = ((Math.atan((ridge - eave) / run) * 180) / Math.PI).toFixed(2);
      ($('pd-tiltpct') as HTMLInputElement).value = (((ridge - eave) / run) * 100).toFixed(1);
      manual();
    };
  }
  if (virt)
    $('pd-gutter').onclick = () => {
      pan.gutter = ((pan.gutter ?? 0) + 1) % pan.ring.length;
      pan.manualAzimuth = azimuthFromEdge(pan.ring, pan.gutter, st.northOffset);
      rebuildVirtual(pan);
      onPansChanged();
    };
  if (!virt) $('pd-refit').onclick = () => {
    const p = planeFromDsm(st.dsm!, pan.ring);
    if (p) pan.plane = p;
    delete pan.manualTilt;
    delete pan.manualAzimuth;
    onPansChanged();
  };
  if (!virt) $('pd-obs').onclick = () => {
    pan.obstacles = detectObstacles(st.dsm!, pan);
    onPansChanged();
  };
  $('pd-del').onclick = () => {
    if (!confirm(`Supprimer ${pan.name} ?`)) return;
    st.pans = st.pans.filter((p) => p !== pan);
    st.selectedPan = null;
    onPansChanged();
  };
}

function selectPan(id: string | null): void {
  st.selectedPan = id;
  renderPans();
}

function onPansChanged(relayoutNeeded = true): void {
  st.project.pans = st.pans;
  if (st.pans.some((p) => p.eaveHeight !== undefined) || st.project.lidarMissing) onSceneChanged();
  if (relayoutNeeded) relayout();
  else renderPans();
  save();
}

// ---------- Édition des sommets ----------

function setMode(m: typeof st.mode): void {
  st.mode = st.mode === m ? 'none' : m;
  cancelAnimationFrame(previewFrame);
  clearPreview();
  st.draft = [];
  $('btn-edit').classList.toggle('on', st.mode === 'vertices');
  $('btn-addpan').classList.toggle('on', st.mode === 'addpan');
  $('btn-addobs').classList.toggle('on', st.mode === 'addobs');
  $('btn-addvol').classList.toggle('on', st.mode === 'addvol');
  $('btn-addroof').classList.toggle('on', st.mode === 'addroof');
  const hint = $('edit-hint');
  hint.hidden = st.mode === 'none';
  hint.innerHTML =
    st.mode === 'vertices'
      ? 'Sélectionnez un pan, puis <b>glissez ses sommets</b>. Point gris = ajouter un sommet. <b>Clic droit</b> sur un sommet = le supprimer. Les sommets s\'aimantent à ceux des pans voisins. Cliquez un obstacle rouge pour le supprimer.'
      : st.mode === 'addpan'
        ? rectMode()
          ? 'Rectangle : cliquez <b>2 coins d\'un côté</b> (de préférence la gouttière), puis <b>un 3e clic pour la largeur</b>. Angles droits garantis.'
          : `Cliquez les coins du pan sur la carte${st.project.lidarMissing ? ' (de préférence en commençant par les 2 coins de la gouttière)' : ''}. <b>Cliquez sur le premier point</b> pour fermer. <b>Maj</b> : côté parallèle ou perpendiculaire au précédent. Échap pour annuler.`
        : st.mode === 'addroof'
        ? `<b>Toit automatique</b> : réglez puis ${rectMode() ? 'tracez le rectangle du toit (débords compris) : <b>2 coins d\'un côté</b>, puis <b>un 3e clic pour la largeur</b>' : 'cliquez les <b>4 coins du toit</b> (débords compris)'}.
           <span class="grid2" style="margin-top:6px">
             <label class="field">Type<select id="rg-kind">
               <option value="quatre">4 pans (croupes)</option>
               <option value="deux-long">2 pans, faîtage sur la longueur</option>
               <option value="deux-court">2 pans, faîtage sur la largeur</option>
               <option value="mono">1 pan (monopente vers le sud)</option></select></label>
             <label class="field">Pente (°)<input id="rg-tilt" type="number" min="0" max="60" step="0.5" value="${st.roofGen.tilt}" /></label>
             <label class="field">Pente (%)<input id="rg-tiltpct" type="number" min="0" max="175" step="1" value="${degToPct(st.roofGen.tilt).toFixed(1)}" /></label>
             <label class="field">Gouttière / sol naturel (m)<input id="rg-eave" type="number" min="0" max="30" step="0.1" value="${st.roofGen.eave}" /></label>
           </span>`
        : st.mode === 'addvol'
        ? `Volume (maison voisine récente, mur, abri…) : ${rectMode() ? '2 coins d\'un côté puis la largeur' : 'cliquez ses coins, fermez sur le premier point'}, puis indiquez sa hauteur.`
        : st.mode === 'addobs'
          ? 'Sélectionnez le pan, puis cliquez <b>2 coins opposés</b> de l\'obstacle (cheminée, velux…).'
          : '';
  map.getContainer().style.cursor = st.mode === 'addpan' || st.mode === 'addobs' || st.mode === 'addvol' || st.mode === 'addroof' ? 'crosshair' : '';
  if (st.mode === 'addroof') {
    ($('rg-kind') as HTMLSelectElement).value = st.roofGen.kind;
    const upd = () => {
      st.roofGen = {
        kind: ($('rg-kind') as HTMLSelectElement).value as RoofKind,
        tilt: Number(($('rg-tilt') as HTMLInputElement).value),
        eave: Number(($('rg-eave') as HTMLInputElement).value),
      };
    };
    for (const id of ['rg-kind', 'rg-eave']) $(id).onchange = upd;
    linkSlope('rg-tilt', 'rg-tiltpct', upd);
  }
  if (st.mode === 'vertices' && !st.selectedPan && st.pans[0]) st.selectedPan = st.pans[0].id;
  renderPans();
  renderDraft();
}

$('btn-edit').onclick = () => setMode('vertices');
$('btn-addpan').onclick = () => setMode('addpan');
$('btn-addvol').onclick = () => setMode('addvol');
$('btn-addroof').onclick = () => setMode('addroof');
{
  const sel = $('draw-shape') as HTMLSelectElement;
  sel.value = st.project.drawShape ?? 'rect';
  sel.onchange = () => {
    st.project.drawShape = sel.value as 'rect' | 'free';
    save();
    if (isDrawMode()) {
      const m = st.mode;
      setMode(m); // quitte
      setMode(m); // et revient avec la bonne consigne
    }
  };
}
$('btn-addobs').onclick = () => {
  if (!st.selectedPan && st.pans[0]) st.selectedPan = st.pans[0].id;
  setMode('addobs');
};
$('btn-redetect').onclick = () => {
  if (!st.dsm || !st.dtm || !st.project.building) return;
  if (!confirm('Remplacer les pans actuels par une nouvelle détection automatique ?')) return;
  st.pans = detectPans(st.dsm, st.dtm, st.project.building.ring);
  st.selectedPan = null;
  onPansChanged();
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && st.mode !== 'none') setMode(st.mode);
});

function snap(p: XY, self: RoofPan, idx: number): XY {
  let best: XY = p;
  let bd = 0.4;
  for (const pan of st.pans)
    pan.ring.forEach((q, k) => {
      if (pan === self && k === idx) return;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) {
        bd = d;
        best = [q[0], q[1]];
      }
    });
  return best;
}

function renderVertexHandles(): void {
  layers.edit.clearLayers();
  if (st.mode !== 'vertices') return;
  const pan = st.pans.find((p) => p.id === st.selectedPan);
  if (!pan) return;
  const n = pan.ring.length;
  pan.ring.forEach((pt, k) => {
    const m = L.marker(ll(pt[0], pt[1]), { draggable: true, icon: L.divIcon({ className: 'vertex', iconSize: undefined }), zIndexOffset: 1000 }).addTo(layers.edit);
    m.on('drag', () => {
      const c = m.getLatLng();
      pan.ring[k] = toL93(c.lat, c.lng);
      livePolygon(pan);
    });
    m.on('dragend', () => {
      pan.ring[k] = snap(pan.ring[k], pan, k);
      refitPan(pan);
      onPansChanged();
    });
    m.on('contextmenu', (e) => {
      e.originalEvent.preventDefault();
      if (pan.ring.length <= 3) return;
      pan.ring.splice(k, 1);
      refitPan(pan);
      onPansChanged();
    });
  });
  for (let k = 0; k < n; k++) {
    const a = pan.ring[k];
    const b = pan.ring[(k + 1) % n];
    const mid = L.marker(ll((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), { icon: L.divIcon({ className: 'vertex mid', iconSize: undefined }), draggable: true }).addTo(layers.edit);
    let inserted = false;
    const insert = () => {
      if (inserted) return;
      inserted = true;
      pan.ring.splice(k + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    };
    mid.on('dragstart', insert);
    mid.on('drag', () => {
      const c = mid.getLatLng();
      pan.ring[k + 1] = toL93(c.lat, c.lng);
      livePolygon(pan);
    });
    mid.on('dragend', () => {
      pan.ring[k + 1] = snap(pan.ring[k + 1], pan, k + 1);
      refitPan(pan);
      onPansChanged();
    });
    mid.on('click', () => {
      insert();
      onPansChanged();
    });
  }
}

let livePoly: L.Polygon | null = null;
function livePolygon(pan: RoofPan): void {
  if (livePoly) livePoly.remove();
  livePoly = L.polygon(pan.ring.map((p) => ll(p[0], p[1])), { color: '#fff', weight: 2, dashArray: '4 3', fill: false, interactive: false }).addTo(layers.edit);
}

function refitPan(pan: RoofPan): void {
  if (pan.eaveHeight !== undefined) {
    // la gouttière suit le côté le plus proche de l'ancienne orientation, et la pente lui reste perpendiculaire
    pan.gutter = edgeForAzimuth(pan.ring, pan.manualAzimuth ?? 180, st.northOffset);
    pan.manualAzimuth = azimuthFromEdge(pan.ring, pan.gutter, st.northOffset);
    rebuildVirtual(pan);
    return;
  }
  if (pan.manualTilt !== undefined) return;
  const p = planeFromDsm(st.dsm!, pan.ring);
  if (p) pan.plane = p;
}

// ---------- Nouveau pan / obstacle ----------

// ---------- Aperçu en direct du tracé ----------
const previewLayer = L.layerGroup().addTo(map);
let previewFrame = 0;
function clearPreview(): void {
  previewLayer.clearLayers();
}
const mFmt = (v: number) => `${fmt(v, 2)} m`;
map.on('mousemove', (e: L.LeafletMouseEvent) => {
  if (!isDrawMode() || !st.draft.length) return;
  cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(() => {
    clearPreview();
    // le tracé a pu se terminer entre le mouvement et l'affichage
    if (!isDrawMode() || !st.draft.length) return;
    let m = toL93(e.latlng.lat, e.latlng.lng);
    const d = st.draft;
    const style = { color: '#ffd400', weight: 2, dashArray: '6 4', interactive: false, fillOpacity: 0.15 };
    let label = '';
    if (rectMode() && d.length === 2) {
      const r = rectFrom3(d[0], d[1], m);
      L.polygon(r.map((q) => ll(q[0], q[1])), style).addTo(previewLayer);
      label = `${mFmt(Math.hypot(d[1][0] - d[0][0], d[1][1] - d[0][1]))} × ${mFmt(Math.hypot(r[2][0] - r[1][0], r[2][1] - r[1][1]))}`;
    } else {
      if (!rectMode() && e.originalEvent.shiftKey && d.length >= 2) m = orthoSnap(d[d.length - 2], d[d.length - 1], m);
      const last = d[d.length - 1];
      L.polyline([ll(last[0], last[1]), ll(m[0], m[1])], style).addTo(previewLayer);
      label = mFmt(Math.hypot(m[0] - last[0], m[1] - last[1]));
    }
    L.marker(ll(m[0], m[1]), { icon: L.divIcon({ className: 'dim-label', html: `<div>${label}</div>`, iconSize: [0, 0] }), interactive: false }).addTo(previewLayer);
  });
});

function renderDraft(): void {
  if (!st.draft.length) clearPreview();
  if (livePoly) {
    livePoly.remove();
    livePoly = null;
  }
  if ((st.mode !== 'addpan' && st.mode !== 'addvol' && st.mode !== 'addroof') || !st.draft.length) {
    if (st.mode !== 'vertices') layers.edit.clearLayers();
    return;
  }
  layers.edit.clearLayers();
  L.polyline(st.draft.map((p) => ll(p[0], p[1])), { color: '#fff', weight: 2, dashArray: '4 3', interactive: false }).addTo(layers.edit);
  st.draft.forEach((p, k) => {
    const m = L.marker(ll(p[0], p[1]), { icon: L.divIcon({ className: 'vertex', iconSize: undefined }) }).addTo(layers.edit);
    if (k === 0) m.on('click', () => closeDraft());
  });
}

const isDrawMode = () => st.mode === 'addpan' || st.mode === 'addvol' || st.mode === 'addroof';
const rectMode = () => (st.project.drawShape ?? 'rect') === 'rect';

function addDraftPoint(p: XY, shift = false): void {
  clearPreview();
  if (rectMode()) {
    // Rectangle : 2 clics pour un côté, le 3e pour la largeur (angles droits garantis)
    st.draft.push(st.draft.length < 2 ? snap(p, null as unknown as RoofPan, -1) : p);
    if (st.draft.length < 3) {
      renderDraft();
      return;
    }
    const rect = rectFrom3(st.draft[0], st.draft[1], st.draft[2]);
    if (st.mode === 'addroof') generateHouseRoof(rect);
    else {
      st.draft = rect;
      closeDraft();
    }
    return;
  }
  if (shift && st.draft.length >= 2) p = orthoSnap(st.draft[st.draft.length - 2], st.draft[st.draft.length - 1], p);
  if (st.mode === 'addroof') {
    st.draft.push(p);
    if (st.draft.length === 4) generateHouseRoof(st.draft.slice());
    else renderDraft();
    return;
  }
  if (st.draft.length >= 3 && Math.hypot(p[0] - st.draft[0][0], p[1] - st.draft[0][1]) < 0.5) {
    closeDraft();
    return;
  }
  st.draft.push(snap(p, null as unknown as RoofPan, -1));
  renderDraft();
}

/** Toit généré à partir des 4 coins : 2 pans, 4 pans ou monopente. */
function generateHouseRoof(corners: XY[]): void {
  const g = st.roofGen;
  const group = `toit${Date.now().toString(36)}`;
  const ground = groundUnder(corners, st.dtm!);
  const parts = generateRoof(corners, g.kind);
  for (const part of parts) {
    let n = st.pans.length + 1;
    while (st.pans.some((p) => p.id === `pan${n}`)) n++;
    const gutter = g.kind === 'mono' ? edgeForAzimuth(part.ring, 180, st.northOffset) : part.gutter;
    const pan: RoofPan = {
      id: `pan${n}`,
      name: `Pan ${n}`,
      ring: part.ring,
      plane: { a: 0, b: 0, c: 0 },
      obstacles: [],
      enabled: true,
      eaveHeight: g.eave,
      manualTilt: g.tilt,
      gutter,
      manualAzimuth: azimuthFromEdge(part.ring, gutter, st.northOffset),
      ground,
      group,
    };
    rebuildVirtual(pan);
    pan.name = `Pan ${n} (${compass(pan.manualAzimuth!)})`;
    st.pans.push(pan);
  }
  st.selectedPan = st.pans[st.pans.length - parts.length]?.id ?? null;
  st.draft = [];
  setMode('addroof'); // sort du mode
  onPansChanged();
}

function closeDraft(): void {
  if (st.draft.length < 3) return;
  const ring = st.draft.slice();
  if (st.mode === 'addvol') {
    const h = Number(prompt('Hauteur de ce volume au-dessus du sol (m) ?', '6')?.replace(',', '.'));
    if (h > 0) {
      st.project.volumes.push({ ring, height: h });
      onSceneChanged();
      scheduleSim();
      save();
    }
    st.draft = [];
    renderDraft();
    renderPans();
    return;
  }
  const [cx, cy] = ringCentroid(ring);
  let n = st.pans.length + 1;
  while (st.pans.some((p) => p.id === `pan${n}`)) n++;
  const pan: RoofPan = { id: `pan${n}`, name: `Pan ${n}`, ring, plane: { a: 0, b: 0, c: 0 }, obstacles: [], enabled: true };
  if (st.project.lidarMissing || roofHeight(ring) < 1.5) {
    // Toit absent du LiDAR : la gouttière est le 1er côté dessiné
    pan.eaveHeight = st.lastEave;
    pan.manualTilt = st.lastTilt;
    pan.gutter = guessGutter(ring);
    pan.manualAzimuth = azimuthFromEdge(ring, pan.gutter, st.northOffset);
    rebuildVirtual(pan);
  } else {
    pan.plane = planeFromDsm(st.dsm!, ring) ?? planeFrom(30, 180, st.northOffset, cx, cy, st.dsm!.data[0]);
    pan.obstacles = detectObstacles(st.dsm!, pan);
  }
  st.pans.push(pan);
  st.selectedPan = pan.id;
  st.draft = []; // on reste en mode dessin pour enchaîner les pans
  onPansChanged();
  renderDraft();
}

let obsFirst: XY | null = null;
function addObstaclePoint(p: XY): void {
  const pan = st.pans.find((q) => q.id === st.selectedPan);
  if (!pan) return;
  if (!obsFirst) {
    obsFirst = p;
    layers.edit.clearLayers();
    L.marker(ll(p[0], p[1]), { icon: L.divIcon({ className: 'vertex', iconSize: undefined }) }).addTo(layers.edit);
    return;
  }
  // rectangle aligné sur le pan
  const f = panFrame(pan, st.northOffset);
  const a = toPlane(f, obsFirst[0], obsFirst[1]);
  const b = toPlane(f, p[0], p[1]);
  const ring: XY[] = [fromPlane(f, a[0], a[1]), fromPlane(f, b[0], a[1]), fromPlane(f, b[0], b[1]), fromPlane(f, a[0], b[1])];
  pan.obstacles.push(ring);
  obsFirst = null;
  layers.edit.clearLayers();
  onPansChanged();
}

// ======================================================================
// 3. Arbres
// ======================================================================

const isRemoved = (t: Tree) => st.project.removedTrees.includes(t.key);
const treeIcon = (t: Tree) =>
  L.divIcon({
    className: `tree-icon${isRemoved(t) ? ' removed' : ''}`,
    html: `<img src="./${t.deciduous ? 'tree-deciduous' : 'tree-evergreen'}.svg" alt="">`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

function renderTrees(): void {
  layers.trees.clearLayers();
  if (!st.project.building || !($('ly-trees') as HTMLInputElement).checked) return;
  const [cx, cy] = ringCentroid(st.project.building.ring);
  const shown = st.trees.filter((t) => Math.hypot(t.x - cx, t.y - cy) < TREE_RADIUS && t.height >= 4);
  for (const t of shown) {
    const m = L.marker(ll(t.x, t.y), { icon: treeIcon(t), zIndexOffset: -100 }).addTo(layers.trees);
    const tip = () =>
      isRemoved(t)
        ? `Arbre ~${fmt(t.height)} m <b>abattu</b> (ignoré).<br>Clic droit pour le remettre.`
        : `Arbre ~${fmt(t.height)} m, couronne Ø ${fmt(2 * t.crownRadius)} m<br><b>${t.deciduous ? 'Caduc' : 'Persistant'}</b> (clic pour changer)<br>Clic droit : arbre abattu depuis le survol`;
    m.on('contextmenu', (e) => {
      e.originalEvent.preventDefault();
      const set = new Set(st.project.removedTrees);
      if (set.has(t.key)) set.delete(t.key);
      else set.add(t.key);
      st.project.removedTrees = [...set];
      m.setIcon(treeIcon(t));
      m.setTooltipContent(tip());
      onSceneChanged();
      scheduleSim();
      save();
    });
    m.bindTooltip(tip());
    m.on('click', () => {
      t.deciduous = !t.deciduous;
      m.setIcon(treeIcon(t));
      m.setTooltipContent(tip());
      onTreesChanged();
    });
  }
  const dec = st.trees.filter((t) => t.deciduous).length;
  $('tree-summary').textContent = `${shown.length} arbres autour de la maison (${st.trees.length} dans la zone de calcul de ${2 * DATA_HALF} m), dont ${dec} caduc(s).`;
}

function onTreesChanged(): void {
  st.project.deciduousTrees = st.trees.filter((t) => t.deciduous).map((t) => t.key);
  pushTrees();
  requestShadow();
  scheduleSim();
  save();
  const dec = st.trees.filter((t) => t.deciduous).length;
  $('tree-summary').textContent = $('tree-summary').textContent!.replace(/dont \d+ caduc/, `dont ${dec} caduc`);
}

{
  const box = $('leafless');
  MONTHS_FR.forEach((m, i) => {
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox" ${st.project.leafless[i] ? 'checked' : ''}/> ${m.slice(0, 4)}`;
    lab.querySelector('input')!.onchange = (e) => {
      st.project.leafless[i] = (e.target as HTMLInputElement).checked;
      onTreesChanged();
    };
    box.appendChild(lab);
  });
  const tr = $('leaf-trans') as HTMLInputElement;
  tr.value = String(Math.round(st.project.leaflessTransmission * 100));
  $('leaf-trans-v').textContent = `${tr.value} %`;
  tr.oninput = () => ($('leaf-trans-v').textContent = `${tr.value} %`);
  tr.onchange = () => {
    st.project.leaflessTransmission = Number(tr.value) / 100;
    onTreesChanged();
  };
  const all = (v: boolean) => {
    if (!st.project.building) return;
    const [cx, cy] = ringCentroid(st.project.building.ring);
    for (const t of st.trees) if (Math.hypot(t.x - cx, t.y - cy) < TREE_RADIUS) t.deciduous = v;
    renderTrees();
    onTreesChanged();
  };
  $('tree-all-p').onclick = () => all(false);
  $('tree-all-c').onclick = () => all(true);
}

// ======================================================================
// 4. Panneaux et calepinage
// ======================================================================

{
  const sel = $('panel-model') as HTMLSelectElement;
  for (const p of PANELS) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.id === 'custom' ? 'Personnalisé…' : `${p.brand} ${p.model} – ${p.wp} Wc`;
    sel.appendChild(o);
  }
  sel.value = st.project.panelId;
  const cp = st.project.customPanel;
  const fields: [string, keyof PanelSpec][] = [['pc-wp', 'wp'], ['pc-l', 'length'], ['pc-w', 'width'], ['pc-g', 'gamma']];
  for (const [id, k] of fields) {
    const inp = $(id) as HTMLInputElement;
    inp.value = String(cp[k]);
    inp.onchange = () => {
      (cp as any)[k] = Number(inp.value);
      onPanelSettings();
    };
  }
  sel.onchange = () => {
    st.project.panelId = sel.value;
    onPanelSettings();
  };
  const lo = st.project.layout;
  ($('lay-orient') as HTMLSelectElement).value = lo.orientation;
  ($('lay-margin') as HTMLInputElement).value = String(Math.round(lo.margin * 100));
  ($('lay-gap') as HTMLInputElement).value = String(Math.round(lo.gap * 100));
  ($('lay-obs') as HTMLInputElement).value = String(Math.round(lo.obstacleClearance * 100));
  for (const id of ['lay-orient', 'lay-margin', 'lay-gap', 'lay-obs'])
    $(id).onchange = () => {
      lo.orientation = ($('lay-orient') as HTMLSelectElement).value as LayoutOptions['orientation'];
      lo.margin = Number(($('lay-margin') as HTMLInputElement).value) / 100;
      lo.gap = Number(($('lay-gap') as HTMLInputElement).value) / 100;
      lo.obstacleClearance = Number(($('lay-obs') as HTMLInputElement).value) / 100;
      onPanelSettings();
    };
  renderPanelSpec();
}

function renderPanelSpec(): void {
  const p = panelSpec();
  $('panel-custom').hidden = st.project.panelId !== 'custom';
  $('panel-spec').innerHTML = `${p.length.toFixed(3)} × ${p.width.toFixed(3)} m · ${fmt((p.wp / (p.length * p.width * 1000)) * 100, 1)} % de rendement · ${p.gamma} %/°C${p.tech ? ` · ${p.tech}` : ''}. <i>Valeurs indicatives, vérifiez la fiche technique.</i>`;
}

function onPanelSettings(): void {
  st.project.disabledPanels = [];
  renderPanelSpec();
  relayout();
  save();
}

function relayout(): void {
  const spec = panelSpec();
  const disabled = new Set(st.project.disabledPanels);
  st.panels = [];
  for (const pan of st.pans) {
    if (!pan.enabled) continue;
    for (const p of layoutPan(pan, st.northOffset, spec.length, spec.width, st.project.layout)) {
      p.enabled = !disabled.has(panelKey(p));
      st.panels.push(p);
    }
  }
  st.result = null;
  renderPans();
  renderPanels();
  renderPanelSummary();
  scheduleSim();
}

function renderPanelSummary(): void {
  const spec = panelSpec();
  const n = st.panels.filter((p) => p.enabled).length;
  const area = n * spec.length * spec.width;
  $('panel-summary').innerHTML = `<div class="kpi"><div class="l">Panneaux posés</div><div class="v">${n}</div></div>
    <div class="kpi"><div class="l">Puissance crête</div><div class="v">${fmt((n * spec.wp) / 1000, 2)} <small>kWc</small></div></div>
    <div class="kpi wide"><div class="l">Surface de panneaux</div><div class="v">${fmt(area, 1)} <small>m²</small></div></div>`;
}

// Échelle séquentielle (une teinte) pour la perte d'ensoleillement : clair = peu d'ombre.
function lossColor(loss: number): string {
  const t = Math.max(0, Math.min(1, loss / 0.3));
  const a = [255, 236, 214];
  const b = [168, 46, 0];
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c.join(',')})`;
}

function renderPanels(): void {
  layers.panels.clearLayers();
  layers.labels.clearLayers();
  panelPolys.clear();
  if (!($('ly-panels') as HTMLInputElement).checked) return;
  const stats = st.result ? panelStats(periodMonths()) : null;
  const mode = ($('label-mode') as HTMLSelectElement).value;
  for (const p of st.panels) {
    const s = stats?.get(p.id);
    const fill = !p.enabled ? 'transparent' : s ? lossColor(s.loss) : '#1d3557';
    const poly = L.polygon(p.corners.map((c) => ll(c[0], c[1])), {
      color: p.enabled ? '#ffffff' : '#ffffffaa',
      weight: p.id === st.hoverPanel ? 3 : 1,
      fillColor: fill,
      fillOpacity: p.enabled ? 0.85 : 0,
      dashArray: p.enabled ? undefined : '3 3',
      bubblingMouseEvents: false,
    }).addTo(layers.panels);
    panelPolys.set(p.id, poly);
    poly.bindTooltip(() => panelTooltip(p), { sticky: true });
    poly.on('click', () => {
      p.enabled = !p.enabled;
      const k = panelKey(p);
      const set = new Set(st.project.disabledPanels);
      if (p.enabled) set.delete(k);
      else set.add(k);
      st.project.disabledPanels = [...set];
      st.result = null;
      renderPanels();
      renderPanList();
      renderPanelSummary();
      scheduleSim();
      save();
    });
    poly.on('mouseover', () => highlightRow(p.id, true));
    poly.on('mouseout', () => highlightRow(p.id, false));
    if (s && p.enabled && mode !== 'none') {
      const txt = mode === 'loss' ? `${fmt(s.loss * 100, s.loss < 0.1 ? 1 : 0)}%` : `${fmt(s.eMicro)}`;
      L.marker(ll(p.center[0], p.center[1]), { icon: L.divIcon({ className: 'panel-label', html: `<div>${txt}</div>`, iconSize: [0, 0] }), interactive: false }).addTo(layers.labels);
    }
  }
  updateLabelVisibility();
  renderLegend(!!stats);
}

function renderLegend(show: boolean): void {
  let el = document.getElementById('loss-legend');
  if (!show || !($('ly-panels') as HTMLInputElement).checked) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'loss-legend';
    el.className = 'panel-float';
    document.querySelector('main')!.appendChild(el);
  }
  const steps = [0, 0.05, 0.1, 0.15, 0.2, 0.3];
  el.innerHTML = `<div class="small"><b>Soleil perdu</b> (${periodLabel().toLowerCase()})</div><div class="ramp">${steps
    .map((v) => `<span><i style="background:${lossColor(v)}"></i>${v === 0.3 ? '≥ 30' : fmt(v * 100)} %</span>`)
    .join('')}</div>`;
}

function updateLabelVisibility(): void {
  // étiquettes seulement si un panneau fait au moins ~26 px de large à l'écran
  const spec = panelSpec();
  const mPerPx = (40075016.686 * Math.cos((st.lat * Math.PI) / 180)) / (256 * 2 ** map.getZoom());
  const show = spec.width / mPerPx >= 26;
  if (show && !map.hasLayer(layers.labels)) layers.labels.addTo(map);
  if (!show && map.hasLayer(layers.labels)) map.removeLayer(layers.labels);
}
map.on('zoomend', updateLabelVisibility);

function panelTooltip(p: PlacedPanel): string {
  const name = panelName(p);
  if (!p.enabled) return `<b>${name}</b> : exclu (cliquer pour le réintégrer)`;
  const s = st.result ? panelStats(periodMonths()).get(p.id) : null;
  if (!s) return `<b>${name}</b> (calcul en cours…)<br>Cliquer pour l'exclure`;
  return `<b>${name}</b> – ${periodLabel()}<br>
    Soleil perdu : <b>${pct(s.loss)}</b><br>
    &nbsp;· arbres et bâtiments : ${pct(s.lossNear)}<br>
    &nbsp;· relief lointain : ${pct(s.lossHorizon)}<br>
    Rayonnement reçu : ${fmt(s.poa)} kWh/m²<br>
    Production (micro-onduleur) : ${fmt(s.eMicro)} kWh<br>
    <i>Cliquer pour exclure ce panneau</i>`;
}

function panelName(p: PlacedPanel): string {
  const pan = st.pans.find((q) => q.id === p.panId);
  return `${pan?.name ?? p.panId} · n°${p.id.split('-').pop()}`;
}

// ======================================================================
// 5. Onduleurs
// ======================================================================

{
  const sel = $('micro') as HTMLSelectElement;
  for (const m of MICROS) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.name;
    sel.appendChild(o);
  }
  const e = st.project.elec;
  sel.value = e.microId;
  ($('central-eff') as HTMLInputElement).value = String(e.centralEfficiency * 100);
  ($('central-ac') as HTMLInputElement).value = String(e.centralAcMax);
  ($('losses') as HTMLInputElement).value = String(e.systemLosses * 100);
  const upd = () => {
    e.microId = sel.value;
    e.centralEfficiency = Number(($('central-eff') as HTMLInputElement).value) / 100;
    e.centralAcMax = Number(($('central-ac') as HTMLInputElement).value);
    e.systemLosses = Number(($('losses') as HTMLInputElement).value) / 100;
    save();
    scheduleSim();
  };
  for (const id of ['micro', 'central-eff', 'central-ac', 'losses']) $(id).onchange = upd;
}

// ======================================================================
// 6. Simulation et résultats
// ======================================================================

let simTimer = 0;
function scheduleSim(): void {
  clearTimeout(simTimer);
  simTimer = window.setTimeout(runSim, 250);
}

function runSim(): void {
  if (!st.weather || !st.dsm) return;
  const used = st.panels.filter((p) => p.enabled);
  const pans = st.pans.filter((pan) => used.some((p) => p.panId === pan.id));
  st.resultPanels = used.map((p) => p.id);
  st.resultPans = pans.map((p) => p.id);
  const spec = panelSpec();
  const micro = MICROS.find((m) => m.id === st.project.elec.microId) ?? MICROS[0];
  const e = st.project.elec;
  const input: SimInput = {
    pans: pans.map((pan) => ({ id: pan.id, tilt: planeTilt(pan.plane), azimuth: planeAzimuth(pan.plane, st.northOffset), ...pan.plane })),
    panels: used.map((p) => ({ id: p.id, panIndex: pans.findIndex((q) => q.id === p.panId), samples: p.samples.flat() })),
    weather: { lat: st.lat, lon: st.lon, timeOffsetH: st.weather.timeOffsetH, ghi: st.weather.ghi, dni: st.weather.dni, dhi: st.weather.dhi, t2m: st.weather.t2m },
    elec: {
      wp: spec.wp,
      gamma: spec.gamma,
      noct: spec.noct,
      microEff: micro.efficiency,
      microAcMax: micro.acMaxPerPanel,
      centralEff: e.centralEfficiency,
      centralAcMax: e.centralAcMax * 1000,
      losses: e.systemLosses,
      albedo: 0.2,
    },
  };
  $('sim-progress').hidden = false;
  ($('sim-progress').firstElementChild as HTMLElement).style.width = '0';
  post(simWorker, {
    type: 'simulate',
    reqId: ++simReq,
    input,
    leafless: st.project.leafless,
    deciduous: deciduousArray(),
    leaflessTransmission: st.project.leaflessTransmission,
  });
}

interface Period {
  id: string;
  label: string;
  months: number[];
}

const PERIODS: Period[] = [
  { id: 'year', label: 'Année', months: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'summer', label: 'Été (avril → septembre)', months: [3, 4, 5, 6, 7, 8] },
  { id: 'winter', label: 'Hiver (octobre → mars)', months: [9, 10, 11, 0, 1, 2] },
  { id: 'spring3', label: 'Printemps (mars → mai)', months: [2, 3, 4] },
  { id: 'summer3', label: 'Cœur de l\'été (juin → août)', months: [5, 6, 7] },
  { id: 'autumn3', label: 'Automne (septembre → novembre)', months: [8, 9, 10] },
  { id: 'winter3', label: 'Cœur de l\'hiver (décembre → février)', months: [11, 0, 1] },
  ...MONTHS_FR.map((m, i) => ({ id: `m${i}`, label: m[0].toUpperCase() + m.slice(1), months: [i] })),
];

{
  const sel = $('period') as HTMLSelectElement;
  PERIODS.forEach((p, i) => {
    if (i === 3) sel.appendChild(Object.assign(document.createElement('option'), { disabled: true, textContent: '── Trimestres ──' }));
    if (i === 7) sel.appendChild(Object.assign(document.createElement('option'), { disabled: true, textContent: '── Mois ──' }));
    sel.appendChild(Object.assign(document.createElement('option'), { value: p.id, textContent: p.label }));
  });
  sel.onchange = () => {
    renderPanels();
    renderResults();
  };
  $('label-mode').onchange = () => renderPanels();
}

function periodMonths(id?: string): number[] {
  const p = PERIODS.find((q) => q.id === (id ?? ($('period') as HTMLSelectElement).value));
  return p?.months ?? PERIODS[0].months;
}
function periodLabel(): string {
  return PERIODS.find((q) => q.id === ($('period') as HTMLSelectElement).value)?.label ?? 'Année';
}

interface PanelStat {
  poa: number;
  free: number;
  loss: number;
  lossHorizon: number;
  lossNear: number;
  eMicro: number;
  eIdeal: number;
}

function panelStats(months: number[]): Map<string, PanelStat> {
  const out = new Map<string, PanelStat>();
  const r = st.result;
  if (!r) return out;
  st.resultPanels.forEach((id, i) => {
    let free = 0, hor = 0, sh = 0, em = 0, ei = 0;
    for (const m of months) {
      free += r.poaFree[i * 12 + m];
      hor += r.poaHorizon[i * 12 + m];
      sh += r.poaShaded[i * 12 + m];
      em += r.eMicro[i * 12 + m];
      ei += r.eIdeal[i * 12 + m];
    }
    const loss = free > 0 ? 1 - sh / free : 0;
    const lossHorizon = free > 0 ? 1 - hor / free : 0;
    out.set(id, { poa: sh, free, loss, lossHorizon, lossNear: Math.max(0, loss - lossHorizon), eMicro: em, eIdeal: ei });
  });
  return out;
}

function renderResults(): void {
  const r = st.result;
  if (!r) return;
  const months = periodMonths();
  const stats = panelStats(months);
  const spec = panelSpec();
  const n = st.resultPanels.length;
  const kwc = (n * spec.wp) / 1000;
  const sum = (a: Float64Array, nItems: number, ms: number[]) => {
    let s = 0;
    for (let i = 0; i < nItems; i++) for (const m of ms) s += a[i * 12 + m];
    return s;
  };
  const eMicro = sum(r.eMicro, r.nPanels, months);
  const eCentral = sum(r.eCentral, r.nPans, months);
  const eIdeal = sum(r.eIdeal, r.nPanels, months);
  const free = sum(r.poaFree, r.nPanels, months);
  const shaded = sum(r.poaShaded, r.nPanels, months);
  const hor = sum(r.poaHorizon, r.nPanels, months);
  const loss = free > 0 ? 1 - shaded / free : 0;
  const lossH = free > 0 ? 1 - hor / free : 0;
  const isYear = months.length === 12;
  const diff = eMicro - eCentral;
  $('kpis').innerHTML = `
    <div class="kpi"><div class="l">Installation</div><div class="v">${n} <small>panneaux</small> · ${fmt(kwc, 2)} <small>kWc</small></div></div>
    <div class="kpi"><div class="l">Soleil perdu (ombres) – ${periodLabel()}</div><div class="v">${pct(loss)}</div><div class="small">arbres/bâtiments ${pct(Math.max(0, loss - lossH))} · relief ${pct(lossH)}</div></div>
    <div class="kpi"><div class="l"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--series-1)"></i> Micro-onduleurs</div><div class="v">${fmt(eMicro)} <small>kWh</small></div>${isYear && kwc ? `<div class="small">${fmt(eMicro / kwc)} kWh/kWc</div>` : ''}</div>
    <div class="kpi"><div class="l"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--series-2)"></i> Onduleur central (1 MPPT/pan)</div><div class="v">${fmt(eCentral)} <small>kWh</small></div>${isYear && kwc ? `<div class="small">${fmt(eCentral / kwc)} kWh/kWc</div>` : ''}</div>
    <div class="kpi wide"><div class="l">Bilan</div><div class="small">Sans aucune ombre, la production serait de <b>${fmt(eIdeal)} kWh</b> (micro-onduleurs).
      Les micro-onduleurs produisent <b>${diff >= 0 ? '+' : ''}${fmt(diff)} kWh</b> (${diff >= 0 ? '+' : ''}${pct(eCentral > 0 ? diff / eCentral : 0)}) par rapport à l'onduleur central.
      ${r.nPans > 1 ? '' : ''}</div></div>`;

  // Graphique mensuel (toujours sur l'année, la période est mise en évidence dans le tableau)
  const monthly = (a: Float64Array, nItems: number) => Array.from({ length: 12 }, (_, m) => sum(a, nItems, [m]));
  renderMonthlyChart(
    $('chart'),
    [
      { name: 'Micro-onduleurs', values: monthly(r.eMicro, r.nPanels), cssVar: '--series-1', kind: 'bar' },
      { name: 'Onduleur central', values: monthly(r.eCentral, r.nPans), cssVar: '--series-2', kind: 'bar' },
      { name: 'Sans ombre', values: monthly(r.eIdeal, r.nPanels), cssVar: '--series-ref', kind: 'tick' },
    ],
    'kWh',
  );

  // Tableau par pan
  let html = '<table><thead><tr><th>Pan</th><th>Orient.</th><th>Pente</th><th>Pann.</th><th>Ombre</th><th>Micro kWh</th><th>Central kWh</th></tr></thead><tbody>';
  st.resultPans.forEach((pid, pi) => {
    const pan = st.pans.find((q) => q.id === pid);
    if (!pan) return;
    const ids = st.resultPanels.filter((id) => st.panels.find((p) => p.id === id)?.panId === pid);
    let f = 0, s = 0, em = 0;
    for (const id of ids) {
      const ps = stats.get(id)!;
      f += ps.free;
      s += ps.poa;
      em += ps.eMicro;
    }
    let ec = 0;
    for (const m of months) ec += r.eCentral[pi * 12 + m];
    const info = panInfo(pan);
    html += `<tr><td><span class="sw" style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${panColor(pan)}"></span> ${pan.name}</td><td>${info.label}</td><td>${fmt(info.tilt)}°</td><td>${ids.length}</td><td>${pct(f > 0 ? 1 - s / f : 0)}</td><td>${fmt(em)}</td><td>${fmt(ec)}</td></tr>`;
  });
  html += '</tbody></table>';
  $('pan-table').innerHTML = html;

  // Tableau par panneau : année / été / hiver + période choisie
  const y = panelStats(periodMonths('year'));
  const su = panelStats(periodMonths('summer'));
  const wi = panelStats(periodMonths('winter'));
  const custom = !['year', 'summer', 'winter'].includes(($('period') as HTMLSelectElement).value);
  html = `<table><thead><tr><th>Panneau</th><th>Année</th><th>Été</th><th>Hiver</th>${custom ? `<th>${periodLabel()}</th>` : ''}<th>kWh/an</th></tr></thead><tbody>`;
  const rows = st.resultPanels.map((id) => st.panels.find((p) => p.id === id)!).filter(Boolean);
  for (const p of rows) {
    html += `<tr data-id="${p.id}"><td>${panelName(p)}</td><td>${pct(y.get(p.id)!.loss)}</td><td>${pct(su.get(p.id)!.loss)}</td><td>${pct(wi.get(p.id)!.loss)}</td>${custom ? `<td>${pct(stats.get(p.id)!.loss)}</td>` : ''}<td>${fmt(y.get(p.id)!.eMicro)}</td></tr>`;
  }
  html += '</tbody></table>';
  $('panel-table').innerHTML = html;
  $('panel-table')
    .querySelectorAll<HTMLTableRowElement>('tr[data-id]')
    .forEach((tr) => {
      tr.onmouseenter = () => setHoverPanel(tr.dataset.id!);
      tr.onmouseleave = () => setHoverPanel(null);
    });
  renderPanels();
  renderPanList();
}

function setHoverPanel(id: string | null): void {
  const prev = st.hoverPanel;
  st.hoverPanel = id;
  if (prev) panelPolys.get(prev)?.setStyle({ weight: 1 });
  if (id) panelPolys.get(id)?.setStyle({ weight: 3 }).bringToFront();
}

function highlightRow(id: string, on: boolean): void {
  $('panel-table').querySelector(`tr[data-id="${id}"]`)?.classList.toggle('hl', on);
}

// ---------- Export / sauvegarde ----------

$('btn-csv').onclick = () => {
  const r = st.result;
  if (!r) return;
  const lines = [
    ['panneau', 'pan', 'mois', 'rayonnement_sans_masque_kWh_m2', 'rayonnement_relief_kWh_m2', 'rayonnement_recu_kWh_m2', 'soleil_perdu_pct', 'production_micro_kWh', 'production_sans_ombre_kWh'].join(';'),
  ];
  st.resultPanels.forEach((id, i) => {
    const p = st.panels.find((q) => q.id === id)!;
    for (let m = 0; m < 12; m++) {
      const o = i * 12 + m;
      const loss = r.poaFree[o] > 0 ? 1 - r.poaShaded[o] / r.poaFree[o] : 0;
      lines.push([panelName(p), st.pans.find((q) => q.id === p.panId)?.name ?? '', MONTHS_FR[m], r.poaFree[o].toFixed(2), r.poaHorizon[o].toFixed(2), r.poaShaded[o].toFixed(2), (loss * 100).toFixed(2), r.eMicro[o].toFixed(2), r.eIdeal[o].toFixed(2)].join(';').replace(/\./g, ','));
    }
  });
  download('simulation-solaire.csv', '﻿' + lines.join('\n'), 'text/csv');
};

$('btn-save').onclick = () => {
  save();
  download('projet-solaire.json', JSON.stringify(st.project, null, 1), 'application/json');
};

$('file-project').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    const p = JSON.parse(await f.text());
    st.project = { ...defaultProject(), ...p };
    save();
    location.reload();
  } catch {
    alert('Fichier de projet illisible.');
  }
});

function download(name: string, content: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Calques ----------

$('ly-shadow').onchange = (e) => {
  if (!shadowOverlay) return;
  if ((e.target as HTMLInputElement).checked) {
    shadowOverlay.addTo(map);
    requestShadow();
  } else map.removeLayer(shadowOverlay);
};
$('ly-relief').onchange = (e) => {
  if (!reliefOverlay) return;
  if ((e.target as HTMLInputElement).checked) reliefOverlay.addTo(map);
  else map.removeLayer(reliefOverlay);
};
$('ly-pans').onchange = () => renderPans();
$('ly-panels').onchange = () => renderPanels();
$('ly-trees').onchange = () => renderTrees();
map.on('moveend', () => save());

// ======================================================================
// Démarrage : reprise du projet enregistré
// ======================================================================

if (st.project.building) {
  const b = st.project.building;
  $('loc-hint').innerHTML = 'Projet enregistré trouvé. <a href="#" id="resume">Reprendre</a> ou cliquez sur une autre maison.';
  $('resume').onclick = (e) => {
    e.preventDefault();
    analyze(b, st.project.pans).catch((err) => {
      setBusy(null);
      status(`Erreur : ${err.message}`, true);
    });
  };
  map.getContainer().style.cursor = 'crosshair';
} else {
  map.getContainer().style.cursor = 'crosshair';
}

// pour débogage / tests automatisés
(window as any).__solar = { st, map, analyze, ringArea };
