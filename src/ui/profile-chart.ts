import { niceAxis, type ChartTheme } from './histogram-chart.ts';

/** 線量プロファイルの 1 系列 (Ref / Eval) */
export interface ProfileSeries {
  label: string;
  values: Float32Array;
  color: 'series1' | 'series2';
  /** 色に頼らず見分けられるよう、Eval は破線にする */
  dashed: boolean;
}

export interface ProfileSpec {
  title: string;
  xLabel: string;
  positions: Float64Array;
  cursorIndex: number;
  series: ProfileSeries[];
  /** 線量軸の上限 (3 本のプロファイルで揃える) */
  doseMax: number;
  doseUnit: string;
  /** γ は線量と軸を共有せず、下の帯に分けて描く (解析前は null) */
  gamma: { values: Float32Array; cap: number; label: string } | null;
}

/** 描いた領域 (ホバー位置から点の添字を求めるのに使う) */
export interface ProfileGeometry {
  x0: number;
  x1: number;
  indexAt: (x: number) => number;
}

const PAD = { l: 44, r: 12, b: 34 };

/** 目盛り: 範囲 [a, b] に 5 本前後 */
function ticksFor(a: number, b: number): number[] {
  const { step } = niceAxis((b - a) * 0.8);
  const out: number[] = [];
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** 値の列を折れ線で描く。NaN の点で線を切る。segColor を渡すと区間ごとに色を変える */
function polyline(
  ctx: CanvasRenderingContext2D,
  xs: (i: number) => number,
  ys: (v: number) => number,
  values: Float32Array,
  segColor?: (a: number, b: number) => string,
): void {
  let open = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) {
      if (open) ctx.stroke();
      open = false;
      continue;
    }
    if (segColor && i > 0 && !Number.isNaN(values[i - 1])) {
      ctx.beginPath();
      ctx.strokeStyle = segColor(values[i - 1], v);
      ctx.moveTo(xs(i - 1), ys(values[i - 1]));
      ctx.lineTo(xs(i), ys(v));
      ctx.stroke();
      continue;
    }
    if (segColor) continue;
    if (!open) {
      ctx.beginPath();
      ctx.moveTo(xs(i), ys(v));
      open = true;
    } else ctx.lineTo(xs(i), ys(v));
  }
  if (open) ctx.stroke();
}

