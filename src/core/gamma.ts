import { createSampler, type Volume } from './volume.ts';

/** ユーザーが設定する解析条件。 */
export interface AnalysisParams {
  /** 線量差基準 (%) */
  ddPercent: number;
  /** 距離基準 DTA (mm) */
  dtaMm: number;
  /** true: Local (比較元の局所線量で正規化) / false: Global */
  local: boolean;
  /** Global 正規化の基準線量 (Gy)。閾値 (%) もこの線量に対する割合。 */
  normDoseGy: number;
  /** ガンマを評価する比較元線量の下限 (% of normDose) */
  gammaThresholdPercent: number;
  /** 線量差 (DD) を評価する比較元線量の下限 (% of normDose) */
  ddThresholdPercent: number;
  /** true のとき DD を低勾配領域 (勾配 < gradientThreshold) に限定する */
  ddLowGradientOnly: boolean;
  /** DTA を評価する勾配の下限 (% of normDose / mm) */
  gradientThresholdPercentPerMm: number;
  /** ガンマの上限値。探索半径は gammaCap × DTA。これ以上は「≥ 上限」として扱う。 */
  gammaCap: number;
  /** 探索刻みの細かさ (探索刻み = DTA / stepsPerDta) */
  stepsPerDta: number;
}

export const DEFAULT_PARAMS: Omit<AnalysisParams, 'normDoseGy'> = {
  ddPercent: 3,
  dtaMm: 3,
  local: false,
  gammaThresholdPercent: 10,
  ddThresholdPercent: 10,
  ddLowGradientOnly: false,
  gradientThresholdPercentPerMm: 3,
  gammaCap: 2,
  stepsPerDta: 10,
};

/**
 * 距離順に並べた探索オフセット。
 * x/y/z は mm、r2 は (距離 / DTA)^2 (= ガンマの距離項)。
 */
export interface SearchOffsets {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  r2: Float32Array;
}

export function buildSearchOffsets(dtaMm: number, stepsPerDta: number, gammaCap: number): SearchOffsets {
  const step = dtaMm / stepsPerDta;
  const nmax = Math.ceil(gammaCap * stepsPerDta);
  const limit2 = (gammaCap * stepsPerDta) ** 2;
  const pts: { a: number; b: number; c: number; q: number }[] = [];
  for (let c = -nmax; c <= nmax; c++) {
    for (let b = -nmax; b <= nmax; b++) {
      for (let a = -nmax; a <= nmax; a++) {
        const q = a * a + b * b + c * c;
        if (q <= limit2) pts.push({ a, b, c, q });
      }
    }
  }
  pts.sort((p, q) => p.q - q.q);
  const n = pts.length;
  const out: SearchOffsets = {
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    r2: new Float32Array(n),
  };
  const inv = 1 / (stepsPerDta * stepsPerDta);
  for (let m = 0; m < n; m++) {
    const p = pts[m];
    out.x[m] = p.a * step;
    out.y[m] = p.b * step;
    out.z[m] = p.c * step;
    out.r2[m] = p.q * inv;
  }
  return out;
}

/**
 * 比較先線量をブロック (BLOCK^3 ボクセル) ごとの最小・最大値に要約したもの。
 * 三線形補間の値は参照するボクセル値の範囲に収まるため、探索球を含むブロックの
 * 最小・最大から「探索範囲内で取りうる比較先線量の範囲」を安く見積もれる。
 */
export interface RangeGrid {
  nb: [number, number, number];
  min: Float32Array;
  max: Float32Array;
}

const BLOCK = 4;

export function buildRangeGrid(v: Volume): RangeGrid {
  const [nx, ny, nz] = v.dims;
  const nb: [number, number, number] = [Math.ceil(nx / BLOCK), Math.ceil(ny / BLOCK), Math.ceil(nz / BLOCK)];
  const size = nb[0] * nb[1] * nb[2];
  const min = new Float32Array(size).fill(Infinity);
  const max = new Float32Array(size).fill(-Infinity);
  let n = 0;
  for (let k = 0; k < nz; k++) {
    const bk = ((k / BLOCK) | 0) * nb[0] * nb[1];
    for (let j = 0; j < ny; j++) {
      const bj = bk + ((j / BLOCK) | 0) * nb[0];
      for (let i = 0; i < nx; i++, n++) {
        const b = bj + ((i / BLOCK) | 0);
        const d = v.data[n];
        if (d < min[b]) min[b] = d;
        if (d > max[b]) max[b] = d;
      }
    }
  }
  return { nb, min, max };
}

