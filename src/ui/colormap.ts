/** 値を RGB に変換するカラーマップ。NaN 等の対象外は null を返し、背景色で描かれる。 */
export interface ColorMap {
  rgb(v: number): [number, number, number] | null;
  /** カラーバー用 CSS グラデーション */
  gradient: string;
  min: number;
  max: number;
  /** カラーバー下に出すラベル */
  ticks: { value: number; label: string }[];
  /** 範囲外・特殊値の凡例 */
  extras?: { color: string; label: string }[];
}

type RGB = [number, number, number];

function lut(stops: RGB[], n = 256): RGB[] {
  const out: RGB[] = [];
  for (let m = 0; m < n; m++) {
    const t = (m / (n - 1)) * (stops.length - 1);
    const a = Math.min(stops.length - 2, Math.floor(t));
    const f = t - a;
    out.push([0, 1, 2].map((c) => Math.round(stops[a][c] + (stops[a + 1][c] - stops[a][c]) * f)) as RGB);
  }
  return out;
}

/** Google Turbo (多項式近似) */
function turbo(t: number): RGB {
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return [c(r), c(g), c(b)];
}

const TURBO: RGB[] = Array.from({ length: 256 }, (_, m) => turbo(m / 255));

const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

function gradientCss(table: RGB[], steps = 12): string {
  const parts: string[] = [];
  for (let s = 0; s <= steps; s++) {
    const idx = Math.round((s / steps) * (table.length - 1));
    parts.push(`${css(table[idx])} ${((s / steps) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

function fromTable(table: RGB[], min: number, max: number, v: number): RGB | null {
  if (!Number.isFinite(v)) return null;
  const t = (v - min) / (max - min);
  const idx = Math.max(0, Math.min(table.length - 1, Math.round(t * (table.length - 1))));
  return table[idx];
}

const fmt = (v: number, d = 1) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(d));

export function doseColorMap(maxDose: number): ColorMap {
  return {
    rgb: (v) => (Number.isNaN(v) ? null : fromTable(TURBO, 0, maxDose, v)),
    gradient: gradientCss(TURBO),
    min: 0,
    max: maxDose,
    ticks: [0, 0.5, 1].map((f) => ({ value: f * maxDose, label: `${fmt(f * maxDose, 2)} Gy` })),
  };
}

// ガンマ: 0–1 は青→緑 (合格)、1–上限は黄→赤 (不合格)
const GAMMA_PASS = lut([
  [28, 62, 150],
  [30, 140, 170],
  [60, 190, 90],
]);
const GAMMA_FAIL = lut([
  [250, 215, 60],
  [240, 130, 50],
  [205, 35, 35],
]);

export function gammaColorMap(cap: number): ColorMap {
  const split = ((1 / cap) * 100).toFixed(1);
  return {
    rgb: (v) => {
      if (Number.isNaN(v)) return null;
      if (v <= 1) return fromTable(GAMMA_PASS, 0, 1, v);
      return fromTable(GAMMA_FAIL, 1, cap, v);
    },
    gradient: `linear-gradient(to right, ${css(GAMMA_PASS[0])} 0%, ${css(GAMMA_PASS[128])} ${(Number(split) / 2).toFixed(1)}%, ${css(GAMMA_PASS[255])} ${split}%, ${css(GAMMA_FAIL[0])} ${split}%, ${css(GAMMA_FAIL[128])} ${((100 + Number(split)) / 2).toFixed(1)}%, ${css(GAMMA_FAIL[255])} 100%)`,
    min: 0,
    max: cap,
    ticks: [
      { value: 0, label: '0' },
      { value: 1, label: '1' },
      { value: cap, label: `≥${fmt(cap)}` },
    ],
  };
}

// 線量差: 青 ← 灰 → 赤 (発散型)
const DIVERGING = lut([
  [40, 95, 200],
  [120, 160, 225],
  [72, 72, 70],
  [235, 140, 120],
  [210, 45, 45],
]);

export function ddColorMap(range: number, unit: '%' | 'Gy'): ColorMap {
  const d = unit === '%' ? 1 : 2;
  return {
    rgb: (v) => (Number.isNaN(v) ? null : fromTable(DIVERGING, -range, range, v)),
    gradient: gradientCss(DIVERGING),
    min: -range,
    max: range,
    ticks: [
      { value: -range, label: `−${fmt(range, d)}` },
      { value: 0, label: '0' },
      { value: range, label: `+${fmt(range, d)} ${unit}` },
    ],
  };
}

// DTA: 単一色相の連続型。見つからない点は赤
const SEQ = lut([
  [25, 45, 85],
  [55, 120, 200],
  [190, 225, 255],
]);
const NOT_FOUND: RGB = [208, 59, 59];

export function dtaColorMap(maxMm: number): ColorMap {
  return {
    rgb: (v) => {
      if (Number.isNaN(v)) return null;
      if (v === Infinity) return NOT_FOUND;
      return fromTable(SEQ, 0, maxMm, v);
    },
    gradient: gradientCss(SEQ),
    min: 0,
    max: maxMm,
    ticks: [
      { value: 0, label: '0' },
      { value: maxMm / 2, label: `${fmt(maxMm / 2)}` },
      { value: maxMm, label: `${fmt(maxMm)} mm` },
    ],
    extras: [{ color: css(NOT_FOUND), label: '未検出' }],
  };
}

export function gradientColorMap(maxPctPerMm: number): ColorMap {
  return {
    rgb: (v) => (Number.isNaN(v) ? null : fromTable(SEQ, 0, maxPctPerMm, v)),
    gradient: gradientCss(SEQ),
    min: 0,
    max: maxPctPerMm,
    ticks: [
      { value: 0, label: '0' },
      { value: maxPctPerMm, label: `${fmt(maxPctPerMm)} %/mm` },
    ],
  };
}
