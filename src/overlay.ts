import L from 'leaflet';
import { toWGS } from './geo';

/**
 * Calque raster défini en Lambert-93 (grille LiDAR), recalé sur la carte Web Mercator
 * par une transformation affine CSS (la grille est légèrement tournée par rapport au nord).
 */
export class GridOverlay extends L.Layer {
  readonly canvas: HTMLCanvasElement;
  private x0: number;
  private y0: number;
  private wM: number;
  private hM: number;
  private paneName: string;

  constructor(x0: number, y0: number, widthM: number, heightM: number, wPx: number, hPx: number, pane: string, opacity = 1) {
    super();
    this.x0 = x0;
    this.y0 = y0;
    this.wM = widthM;
    this.hM = heightM;
    this.paneName = pane;
    this.canvas = document.createElement('canvas');
    this.canvas.width = wPx;
    this.canvas.height = hPx;
    this.canvas.className = 'grid-overlay leaflet-zoom-hide';
    this.canvas.style.opacity = String(opacity);
  }

  onAdd(map: L.Map): this {
    map.getPane(this.paneName)!.appendChild(this.canvas);
    map.on('zoomend viewreset', this.reposition, this);
    this.reposition();
    return this;
  }

  onRemove(map: L.Map): this {
    this.canvas.remove();
    map.off('zoomend viewreset', this.reposition, this);
    return this;
  }

  setOpacity(o: number): void {
    this.canvas.style.opacity = String(o);
  }

  reposition(): void {
    const map = (this as any)._map as L.Map | undefined;
    if (!map) return;
    const lp = (x: number, y: number) => map.latLngToLayerPoint(toWGS(x, y) as L.LatLngTuple);
    const tl = lp(this.x0, this.y0);
    const tr = lp(this.x0 + this.wM, this.y0);
    const bl = lp(this.x0, this.y0 - this.hM);
    const w = this.canvas.width;
    const h = this.canvas.height;
    const m = [(tr.x - tl.x) / w, (tr.y - tl.y) / w, (bl.x - tl.x) / h, (bl.y - tl.y) / h, tl.x, tl.y];
    this.canvas.style.transform = `matrix(${m.join(',')})`;
  }
}