/** スライス範囲 [k0, k1) の解析結果。各配列は比較元グリッドのボクセルに対応する。 */
export interface SlabResult {
  k0: number;
  k1: number;
  /** ガンマ値。評価対象外は NaN。上限以上は gammaCap。 */
  gamma: Float32Array;
  /** 線量差 Eval − Ref (Gy)。評価対象外は NaN。 */
  dd: Float32Array;
  /** DTA (mm)。評価対象外は NaN、探索半径内に見つからなければ Infinity。 */
  dta: Float32Array;
  /** 比較元線量の勾配の大きさ (% of normDose / mm) */
  grad: Float32Array;
  /** 比較先線量を比較元グリッドへ補間したもの (Gy)。範囲外は NaN。 */
  evalOnRef: Float32Array;
}

/**
 * 比較元グリッドのスライス [k0, k1) について、ガンマ・DD・DTA・勾配を計算する。
 * ガンマは比較先線量を三線形補間しながら、距離順に並べたオフセットを探索する。
 * 距離項がすでに見つかった最小値以上になった時点で打ち切る。
 */
export function computeSlab(
  ref: Volume,
  ev: Volume,
  p: AnalysisParams,
  offsets: SearchOffsets,
  k0: number,
  k1: number,
  evalRange: RangeGrid = buildRangeGrid(ev),
): SlabResult {
  const [nx, ny, nz] = ref.dims;
  const [sx, sy, sz] = ref.spacing;
  const [ox, oy, oz] = ref.origin;
  const rd = ref.data;
  const sxy = nx * ny;
  const n = (k1 - k0) * sxy;

  const gamma = new Float32Array(n).fill(NaN);
  const dd = new Float32Array(n).fill(NaN);
  const dta = new Float32Array(n).fill(NaN);
  const grad = new Float32Array(n);
  const evalOnRef = new Float32Array(n);

  const sample = createSampler(ev);
  const norm = p.normDoseGy;
  const gammaThr = (p.gammaThresholdPercent / 100) * norm;
  const ddThr = (p.ddThresholdPercent / 100) * norm;
  const gradThr = p.gradientThresholdPercentPerMm;
  const gradScale = 100 / norm;
  const globalDD = (p.ddPercent / 100) * norm;
  const localFrac = p.ddPercent / 100;
  const cap2 = p.gammaCap * p.gammaCap;
  const dtaMm = p.dtaMm;
  const step = dtaMm / p.stepsPerDta;
  const invDta2 = 1 / (dtaMm * dtaMm);

  const offX = offsets.x;
  const offY = offsets.y;
  const offZ = offsets.z;
  const offR2 = offsets.r2;
  const nOff = offR2.length;

  // 探索球 (半径 = 上限 × DTA) を覆う比較先のボクセル範囲を求めるための定数
  const radius = p.gammaCap * dtaMm;
  const [enx, eny, enz] = ev.dims;
  const [eox, eoy, eoz] = ev.origin;
  const [esx, esy, esz] = ev.spacing;
  const [nbx, nby] = evalRange.nb;
  const rmin = evalRange.min;
  const rmax = evalRange.max;
  const blockOf = (pos: number, o: number, sp: number, len: number, dir: number): number => {
    const f = (pos - o) / sp;
    const v = dir < 0 ? Math.floor(f) : Math.ceil(f);
    return (Math.min(len - 1, Math.max(0, v)) / BLOCK) | 0;
  };

  let out = 0;
  for (let k = k0; k < k1; k++) {
    const z = oz + k * sz;
    for (let j = 0; j < ny; j++) {
      const y = oy + j * sy;
      for (let i = 0; i < nx; i++, out++) {
        const x = ox + i * sx;
        const idx = i + nx * j + sxy * k;
        const dr = rd[idx];

        // 勾配 (中心差分、端は片側差分)
        const gx = diff(rd, idx, i, nx, 1, sx);
        const gy = diff(rd, idx, j, ny, nx, sy);
        const gz = diff(rd, idx, k, nz, sxy, sz);
        const g = Math.sqrt(gx * gx + gy * gy + gz * gz) * gradScale;
        grad[out] = g;

        const de0 = sample(x, y, z);
        evalOnRef[out] = de0;
        if (Number.isNaN(de0)) continue;

        // 線量差
        if (dr >= ddThr && (!p.ddLowGradientOnly || g < gradThr)) {
          dd[out] = de0 - dr;
        }

        if (dr < gammaThr || dr <= 0) continue;

        // 探索球内で比較先が取りうる線量範囲 [emin, emax]
        let emin = Infinity;
        let emax = -Infinity;
        const bi0 = blockOf(x - radius, eox, esx, enx, -1);
        const bi1 = blockOf(x + radius, eox, esx, enx, 1);
        const bj0 = blockOf(y - radius, eoy, esy, eny, -1);
        const bj1 = blockOf(y + radius, eoy, esy, eny, 1);
        const bk0 = blockOf(z - radius, eoz, esz, enz, -1);
        const bk1 = blockOf(z + radius, eoz, esz, enz, 1);
        for (let bk = bk0; bk <= bk1; bk++) {
          for (let bj = bj0; bj <= bj1; bj++) {
            let b = bi0 + nbx * (bj + nby * bk);
            for (let bi = bi0; bi <= bi1; bi++, b++) {
              if (rmin[b] < emin) emin = rmin[b];
              if (rmax[b] > emax) emax = rmax[b];
            }
          }
        }
        // 比較元線量と比較先の取りうる範囲との隔たり (範囲内なら 0)
        const gap = dr < emin ? emin - dr : dr > emax ? dr - emax : 0;

        // ガンマ
        const deltaD = p.local ? localFrac * dr : globalDD;
        const invD2 = 1 / (deltaD * deltaD);
        // どの探索点でも線量項はこの値以上になる
        const floor2 = gap * gap * invD2;
        let best = (de0 - dr) * (de0 - dr) * invD2;
        let bestM = 0;
        for (let m = 1; m < nOff; m++) {
          const r2 = offR2[m];
          if (r2 + floor2 >= best || r2 >= cap2) break;
          const de = sample(x + offX[m], y + offY[m], z + offZ[m]);
          if (de !== de) continue; // NaN (範囲外)
          const t = de - dr;
          const g2 = r2 + t * t * invD2;
          if (g2 < best) {
            best = g2;
            bestM = m;
          }
        }

        // 格子探索の最良点の周りを、刻みを半分ずつにして局所的に詰める (離散化誤差の低減)
        if (best > 0 && best < cap2) {
          let cx = offX[bestM];
          let cy = offY[bestM];
          let cz = offZ[bestM];
          let h = step * 0.5;
          for (let lvl = 0; lvl < REFINE_LEVELS; lvl++, h *= 0.5) {
            let bx = cx;
            let by = cy;
            let bz = cz;
            for (let c = -1; c <= 1; c++) {
              for (let b = -1; b <= 1; b++) {
                for (let a = -1; a <= 1; a++) {
                  if (a === 0 && b === 0 && c === 0) continue;
                  const px = cx + a * h;
                  const py = cy + b * h;
                  const pz = cz + c * h;
                  const r2 = (px * px + py * py + pz * pz) * invDta2;
                  if (r2 >= best) continue;
                  const de = sample(x + px, y + py, z + pz);
                  if (de !== de) continue;
                  const t = de - dr;
                  const g2 = r2 + t * t * invD2;
                  if (g2 < best) {
                    best = g2;
                    bx = px;
                    by = py;
                    bz = pz;
                  }
                }
              }
            }
            cx = bx;
            cy = by;
            cz = bz;
          }
        }
        gamma[out] = best >= cap2 ? p.gammaCap : Math.sqrt(best);

        // DTA (高勾配領域のみ): 比較先が比較元と同じ線量になる面までの最短距離
        if (g >= gradThr) {
          const s0 = de0 - dr;
          if (s0 === 0) {
            dta[out] = 0;
          } else if (gap > 0) {
            // 探索範囲内に比較元と同じ線量の点がない
            dta[out] = Infinity;
          } else {
            let found = Infinity;
            for (let m = 1; m < nOff; m++) {
              const de = sample(x + offX[m], y + offY[m], z + offZ[m]);
              if (de !== de) continue;
              const s = de - dr;
              if (s === 0 || (s > 0) !== (s0 > 0)) {
                // その方向の線分上で線形補間して交差位置を求める
                const dist = Math.sqrt(offR2[m]) * dtaMm;
                found = dist * (s0 / (s0 - s));
                break;
              }
            }
            dta[out] = found;
          }
        }
      }
    }
  }

  return { k0, k1, gamma, dd, dta, grad, evalOnRef };
}

/** 局所詰めの段数 (刻み/2, /4, /8) */
const REFINE_LEVELS = 3;

function diff(d: Float32Array, idx: number, pos: number, len: number, stride: number, h: number): number {
  if (len < 2) return 0;
  if (pos === 0) return (d[idx + stride] - d[idx]) / h;
  if (pos === len - 1) return (d[idx] - d[idx - stride]) / h;
  return (d[idx + stride] - d[idx - stride]) / (2 * h);
}
