import { describe, expect, it } from 'vitest';
import { binIndex, binMask, dtaHistogram, gammaHistogram, histogram } from '../src/core/stats.ts';
import { DEFAULT_PARAMS } from '../src/core/gamma.ts';

describe('ヒストグラムのビンに入る点', () => {
  it('binIndex: 範囲外は -1 / ビン数、境界ちょうどの値は上のビンに入る', () => {
    expect(binIndex(-0.1, 0, 0.5, 4)).toBe(-1);
    expect(binIndex(0, 0, 0.5, 4)).toBe(0);
    expect(binIndex(0.5, 0, 0.5, 4)).toBe(1);
    expect(binIndex(1.9999, 0, 0.5, 4)).toBe(3);
    expect(binIndex(2, 0, 0.5, 4)).toBe(4);
    expect(binIndex(Infinity, 0, 0.5, 4)).toBe(4);
  });

  it('各ビンの印の数はヒストグラムの度数と一致し、NaN は含まない (γ・DTA の範囲外を含む)', () => {
    const n = 5000;
    const gamma = Float32Array.from({ length: n }, (_, i) => (i % 97 === 0 ? NaN : ((i * 7919) % 1000) / 400));
    const g = gammaHistogram(gamma, 2);
    const bins = [...g.counts.keys(), g.counts.length];
    for (const b of bins) {
      const { mask, count } = binMask(gamma, g, b);
      expect(count).toBe(b === g.counts.length ? g.overflow : g.counts[b]);
      expect(mask.reduce((a, v) => a + v, 0)).toBe(count);
    }
    // すべてのビンの印を合わせると、NaN 以外の全点をちょうど 1 回ずつ覆う
    const cover = new Uint8Array(n);
    for (const b of bins) binMask(gamma, g, b).mask.forEach((v, i) => (cover[i] += v));
    cover.forEach((c, i) => expect(c).toBe(Number.isNaN(gamma[i]) ? 0 : 1));

    const dta = Float32Array.from({ length: n }, (_, i) => (i % 13 === 0 ? Infinity : ((i * 31) % 700) / 100));
    const d = dtaHistogram(dta, { ...DEFAULT_PARAMS, normDoseGy: 2 });
    expect(binMask(dta, d, d.counts.length).count).toBe(d.overflow);
  });

  it('下限未満のビン (-1) も選べる', () => {
    const v = Float32Array.from([-5, -1, 0, 1, 5]);
    const h = histogram(v, -2, 1, 4);
    expect(binMask(v, h, -1).count).toBe(h.underflow);
    expect([...binMask(v, h, -1).mask]).toEqual([1, 0, 0, 0, 0]);
  });
});
