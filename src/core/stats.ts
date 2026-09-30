import type { AnalysisParams } from './gamma.ts';

export interface Histogram {
  /** 最初のビンの下端 */
  min: number;
  binWidth: number;
  counts: number[];
  /** min 未満 */
  underflow: number;
  /** 上限以上 (γ: 上限値、DTA: 探索半径内に見つからない点) */
  overflow: number;
  total: number;
}

/** 値の入るビン。-1: min 未満 (underflow)、nBins: 上限以上 (overflow) */
export function binIndex(v: number, min: number, binWidth: number, nBins: number): number {
  const b = Math.floor((v - min) / binWidth + 1e-9);
  return b < 0 ? -1 : b >= nBins ? nBins : b;
}

export function histogram(values: Iterable<number>, min: number, binWidth: number, nBins: number): Histogram {
  const counts = new Array<number>(nBins).fill(0);
  let underflow = 0;
  let overflow = 0;
  let total = 0;
  for (const v of values) {
    total++;
    const b = binIndex(v, min, binWidth, nBins);
    if (b < 0) underflow++;
    else if (b >= nBins) overflow++;
    else counts[b]++;
  }
  return { min, binWidth, counts, underflow, overflow, total };
}

/**
 * ヒストグラムの 1 つのビン (binIndex と同じ番号) に入る点の印 (1/0) と点数。
 * values はヒストグラムを作った値の配列 (NaN は対象外)。点数はヒストグラムのそのビンの度数と一致する。
 */
export function binMask(values: ArrayLike<number>, h: Pick<Histogram, 'min' | 'binWidth' | 'counts'>, bin: number): { mask: Uint8Array; count: number } {
  const mask = new Uint8Array(values.length);
  const nBins = h.counts.length;
  let count = 0;
  for (let n = 0; n < values.length; n++) {
    const v = values[n];
    if (!Number.isNaN(v) && binIndex(v, h.min, h.binWidth, nBins) === bin) {
      mask[n] = 1;
      count++;
    }
  }
  return { mask, count };
}

function* finite(a: Float32Array): Generator<number> {
  for (let n = 0; n < a.length; n++) {
    const v = a[n];
    if (!Number.isNaN(v)) yield v;
  }
}

function sortedFinite(a: Float32Array, includeInfinity: boolean): Float32Array {
  let c = 0;
  for (let n = 0; n < a.length; n++) if (!Number.isNaN(a[n]) && (includeInfinity || Number.isFinite(a[n]))) c++;
  const out = new Float32Array(c);
  c = 0;
  for (let n = 0; n < a.length; n++) if (!Number.isNaN(a[n]) && (includeInfinity || Number.isFinite(a[n]))) out[c++] = a[n];
  return out.sort();
}

function percentile(sorted: Float32Array, q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface GammaStats {
  evaluated: number;
  passed: number;
  passRate: number;
  mean: number;
  median: number;
  /** γ1%: 上位 1% に当たるガンマ値 (99 パーセンタイル) */
  p99: number;
  max: number;
  /** max が探索上限に達しているか (実際の値は上限以上) */
  maxCapped: boolean;
}

export function gammaStats(gamma: Float32Array, cap: number): GammaStats {
  const s = sortedFinite(gamma, false);
  let passed = 0;
  let sum = 0;
  for (let n = 0; n < s.length; n++) {
    if (s[n] <= 1) passed++;
    sum += s[n];
  }
  const max = s.length ? s[s.length - 1] : NaN;
  return {
    evaluated: s.length,
    passed,
    passRate: s.length ? (100 * passed) / s.length : NaN,
    mean: s.length ? sum / s.length : NaN,
    median: percentile(s, 0.5),
    p99: percentile(s, 0.99),
    max,
    maxCapped: max >= cap,
  };
}

export interface DdStats {
  evaluated: number;
  /** 線量差基準以内の点数 */
  passed: number;
  passRate: number;
  /** 平均・標準偏差・最小・最大 (%、正規化線量に対する割合) */
  meanPct: number;
  sdPct: number;
  minPct: number;
  maxPct: number;
}

/**
 * 線量差 (%) を求める。Global は normDose、Local は各点の比較元線量に対する割合。
 */
export function ddPercentArray(dd: Float32Array, refSlab: Float32Array, p: AnalysisParams): Float32Array {
  const out = new Float32Array(dd.length);
  for (let n = 0; n < dd.length; n++) {
    const v = dd[n];
    if (Number.isNaN(v)) out[n] = NaN;
    else out[n] = (100 * v) / (p.local ? refSlab[n] : p.normDoseGy);
  }
  return out;
}

export function ddStats(ddPct: Float32Array, p: AnalysisParams): DdStats {
  let c = 0;
  let passed = 0;
  let sum = 0;
  let sum2 = 0;
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of finite(ddPct)) {
    c++;
    if (Math.abs(v) <= p.ddPercent + 1e-9) passed++;
    sum += v;
    sum2 += v * v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const mean = c ? sum / c : NaN;
  return {
    evaluated: c,
    passed,
    passRate: c ? (100 * passed) / c : NaN,
    meanPct: mean,
    sdPct: c > 1 ? Math.sqrt(Math.max(0, (sum2 - c * mean * mean) / (c - 1))) : NaN,
    minPct: c ? mn : NaN,
    maxPct: c ? mx : NaN,
  };
}

export interface DtaStats {
  evaluated: number;
  passed: number;
  passRate: number;
  /** 探索半径内に等線量面が見つからなかった点数 */
  notFound: number;
  /** 見つかった点についての平均・中央値 (mm) */
  mean: number;
  median: number;
}

export function dtaStats(dta: Float32Array, p: AnalysisParams): DtaStats {
  const all = sortedFinite(dta, true);
  let passed = 0;
  let found = 0;
  let sum = 0;
  for (let n = 0; n < all.length; n++) {
    const v = all[n];
    if (v <= p.dtaMm + 1e-9) passed++;
    if (Number.isFinite(v)) {
      found++;
      sum += v;
    }
  }
  return {
    evaluated: all.length,
    passed,
    passRate: all.length ? (100 * passed) / all.length : NaN,
    notFound: all.length - found,
    mean: found ? sum / found : NaN,
    median: percentile(all.subarray(0, found), 0.5),
  };
}

/** 各ヒストグラムのビン設定。基準値がビンの境界に乗るように決める。 */
export function gammaHistogram(gamma: Float32Array, cap: number): Histogram {
  const nBins = 40;
  // 上限ちょうどの値 (= 上限以上) は overflow に入る
  return histogram(finite(gamma), 0, cap / nBins, nBins);
}

export function ddHistogram(ddPct: Float32Array, p: AnalysisParams): Histogram {
  const bw = p.ddPercent / 8;
  return histogram(finite(ddPct), -4 * p.ddPercent, bw, 64);
}

export function dtaHistogram(dta: Float32Array, p: AnalysisParams): Histogram {
  const bw = p.dtaMm / 10;
  return histogram(finite(dta), 0, bw, Math.round(p.gammaCap * 10));
}
