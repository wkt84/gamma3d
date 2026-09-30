import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildRangeGrid, buildSearchOffsets, computeSlab, DEFAULT_PARAMS, type AnalysisParams, type SlabResult } from '../src/core/gamma.ts';
import type { Volume } from '../src/core/volume.ts';
import { WasmKernel } from '../src/core/wasm-kernel.ts';

const wasmBytes = readFileSync(new URL('../src/wasm/gamma3d_kernel.wasm', import.meta.url));

function grid(dims: [number, number, number], s: [number, number, number], origin: [number, number, number], f: (x: number, y: number, z: number) => number): Volume {
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  let n = 0;
  for (let k = 0; k < dims[2]; k++)
    for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) data[n++] = f(origin[0] + i * s[0], origin[1] + j * s[1], origin[2] + k * s[2]);
  return { dims, spacing: s, origin, data };
}

function erf(x: number): number {
  const sgn = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  return sgn * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
const box = (x: number, y: number, z: number) =>
  0.5 * (erf((20 - Math.abs(x)) / 4) + 1) * 0.5 * (erf((16 - Math.abs(y)) / 4) + 1) * 0.5 * (erf((14 - Math.abs(z)) / 4) + 1) * 2 + 0.03;

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

/** NaN 同士・Infinity も含めてビット単位で比較し、食い違った要素数を返す */
function mismatches(a: Float32Array, b: Float32Array): number {
  let bad = 0;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i]) && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) bad++;
  return bad;
}

async function compare(ref: Volume, ev: Volume, over: Partial<AnalysisParams>, chunk: number) {
  const p: AnalysisParams = { ...DEFAULT_PARAMS, normDoseGy: 2, ...over };
  const offsets = buildSearchOffsets(p.dtaMm, p.stepsPerDta, p.gammaCap);
  const range = buildRangeGrid(ev);
  const kernel = await WasmKernel.create(wasmBytes);
  kernel.setup(ref, ev, p, offsets, range);
  const nz = ref.dims[2];
  const bad: Record<keyof Omit<SlabResult, 'k0' | 'k1'>, number> = { gamma: 0, dd: 0, dta: 0, grad: 0, evalOnRef: 0 };
  let evaluated = 0;
  for (let k0 = 0; k0 < nz; k0 += chunk) {
    const k1 = Math.min(nz, k0 + chunk);
    const ts = computeSlab(ref, ev, p, offsets, k0, k1, range);
    const w = kernel.computeSlab(k0, k1);
    for (const key of Object.keys(bad) as (keyof typeof bad)[]) bad[key] += mismatches(ts[key], w[key]);
    evaluated += ts.gamma.filter((g) => !Number.isNaN(g)).length;
  }
  return { bad, evaluated };
}

const zero = { gamma: 0, dd: 0, dta: 0, grad: 0, evalOnRef: 0 };

describe('WebAssembly カーネル', () => {
  let ref: Volume;
  let shifted: Volume;
  let coarse: Volume;
  beforeAll(() => {
    ref = grid([30, 26, 22], [2, 2, 2], [-29, -25, -21], box);
    shifted = grid([30, 26, 22], [2, 2, 2], [-29, -25, -21], (x, y, z) => 1.02 * box(x - 1.3, y + 0.7, z - 0.4) * (1 + (rnd() - 0.5) * 0.02));
    // 格子の異なる比較先 (間隔・原点が違い、比較元の一部を覆わない)
    coarse = grid([22, 20, 14], [2.5, 2.5, 2.5], [-26, -23.5, -15], (x, y, z) => 0.98 * box(x + 0.8, y, z));
  });

  for (const [label, over] of [
    ['3%/3mm Global', {}],
    ['2%/2mm Local', { ddPercent: 2, dtaMm: 2, local: true }],
    ['1%/1mm Global (急勾配)', { ddPercent: 1, dtaMm: 1 }],
    ['DD 低勾配限定・上限 3・分割 6', { ddLowGradientOnly: true, gammaCap: 3, stepsPerDta: 6 }],
  ] as const) {
    it(`TypeScript 版とビット単位で一致する: ${label}`, async () => {
      const r = await compare(ref, shifted, over, 3);
      expect(r.evaluated).toBeGreaterThan(1000);
      expect(r.bad).toEqual(zero);
    });
  }

  it('格子の異なる比較先 (範囲外の点を含む) でも一致する', async () => {
    const r = await compare(ref, coarse, { ddPercent: 2, dtaMm: 2 }, 4);
    expect(r.bad).toEqual(zero);
  });

  it('ジョブの分け方 (スライス数) によらず一致する', async () => {
    for (const chunk of [1, 5, 22]) {
      const r = await compare(ref, shifted, { ddPercent: 2, dtaMm: 2 }, chunk);
      expect(r.bad).toEqual(zero);
    }
  });

  it('比較先が全点で大きく外れる場合 (上限で打ち切る場合) も一致する', async () => {
    const half = { ...shifted, data: shifted.data.map((v) => v * 0.5) };
    const r = await compare(ref, half, {}, 4);
    expect(r.bad).toEqual(zero);
  });
});
