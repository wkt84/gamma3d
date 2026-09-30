import type { Histogram } from '../core/stats.ts';
import { m } from '../i18n/index.ts';

export interface ChartTheme {
  surface: string;
  ink: string;
  inkSecondary: string;
  muted: string;
  grid: string;
  axis: string;
  pass: string;
  fail: string;
  font: string;
}

export const LIGHT_CHART_THEME: ChartTheme = {
  surface: '#ffffff',
  ink: '#0b0b0b',
  inkSecondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  pass: '#2a78d6',
  fail: '#d03b3b',
  font: 'sans-serif',
};

/** CSS カスタムプロパティからテーマを読む */
export function themeFromCss(el: Element): ChartTheme {
  const s = getComputedStyle(el);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    surface: v('--surface-1'),
    ink: v('--text-primary'),
    inkSecondary: v('--text-secondary'),
    muted: v('--text-muted'),
    grid: v('--grid'),
    axis: v('--axis'),
    pass: v('--chart-pass'),
    fail: v('--chart-fail'),
    font: s.fontFamily,
  };
}

export interface HistSpec {
  title: string;
  xLabel: string;
  hist: Histogram;
  /** ビン [lo, hi) が基準内か */
  isPass: (lo: number, hi: number) => boolean;
  refLines: number[];
  ticks: number[];
  fmtX: (v: number) => string;
  underflowLabel?: string;
  overflowLabel?: string;
  overflowPass?: boolean;
  /** 右上に出す要約 (例: 基準内 97.3%) */
  summary: string;
}

export interface BarHit {
  x: number;
  w: number;
  label: string;
  count: number;
  percent: number;
}

const BASE_PAD = { l: 44, r: 12, t: 40, b: 38 };

/** 目盛り間隔を 1, 2, 2.5, 5 ×10^k から選び、4 目盛り前後になる上限と間隔を返す */
function niceAxis(v: number): { max: number; step: number } {
  const raw = Math.max(v, 0.1) / 4;
  const e = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * e >= raw) ?? 10) * e;
  return { max: Math.ceil(v / step - 1e-9) * step || step, step };
}

/**
 * ヒストグラムを描く。縦軸は全評価点に対する割合 (%)。
 * 戻り値はホバー判定用の各バーの位置。
 */
