import { describe, expect, it } from 'vitest';
import { buildSearchOffsets, computeSlab, DEFAULT_PARAMS, type AnalysisParams } from '../src/core/gamma.ts';
import { ddPercentArray, ddStats, dtaStats, gammaHistogram, gammaStats } from '../src/core/stats.ts';
import { createSampler, resampleTo, shiftVolume, type Vec3, type Volume } from '../src/core/volume.ts';

function makeVolume(dims: [number, number, number], spacing: [number, number, number], origin: [number, number, number], f: (x: number, y: number, z: number) => number): Volume {
  const [nx, ny, nz] = dims;
  const data = new Float32Array(nx * ny * nz);
  let n = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) data[n++] = f(origin[0] + i * spacing[0], origin[1] + j * spacing[1], origin[2] + k * spacing[2]);
  return { dims, spacing, origin, data };
}

function run(ref: Volume, ev: Volume, over: Partial<AnalysisParams> = {}) {
  const p: AnalysisParams = { ...DEFAULT_PARAMS, normDoseGy: 2, ...over };
  const off = buildSearchOffsets(p.dtaMm, p.stepsPerDta, p.gammaCap);
  return { p, r: computeSlab(ref, ev, p, off, 0, ref.dims[2]) };
}

/** 中心付近の点 (端の影響を受けない) のインデックス */
function centerIndex(v: Volume): number {
  const [nx, ny, nz] = v.dims;
  return (nx >> 1) + nx * ((ny >> 1) + ny * (nz >> 1));
}

const grid = { dims: [21, 21, 21] as [number, number, number], spacing: [1, 1, 1] as [number, number, number], origin: [-10, -10, -10] as [number, number, number] };

describe('volume', () => {
  it('三線形補間は線形関数を正確に再現し、範囲外は NaN', () => {
    const v = makeVolume(grid.dims, grid.spacing, grid.origin, (x, y, z) => 1 + 0.1 * x - 0.2 * y + 0.05 * z);
    const s = createSampler(v);
    expect(s(0.3, -1.7, 2.25)).toBeCloseTo(1 + 0.03 + 0.34 + 0.1125, 5);
    expect(s(10, 10, 10)).toBeCloseTo(1 + 1 - 2 + 0.5, 5);
    expect(s(10.5, 0, 0)).toBeNaN();
  });

  it('resampleTo は範囲外を fill で埋める', () => {
    const v = makeVolume(grid.dims, grid.spacing, grid.origin, () => 1);
    const r = resampleTo(v, { dims: [3, 1, 1], spacing: [15, 1, 1], origin: [-10, 0, 0] }, -1);
    expect(Array.from(r.data)).toEqual([1, 1, -1]);
  });
});

