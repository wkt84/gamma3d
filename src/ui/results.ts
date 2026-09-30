import type { AnalysisResult } from '../core/runner.ts';
import {
  ddHistogram,
  ddPercentArray,
  ddStats,
  dtaHistogram,
  dtaStats,
  gammaHistogram,
  gammaStats,
  histogram,
  type DdStats,
  type DtaStats,
  type GammaStats,
} from '../core/stats.ts';
import type { HistSpec } from './histogram-chart.ts';
import { m } from '../i18n/index.ts';

export type DdUnit = 'percent' | 'gy';

/** 解析結果から派生する統計値 */
export interface Derived {
  ddPct: Float32Array;
  gamma: GammaStats;
  dd: DdStats;
  dta: DtaStats;
}

export function derive(r: AnalysisResult): Derived {
  const ddPct = ddPercentArray(r.dd, r.ref.data, r.params);
  return {
    ddPct,
    gamma: gammaStats(r.gamma, r.params.gammaCap),
    dd: ddStats(ddPct, r.params),
    dta: dtaStats(r.dta, r.params),
  };
}

const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '–');

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to + step * 1e-6; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

export function histSpecs(r: AnalysisResult, d: Derived, ddUnit: DdUnit): [HistSpec, HistSpec, HistSpec] {
  const p = r.params;
  const t = m().hist;

  // 線量差
  let ddSpec: HistSpec;
  if (ddUnit === 'percent') {
    const c = p.ddPercent;
    ddSpec = {
      title: t.ddTitle,
      xLabel: t.ddAxisPercent(p.local, p.normDoseGy.toFixed(2)),
      hist: ddHistogram(d.ddPct, p),
      isPass: (lo, hi) => lo >= -c - 1e-9 && hi <= c + 1e-9,
      refLines: [-c, c],
      ticks: range(-4 * c, 4 * c, 2 * c),
      fmtX: (v) => `${Number(v.toFixed(2))}`,
      underflowLabel: `<−${4 * c}`,
      overflowLabel: `≥${4 * c}`,
      summary: t.passSummary(f1(d.dd.passRate), d.dd.evaluated.toLocaleString()),
    };
  } else {
    const c = (p.ddPercent / 100) * p.normDoseGy;
    const vals = function* () {
      for (let n = 0; n < r.dd.length; n++) if (!Number.isNaN(r.dd[n])) yield r.dd[n];
    };
    const h = histogram(vals(), -4 * c, c / 8, 64);
    let passed = 0;
    for (const v of vals()) if (Math.abs(v) <= c + 1e-9) passed++;
    ddSpec = {
      title: t.ddTitle,
      xLabel: t.ddAxisGy,
      hist: h,
      isPass: (lo, hi) => lo >= -c - 1e-9 && hi <= c + 1e-9,
      refLines: [-c, c],
      ticks: range(-4 * c, 4 * c, 2 * c),
      fmtX: (v) => v.toFixed(2),
      underflowLabel: t.outOfRange,
      overflowLabel: t.outOfRange,
      summary: t.ddGySummary(c.toFixed(3), f1(h.total ? (100 * passed) / h.total : NaN), h.total.toLocaleString()),
    };
  }

  const dtaMax = p.gammaCap * p.dtaMm;
  const dtaSpec: HistSpec = {
    title: t.dtaTitle(p.gradientThresholdPercentPerMm),
    xLabel: t.dtaAxis,
    hist: dtaHistogram(r.dta, p),
    isPass: (_lo, hi) => hi <= p.dtaMm + 1e-9,
    refLines: [p.dtaMm],
    ticks: range(0, dtaMax, dtaMax / 4),
    fmtX: (v) => `${Number(v.toFixed(2))}`,
    overflowLabel: t.notFound,
    summary: t.passSummary(f1(d.dta.passRate), d.dta.evaluated.toLocaleString()),
  };

  const cap = p.gammaCap;
  const gammaSpec: HistSpec = {
    title: t.gammaTitle(p.ddPercent, p.dtaMm, p.local),
    xLabel: 'γ',
    hist: gammaHistogram(r.gamma, cap),
    isPass: (_lo, hi) => hi <= 1 + 1e-9,
    refLines: [1],
    ticks: range(0, cap, cap / 4),
    fmtX: (v) => `${Number(v.toFixed(2))}`,
    overflowLabel: `≥${cap}`,
    summary: t.gammaSummary(f1(d.gamma.passRate), d.gamma.evaluated.toLocaleString()),
  };

  return [ddSpec, dtaSpec, gammaSpec];
}
