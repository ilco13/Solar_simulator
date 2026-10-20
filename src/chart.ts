import { MONTHS_SHORT } from './sun';

export interface MonthlySeries {
  name: string;
  values: number[]; // 12
  cssVar: string;
  kind: 'bar' | 'tick';
}

/** Histogramme mensuel groupé (SVG) avec info-bulle au survol. */
export function renderMonthlyChart(el: HTMLElement, series: MonthlySeries[], unit: string): void {
  const W = 340;
  const H = 180;
  const m = { l: 40, r: 8, t: 10, b: 22 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const y = (v: number) => m.t + ph - (v / top) * ph;
  const bars = series.filter((s) => s.kind === 'bar');
  const slot = pw / 12;
  const bw = Math.max(3, (slot - 6) / Math.max(1, bars.length) - 2);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="mchart" role="img" aria-label="Production mensuelle">`;
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`;
    svg += `<text x="${m.l - 4}" y="${y(v) + 3}" class="axis" text-anchor="end">${fmt(v)}</text>`;
  }
  for (let i = 0; i < 12; i++) {
    const x0 = m.l + i * slot + 3;
    bars.forEach((s, k) => {
      const v = s.values[i];
      const x = x0 + k * (bw + 2);
      const hh = Math.max(0, y(0) - y(v));
      svg += `<path d="${roundedTop(x, y(v), bw, hh)}" style="fill:var(${s.cssVar})"/>`;
    });
    for (const s of series.filter((q) => q.kind === 'tick')) {
      const yy = y(s.values[i]);
      svg += `<line x1="${x0 - 1}" x2="${x0 + bars.length * (bw + 2) - 1}" y1="${yy}" y2="${yy}" class="tick" style="stroke:var(${s.cssVar})"/>`;
    }
    svg += `<text x="${m.l + (i + 0.5) * slot}" y="${H - 6}" class="axis" text-anchor="middle">${MONTHS_SHORT[i][0].toUpperCase()}</text>`;
    svg += `<rect x="${m.l + i * slot}" y="${m.t}" width="${slot}" height="${ph}" class="hit" data-m="${i}"/>`;
  }
  svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}" class="baseline"/></svg>`;
  const legend = series
    .map((s) => `<span class="lg"><i class="${s.kind}" style="background:var(${s.cssVar})"></i>${s.name}</span>`)
    .join('');
  el.innerHTML = `<div class="legend">${legend}</div><div class="chart-wrap">${svg}<div class="tip" hidden></div></div>`;
  const tip = el.querySelector('.tip') as HTMLElement;
  el.querySelectorAll<SVGRectElement>('.hit').forEach((r) => {
    r.addEventListener('mouseenter', () => {
      const i = Number(r.dataset.m);
      tip.innerHTML = `<b>${MONTHS_SHORT[i]}</b>` + series.map((s) => `<div><i style="background:var(${s.cssVar})"></i>${s.name} : <b>${fmt(s.values[i])}</b> ${unit}</div>`).join('');
      tip.hidden = false;
      const left = ((m.l + (i + 0.5) * slot) / W) * 100;
      tip.style.left = `${Math.min(70, Math.max(5, left - 15))}%`;
      r.classList.add('on');
    });
    r.addEventListener('mouseleave', () => {
      tip.hidden = true;
      r.classList.remove('on');
    });
  });
}

function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceStep(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

function fmt(v: number): string {
  return v >= 100 ? Math.round(v).toLocaleString('fr-FR') : v.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
}