/** 線量プロファイル (上) と γ (下の帯) を描く。hover はホバー中の点の添字 */
export function drawProfile(ctx: CanvasRenderingContext2D, w: number, h: number, spec: ProfileSpec, t: ChartTheme, hover = -1): ProfileGeometry {
  const { positions } = spec;
  const n = positions.length;
  ctx.save();
  ctx.fillStyle = t.surface;
  ctx.fillRect(0, 0, w, h);
  const font = (size: number, weight = 400) => `${weight} ${size}px ${t.font}`;

  // 見出しと凡例 (凡例は幅が足りなければ次の行へ)
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.font = font(13, 600);
  const titleW = ctx.measureText(spec.title).width;
  ctx.fillStyle = t.ink;
  ctx.fillText(spec.title, 10, 8);
  ctx.font = font(11);
  const items = spec.series.map((s) => ({ s, w: 22 + ctx.measureText(s.label).width }));
  const legendW = items.reduce((a, it) => a + it.w + 12, -12);
  const oneRow = titleW + 16 + legendW <= w - 20;
  let lx = oneRow ? w - 10 - legendW : 10;
  const ly = oneRow ? 10 : 26;
  for (const { s, w: iw } of items) {
    ctx.strokeStyle = t[s.color];
    ctx.lineWidth = 2;
    ctx.setLineDash(s.dashed ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(lx, ly + 6);
    ctx.lineTo(lx + 16, ly + 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = t.inkSecondary;
    ctx.fillText(s.label, lx + 22, ly);
    lx += iw + 12;
  }

  const top = oneRow ? 30 : 44;
  const x0 = PAD.l;
  const x1 = w - PAD.r;
  const plotBottom = h - PAD.b;
  const avail = plotBottom - top;
  const geometry: ProfileGeometry = { x0, x1, indexAt: () => -1 };
  if (x1 - x0 < 40 || avail < 40 || n < 2) {
    ctx.restore();
    return geometry;
  }
  const gammaH = spec.gamma ? Math.max(28, Math.round(avail * 0.28)) : 0;
  const doseTop = top + 6;
  const doseBottom = plotBottom - (spec.gamma ? gammaH + 12 : 0);
  const gTop = doseBottom + 12;

  const pMin = positions[0];
  const pMax = positions[n - 1];
  const xOf = (p: number) => x0 + ((p - pMin) / (pMax - pMin)) * (x1 - x0);
  const xs = (i: number) => xOf(positions[i]);
  geometry.indexAt = (x) => Math.max(0, Math.min(n - 1, Math.round(((x - x0) / (x1 - x0)) * (n - 1))));

  // 線量軸 (目盛りとグリッド)
  const { max: dMax, step: dStep } = niceAxis(spec.doseMax > 0 ? spec.doseMax : 1);
  const yDose = (v: number) => doseBottom - (v / dMax) * (doseBottom - doseTop);
  ctx.font = font(10);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let s = 0; s * dStep <= dMax + 1e-9; s++) {
    const v = s * dStep;
    const y = Math.round(yDose(v)) + 0.5;
    ctx.strokeStyle = s === 0 ? t.axis : t.grid;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.fillStyle = t.muted;
    ctx.fillText(`${Number(v.toFixed(3))}`, x0 - 6, y);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(spec.doseUnit, 4, doseTop - 2);

  // γ の帯 (0 – 上限、γ = 1 に基準線)
  const yGamma = spec.gamma ? (v: number) => gTop + gammaH - (Math.min(v, spec.gamma!.cap) / spec.gamma!.cap) * gammaH : null;
  if (spec.gamma && yGamma) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of [0, 1, spec.gamma.cap]) {
      const y = Math.round(yGamma(v)) + 0.5;
      ctx.strokeStyle = v === 0 ? t.axis : t.grid;
      ctx.setLineDash(v === 1 ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = t.muted;
      ctx.fillText(`${v}`, x0 - 6, y);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = font(12, 600);
    ctx.fillText(spec.gamma.label, 6, gTop + gammaH / 2);
    ctx.font = font(10);
  }

  // X 目盛り
  ctx.fillStyle = t.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const p of ticksFor(pMin, pMax)) ctx.fillText(`${p}`, xOf(p), plotBottom + 5);
  ctx.fillStyle = t.inkSecondary;
  ctx.fillText(spec.xLabel, (x0 + x1) / 2, plotBottom + 19);

  // 十字カーソルの位置
  const cx = Math.round(xs(spec.cursorIndex)) + 0.5;
  ctx.strokeStyle = t.inkSecondary;
  ctx.globalAlpha = 0.7;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, doseTop);
  ctx.lineTo(cx, plotBottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // 線量の系列
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  for (const s of spec.series) {
    ctx.strokeStyle = t[s.color];
    ctx.setLineDash(s.dashed ? [5, 3] : []);
    polyline(ctx, xs, yDose, s.values);
  }
  ctx.setLineDash([]);

  // γ: 1 を超える区間は不合格の色にする
  if (spec.gamma && yGamma) {
    ctx.lineWidth = 1.5;
    polyline(ctx, xs, yGamma, spec.gamma.values, (a, b) => (a > 1 || b > 1 ? t.fail : t.inkSecondary));
  }

  // ホバー: 縦線と各系列の点 (面の色の縁取り付き)
  if (hover >= 0 && hover < n) {
    const hx = Math.round(xs(hover)) + 0.5;
    ctx.strokeStyle = t.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, doseTop);
    ctx.lineTo(hx, plotBottom);
    ctx.stroke();
    const dot = (y: number, color: string) => {
      ctx.beginPath();
      ctx.arc(hx, y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.strokeStyle = t.surface;
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    };
    for (const s of spec.series) if (!Number.isNaN(s.values[hover])) dot(yDose(s.values[hover]), t[s.color]);
    if (spec.gamma && yGamma && !Number.isNaN(spec.gamma.values[hover])) {
      const g = spec.gamma.values[hover];
      dot(yGamma(g), g > 1 ? t.fail : t.inkSecondary);
    }
  }
  ctx.restore();
  return geometry;
}
