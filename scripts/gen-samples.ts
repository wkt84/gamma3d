/**
 * 動作確認用の合成 RTDOSE を samples/ に書き出す。
 *
 *   samples/ref/plan.dcm         比較元: PLAN 線量 (2.5 mm 格子)
 *   samples/eval/beam1.dcm, beam2.dcm
 *                                比較先: BEAM 線量 ×2 (3 mm 格子、x 方向に +1 mm ずれ、+1.5%、ノイズあり、
 *                                        beam1 に半径 12 mm の +6% ホットスポット)
 *
 * 実行: npm run gen:samples
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { newUid, writeRtDose, type RtDoseSpec } from './dicom-writer.ts';

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

/** 幅 w、半影 σ の 1 次元プロファイル */
function profile(u: number, w: number, sigma: number): number {
  const k = Math.SQRT2 * sigma;
  return 0.5 * (erf((w / 2 - u) / k) + erf((w / 2 + u) / k));
}

/** 2 門の斜入射ビームを模した線量 (Gy)。beam: 0 または 1 */
function beamDose(x: number, y: number, z: number, beam: number): number {
  const angle = beam === 0 ? Math.PI / 6 : -Math.PI / 6;
  // ビーム座標 (u: 横方向, d: 深さ方向)
  const u = x * Math.cos(angle) - y * Math.sin(angle);
  const d = x * Math.sin(angle) + y * Math.cos(angle) + 100;
  const depth = Math.max(0, d);
  const pdd = (1 - Math.exp(-depth / 8)) * Math.exp(-0.005 * depth);
  const lateral = profile(u, 70, 4) * profile(z, 60, 4.5);
  const scatter = 0.04 * profile(u, 140, 25) * profile(z, 120, 25);
  return 1.25 * pdd * (lateral + scatter);
}

/** 疑似乱数 (再現性のため固定シード) */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Grid {
  n: [number, number, number];
  s: [number, number, number];
  o: [number, number, number];
}

function render(g: Grid, f: (x: number, y: number, z: number) => number): Float32Array {
  const [nx, ny, nz] = g.n;
  const out = new Float32Array(nx * ny * nz);
  let m = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) out[m++] = f(g.o[0] + i * g.s[0], g.o[1] + j * g.s[1], g.o[2] + k * g.s[2]);
  return out;
}

const refGrid: Grid = { n: [96, 88, 64], s: [2.5, 2.5, 2.5], o: [-118.75, -108.75, -78.75] };
const evalGrid: Grid = { n: [80, 72, 54], s: [3, 3, 3], o: [-118.5, -106.5, -79.5] };

const study = newUid();
const forUID = newUid();
const refPlan = newUid();
const evalPlan = newUid();
const common = { patientName: 'SAMPLE^PHANTOM', patientId: 'GAMMA3D-001', studyUID: study, forUID };

function spec(g: Grid, dose: Float32Array, over: Partial<RtDoseSpec>): RtDoseSpec {
  return {
    cols: g.n[0],
    rows: g.n[1],
    frames: g.n[2],
    spacing: [g.s[0], g.s[1]],
    ipp: g.o,
    frameOffsets: Array.from({ length: g.n[2] }, (_, k) => k * g.s[2]),
    dose,
    summationType: 'PLAN',
    planUID: refPlan,
    seriesDescription: '',
    seriesUID: newUid(),
    sopUID: newUid(),
    ...common,
    ...over,
  };
}

mkdirSync('samples/ref', { recursive: true });
mkdirSync('samples/eval', { recursive: true });

const ref = render(refGrid, (x, y, z) => beamDose(x, y, z, 0) + beamDose(x, y, z, 1));
writeFileSync('samples/ref/plan.dcm', writeRtDose(spec(refGrid, ref, { seriesDescription: 'TPS A plan dose' })));

const shift = 1.0; // mm
const scale = 1.015;
const rand = rng(42);
const evalSeries = newUid();
for (const beam of [0, 1]) {
  const dose = render(evalGrid, (x, y, z) => {
    const noise = 1 + (rand() - 0.5) * 0.01;
    const r2 = (x - 15) ** 2 + (y + 20) ** 2 + (z - 10) ** 2;
    const hot = beam === 0 ? 1 + 0.12 * Math.exp(-r2 / (2 * 8 ** 2)) : 1;
    return Math.max(0, scale * beamDose(x - shift, y, z, beam) * noise * hot);
  });
  writeFileSync(
    `samples/eval/beam${beam + 1}.dcm`,
    writeRtDose(
      spec(evalGrid, dose, {
        summationType: 'BEAM',
        beamNumber: beam + 1,
        planUID: evalPlan,
        seriesUID: evalSeries,
        seriesDescription: `TPS B beam ${beam + 1}`,
      }),
    ),
  );
}

console.log('samples/ に合成 RTDOSE を書き出しました (ref: PLAN ×1, eval: BEAM ×2)');