export function drawHistogram(ctx: CanvasRenderingContext2D, w: number, h: number, spec: HistSpec, t: ChartTheme, hover = -1): BarHit[] {
  const { hist } = spec;
  ctx.save();
  ctx.fillStyle = t.surface;
  ctx.fillRect(0, 0, w, h);
  const font = (size: number, weight = 400) => `${weight} ${size}px ${t.font}`;

  // 見出し: タイトル・要約・凡例。幅が足りなければ要約を凡例の行へ、それでも足りなければ独立した行へ回す
  const legend: [string, string][] = [
    [t.pass, m().hist.pass],
    [t.fail, m().hist.fail],
  ];
  ctx.font = font(13, 600);
  const titleW = ctx.measureText(spec.title).width;
  ctx.font = font(12, 500);
  const summaryW = ctx.measureText(spec.summary).width;
  ctx.font = font(11);
  const legendW = legend.reduce((a, [, label]) => a + 13 + ctx.measureText(label).width + 12, 0);
  const room = w - 20 - 16;
  const summaryRow = titleW + summaryW <= room ? 0 : legendW + summaryW <= room ? 1 : 2;
  const legendY = summaryRow === 2 ? 40 : 24;
  const PAD = { ...BASE_PAD, t: BASE_PAD.t + (summaryRow === 2 ? 16 : 0) };

  ctx.fillStyle = t.ink;
  ctx.font = font(13, 600);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(spec.title, 10, 8);
  ctx.fillStyle = t.inkSecondary;
  ctx.font = font(12, 500);
  if (summaryRow === 2) ctx.fillText(spec.summary, 10, 24);
  else {
    ctx.textAlign = 'right';
    ctx.fillText(spec.summary, w - 10, summaryRow === 0 ? 8 : 24);
  }

  ctx.font = font(11);
  ctx.textAlign = 'left';
  let lx = 10;
  for (const [color, label] of legend) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, legendY + 1, 9, 9);
    ctx.fillStyle = t.inkSecondary;
    ctx.fillText(label, lx + 13, legendY);
    lx += 13 + ctx.measureText(label).width + 12;
  }

  const plotW = w - PAD.l - PAD.r;
  const plotH = h - PAD.t - PAD.b;
  if (plotW <= 20 || plotH <= 20) {
    ctx.restore();
    return [];
  }

  const total = hist.total || 1;
  const nb = hist.counts.length;
  const hasUnder = spec.underflowLabel !== undefined;
  const hasOver = spec.overflowLabel !== undefined;
  const pct = (c: number) => (100 * c) / total;
  const values = [...hist.counts, hasUnder ? hist.underflow : 0, hasOver ? hist.overflow : 0].map(pct);
  const { max: yMax, step: yStep } = niceAxis(Math.max(...values));

  // 範囲外のバーは本体から少し離して置く
  const extraSlots = (hasUnder ? 1.6 : 0) + (hasOver ? 1.6 : 0);
  const slot = plotW / (nb + extraSlots);
  const bodyX = PAD.l + (hasUnder ? 1.6 * slot : 0);
  const xOf = (v: number) => bodyX + ((v - hist.min) / hist.binWidth) * slot;
  const yOf = (p: number) => PAD.t + plotH - (p / yMax) * plotH;

  // グリッドと Y 軸ラベル
  ctx.font = font(10);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let s = 0; s * yStep <= yMax + 1e-9; s++) {
    const p = s * yStep;
    const y = Math.round(yOf(p)) + 0.5;
    ctx.strokeStyle = s === 0 ? t.axis : t.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.l, y);
    ctx.lineTo(w - PAD.r, y);
    ctx.stroke();
    ctx.fillStyle = t.muted;
    ctx.fillText(`${Number(p.toFixed(2))}%`, PAD.l - 6, y);
  }

  const gap = Math.min(2, slot * 0.25);
  const hits: BarHit[] = [];
  const bar = (x: number, bw: number, p: number, pass: boolean, idx: number) => {
    if (p <= 0) return;
    const y = yOf(p);
    const bh = PAD.t + plotH - y;
    ctx.fillStyle = pass ? t.pass : t.fail;
    ctx.globalAlpha = hover >= 0 && hover !== idx ? 0.55 : 1;
    const r = Math.min(2, bw / 2, bh);
    ctx.beginPath();
    ctx.moveTo(x, y + bh);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + bw - r, y);
    ctx.arcTo(x + bw, y, x + bw, y + r, r);
    ctx.lineTo(x + bw, y + bh);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  for (let b = 0; b < nb; b++) {
    const lo = hist.min + b * hist.binWidth;
    const hi = lo + hist.binWidth;
    const x = xOf(lo) + gap / 2;
    const bw = Math.max(1, slot - gap);
    bar(x, bw, pct(hist.counts[b]), spec.isPass(lo, hi), hits.length);
    hits.push({ x: xOf(lo), w: slot, label: `${spec.fmtX(lo)} – ${spec.fmtX(hi)}`, count: hist.counts[b], percent: pct(hist.counts[b]) });
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = font(10);
  // 範囲外バーのラベルは、はみ出さないように内側へ寄せる。占めた範囲には X 目盛りを描かない
  const taken: [number, number][] = [];
  const edgeLabel = (label: string, center: number) => {
    const lw = ctx.measureText(label).width;
    const x = Math.min(w - 2 - lw / 2, Math.max(2 + lw / 2, center));
    ctx.fillStyle = t.muted;
    ctx.fillText(label, x, PAD.t + plotH + 6);
    taken.push([x - lw / 2 - 4, x + lw / 2 + 4]);
  };
  if (hasUnder) {
    const x = PAD.l;
    bar(x + gap / 2, slot - gap, pct(hist.underflow), false, hits.length);
    hits.push({ x, w: slot, label: spec.underflowLabel!, count: hist.underflow, percent: pct(hist.underflow) });
    edgeLabel(spec.underflowLabel!, x + slot / 2);
  }
  if (hasOver) {
    const x = w - PAD.r - slot;
    bar(x + gap / 2, slot - gap, pct(hist.overflow), spec.overflowPass ?? false, hits.length);
    hits.push({ x, w: slot, label: spec.overflowLabel!, count: hist.overflow, percent: pct(hist.overflow) });
    edgeLabel(spec.overflowLabel!, x + slot / 2);
  }

  // X 目盛り (範囲外バーの境界の目盛りと、範囲外バーのラベルに重なるものは省く)
  ctx.fillStyle = t.muted;
  const lastEdge = hist.min + nb * hist.binWidth;
  for (const v of spec.ticks) {
    if ((hasUnder && Math.abs(v - hist.min) < 1e-9) || (hasOver && Math.abs(v - lastEdge) < 1e-9)) continue;
    const x = xOf(v);
    const label = spec.fmtX(v);
    const half = ctx.measureText(label).width / 2;
    if (taken.some(([a, b]) => x + half > a && x - half < b)) continue;
    ctx.fillText(label, x, PAD.t + plotH + 6);
  }
  ctx.fillStyle = t.inkSecondary;
  ctx.fillText(spec.xLabel, bodyX + (nb * slot) / 2, PAD.t + plotH + 21);

  // 基準線
  ctx.strokeStyle = t.ink;
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([3, 3]);
  for (const v of spec.refLines) {
    const x = Math.round(xOf(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, PAD.t);
    ctx.lineTo(x, PAD.t + plotH);
    ctx.stroke();
  }
  ctx.restore();
  return hits;
}