describe('gamma', () => {
  it('同一線量ならガンマは 0、パス率 100%', () => {
    const f = (x: number, y: number, z: number) => 2 * Math.exp(-(x * x + y * y + z * z) / 50);
    const ref = makeVolume(grid.dims, grid.spacing, grid.origin, f);
    const { r } = run(ref, ref);
    const s = gammaStats(r.gamma, 2);
    expect(s.evaluated).toBeGreaterThan(0);
    expect(s.max).toBe(0);
    expect(s.passRate).toBe(100);
  });

  it('一様な 2% の線量差 (Global 3%/3mm) → γ = 2/3', () => {
    const ref = makeVolume(grid.dims, grid.spacing, grid.origin, () => 2);
    const ev = makeVolume(grid.dims, grid.spacing, grid.origin, () => 2.04);
    const { r } = run(ref, ev);
    expect(r.gamma[centerIndex(ref)]).toBeCloseTo(2 / 3, 4);
    expect(r.dd[centerIndex(ref)]).toBeCloseTo(0.04, 5);
  });

  it('線形勾配を平行移動した場合、解析解 γ = g|s| / sqrt(ΔD² + g²Δd²) と一致する', () => {
    const g = 0.1; // Gy/mm (= 5%/mm of 2 Gy)
    const s = 2; // mm
    const ref = makeVolume(grid.dims, grid.spacing, grid.origin, (x) => 1 + g * x);
    const ev = makeVolume(grid.dims, grid.spacing, grid.origin, (x) => 1 + g * (x - s));
    const { r, p } = run(ref, ev);
    const dD = (p.ddPercent / 100) * p.normDoseGy;
    const expected = (g * s) / Math.sqrt(dD * dD + g * g * p.dtaMm * p.dtaMm);
    // 探索刻み (DTA/10) の離散化誤差を許容
    expect(r.gamma[centerIndex(ref)]).toBeCloseTo(expected, 2);
    // DTA は平行移動量に一致する (勾配 5%/mm ≥ 3%/mm なので評価対象)
    expect(r.dta[centerIndex(ref)]).toBeCloseTo(s, 3);
    expect(r.grad[centerIndex(ref)]).toBeCloseTo(5, 3);
  });

  it('探索刻みの間に線量が ΔD 以上変わる急勾配でも、等線量面との交点から最小値を見つける', () => {
    // 0.5 Gy/mm は 1% (0.02 Gy) の 25 倍/mm。刻み 0.1 mm で線量が 2.5ΔD 変わるため、格子点だけでは谷を見逃す
    const g = 0.5;
    const s = 0.37;
    const ref = makeVolume(grid.dims, grid.spacing, grid.origin, (x) => 5 + g * x);
    const ev = makeVolume(grid.dims, grid.spacing, grid.origin, (x) => 5 + g * (x - s));
    const { r, p } = run(ref, ev, { ddPercent: 1, dtaMm: 1 });
    const dD = (p.ddPercent / 100) * p.normDoseGy;
    const expected = (g * s) / Math.sqrt(dD * dD + g * g * p.dtaMm * p.dtaMm);
    expect(r.gamma[centerIndex(ref)]).toBeCloseTo(expected, 3);
  });

  it('Local では局所線量で正規化される', () => {
    const ref = makeVolume(grid.dims, grid.spacing, grid.origin, () => 1);
    const ev = makeVolume(grid.dims, grid.spacing, grid.origin, () => 1.02);
    const global = run(ref, ev).r.gamma[centerIndex(ref)];
    const local = run(ref, ev, { local: true }).r.gamma[centerIndex(ref)];
    expect(global).toBeCloseTo(0.02 / 0.06, 4); // 3% of 2 Gy
    expect(local).toBeCloseTo(0.02 / 0.03, 4); // 3% of 1 Gy
  });

  it('閾値未満の点・低勾配の点は対象外、見つからない DTA は Infinity', () => {
    const ref = makeVolume(grid.dims, grid.spacing, grid.origin, (x) => (x < 0 ? 0.1 : 2));
    const ev = makeVolume(grid.dims, grid.spacing, grid.origin, () => 3);
    const { r, p } = run(ref, ev);
    const c = centerIndex(ref);
    expect(r.gamma[c - 5]).toBeNaN(); // x = -5 (0.1 Gy < 10%)
    expect(r.gamma[c + 5]).toBe(p.gammaCap); // 50% の差 → 上限
    expect(r.dta[c + 5]).toBeNaN(); // 平坦部は勾配 0 → DTA 対象外
    expect(r.dta[c]).toBe(Infinity); // x = 0 は勾配部だが、比較先は一様で等線量面がない
    const st = dtaStats(r.dta, p);
    expect(st.notFound).toBeGreaterThan(0);
  });

  it('DD の低勾配限定オプション', () => {
    const ref = makeVolume(grid.dims, grid.spacing, grid.origin, (x) => 1 + 0.1 * Math.max(0, x));
    const ev = makeVolume(grid.dims, grid.spacing, grid.origin, (x) => 1.01 + 0.1 * Math.max(0, x));
    const c = centerIndex(ref);
    const on = run(ref, ev, { ddLowGradientOnly: true }).r;
    expect(on.dd[c - 5]).toBeCloseTo(0.01, 5); // 平坦部
    expect(on.dd[c + 5]).toBeNaN(); // 5%/mm の勾配部は除外
    const off = run(ref, ev).r;
    expect(off.dd[c + 5]).toBeCloseTo(0.01, 5);
  });
});

describe('手動シフト (A1)', () => {
  it('shiftVolume は原点だけをずらし、移動後の位置 x の値は移動前の x − shift の値になる', () => {
    const v = makeVolume(grid.dims, grid.spacing, grid.origin, (x, y, z) => x + 2 * y + 3 * z);
    const moved = shiftVolume(v, [1, -2, 0.5]);
    expect(moved.data).toBe(v.data);
    expect(createSampler(moved)(3, 4, 5)).toBeCloseTo(2 + 2 * 6 + 3 * 4.5, 5);
    expect(shiftVolume(v, [0, 0, 0])).toBe(v);
  });

  it('既知量だけずらした比較先を、逆向きに平行移動するとパス率 100% に戻る', () => {
    const s: Vec3 = [2, -1.5, 1];
    const f = (x: number, y: number, z: number) => 2 * Math.exp(-(x * x + y * y + z * z) / (2 * 5 * 5));
    const ref = makeVolume(grid.dims, grid.spacing, grid.origin, f);
    const ev = makeVolume(grid.dims, grid.spacing, grid.origin, (x, y, z) => f(x - s[0], y - s[1], z - s[2]));
    const crit = { ddPercent: 2, dtaMm: 1 };

    const before = gammaStats(run(ref, ev, crit).r.gamma, 2);
    expect(before.passRate).toBeLessThan(50);

    const corrected = shiftVolume(ev, [-s[0], -s[1], -s[2]]);
    const after = gammaStats(run(ref, corrected, crit).r.gamma, 2);
    expect(after.evaluated).toBeGreaterThan(500);
    expect(after.passRate).toBe(100);
    expect(after.max).toBeLessThan(0.3);
  });
});

describe('stats', () => {
  it('ヒストグラムと DD 統計', () => {
    const gamma = new Float32Array([0, 0.5, 1, 1.5, 2, NaN]);
    const h = gammaHistogram(gamma, 2);
    expect(h.total).toBe(5);
    expect(h.overflow).toBe(1);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(4);
    const gs = gammaStats(gamma, 2);
    expect(gs.passRate).toBeCloseTo(60, 6);
    expect(gs.maxCapped).toBe(true);

    const p = { ...DEFAULT_PARAMS, normDoseGy: 2 };
    const dd = new Float32Array([0.02, -0.08, NaN]);
    const pct = ddPercentArray(dd, new Float32Array([1, 1, 1]), p);
    expect(Array.from(pct.subarray(0, 2))).toEqual([1, -4].map((v) => Math.fround(v)));
    const st = ddStats(pct, p);
    expect(st.evaluated).toBe(2);
    expect(st.passed).toBe(1);
  });
});
