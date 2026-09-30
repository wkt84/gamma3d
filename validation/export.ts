/**
 * 照合用のケースを作り、Gamma3D で計算した結果を validation/.work/ に書き出す。
 * 続けて validation/compare.py が同じ線量配列を pymedphys に渡して比較する。
 *
 * 実行: npm run validate (サンプル生成 → このスクリプト → compare.py)
 *
 * 出力 (ケースごとのディレクトリ):
 *   meta.json               格子・解析条件・Gamma3D の統計値
 *   ref.f32, eval.f32       線量 (Gy, float32 little endian, x が最速)
 *   gamma3d_<条件>.f32      Gamma3D のガンマ (対象外は NaN)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildRangeGrid, buildSearchOffsets, computeSlab, DEFAULT_PARAMS, type AnalysisParams } from '../src/core/gamma.ts';
import { gammaStats } from '../src/core/stats.ts';
import { maxValue, type Volume } from '../src/core/volume.ts';
import { buildDoseSets } from '../src/dicom/group.ts';
import { parseRtDose } from '../src/dicom/rtdose.ts';

const WORK = new URL('./.work/', import.meta.url).pathname;

export const CRITERIA: [number, number][] = [
  [3, 3],
  [3, 2],
  [2, 2],
  [1, 1],
];

interface Case {
  name: string;
  description: string;
  ref: Volume;
  ev: Volume;
}

function grid(dims: [number, number, number], s: number, f: (x: number, y: number, z: number) => number): Volume {
  const origin: [number, number, number] = [-((dims[0] - 1) * s) / 2, -((dims[1] - 1) * s) / 2, -((dims[2] - 1) * s) / 2];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  let n = 0;
  for (let k = 0; k < dims[2]; k++)
    for (let j = 0; j < dims[1]; j++)
      for (let i = 0; i < dims[0]; i++) data[n++] = f(origin[0] + i * s, origin[1] + j * s, origin[2] + k * s);
  return { dims, spacing: [s, s, s], origin, data };
}

function erf(x: number): number {
  const sgn = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  return sgn * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
const profile = (u: number, w: number, s: number) => 0.5 * (erf((w / 2 - u) / (Math.SQRT2 * s)) + erf((w / 2 + u) / (Math.SQRT2 * s)));
/** 半影のある立方体状の照射野 (最大 2 Gy) */
const field = (x: number, y: number, z: number) => 2 * profile(x, 50, 3) * profile(y, 40, 3) * profile(z, 36, 3) + 0.02;

function loadSample(files: string[]): Volume {
  const doses = files.map((f) => {
    const b = readFileSync(new URL(`../samples/${f}`, import.meta.url));
    return parseRtDose(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), f);
  });
  return buildDoseSets(doses)[0].volume;
}

function cases(): Case[] {
  const g = 0.1; // Gy/mm
  return [
    {
      name: 'linear-shift',
      description: '線形勾配 (5%/mm) を x 方向に 2 mm 平行移動 (解析解あり)',
      ref: grid([41, 41, 21], 1, (x) => 1 + g * x),
      ev: grid([41, 41, 21], 1, (x) => 1 + g * (x - 2)),
    },
    {
      name: 'uniform-offset',
      description: '一様な 2 Gy に +2% の線量差 (解析解あり)',
      ref: grid([31, 31, 21], 1, () => 2),
      ev: grid([31, 31, 21], 1, () => 2.04),
    },
    {
      name: 'field-shift',
      description: '半影のある照射野を (1.5, -1, 0.5) mm ずらし、+1.5% の線量差',
      ref: grid([48, 44, 40], 2, field),
      ev: grid([48, 44, 40], 2, (x, y, z) => 1.015 * field(x - 1.5, y + 1, z - 0.5)),
    },
    {
      name: 'sample',
      description: 'npm run gen:samples のサンプル (比較元 2.5 mm 格子の PLAN、比較先 3 mm 格子の BEAM ×2 合算)',
      ref: loadSample(['ref/plan.dcm']),
      ev: loadSample(['eval/beam1.dcm', 'eval/beam2.dcm']),
    },
  ];
}

export const key = (dd: number, dta: number, local: boolean) => `${dd}_${dta}_${local ? 'local' : 'global'}`;

function geometry(v: Volume) {
  return { dims: v.dims, spacing: v.spacing, origin: v.origin };
}

const f32 = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

for (const c of cases()) {
  const dir = `${WORK}${c.name}/`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}ref.f32`, f32(c.ref.data));
  writeFileSync(`${dir}eval.f32`, f32(c.ev.data));
  const normDoseGy = maxValue(c.ref.data);
  const runs: Record<string, unknown> = {};
  const evalRange = buildRangeGrid(c.ev);
  for (const [dd, dta] of CRITERIA) {
    for (const local of [false, true]) {
      const p: AnalysisParams = { ...DEFAULT_PARAMS, ddPercent: dd, dtaMm: dta, local, normDoseGy };
      const offsets = buildSearchOffsets(p.dtaMm, p.stepsPerDta, p.gammaCap);
      const t0 = performance.now();
      const r = computeSlab(c.ref, c.ev, p, offsets, 0, c.ref.dims[2], evalRange);
      const ms = performance.now() - t0;
      const k = key(dd, dta, local);
      writeFileSync(`${dir}gamma3d_${k}.f32`, f32(r.gamma));
      runs[k] = { params: p, stats: gammaStats(r.gamma, p.gammaCap), ms };
    }
  }
  writeFileSync(
    `${dir}meta.json`,
    JSON.stringify({ name: c.name, description: c.description, ref: geometry(c.ref), eval: geometry(c.ev), normDoseGy, runs }, null, 2),
  );
  console.log(`${c.name}: ${Object.keys(runs).length} 条件を書き出しました`);
}
