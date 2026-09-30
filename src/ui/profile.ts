import type { Volume } from '../core/volume.ts';
import type { Ijk } from './slice.ts';

/** 十字カーソルを通る 1 軸方向の値 (比較元の格子のボクセル中心で取る) */
export interface Profile {
  axis: 0 | 1 | 2;
  /** 各点の座標 (mm) */
  positions: Float64Array;
  /** カーソルのある点の添字 */
  cursorIndex: number;
  /** 系列ごとの値 (配列が null の系列は null) */
  values: (Float32Array | null)[];
}

/**
 * grid の格子上の配列 (arrays) から、cursor を通る axis 方向の値を取り出す。
 * arrays はすべて grid と同じ並び (i + nx·(j + ny·k)) の配列とする。
 */
export function extractProfile(grid: Pick<Volume, 'dims' | 'spacing' | 'origin'>, arrays: (ArrayLike<number> | null)[], cursor: Ijk, axis: 0 | 1 | 2): Profile {
  const [nx, ny] = grid.dims;
  const n = grid.dims[axis];
  const stride = [1, nx, nx * ny][axis];
  const base = cursor[0] + nx * (cursor[1] + ny * cursor[2]) - cursor[axis] * stride;
  const positions = new Float64Array(n);
  for (let i = 0; i < n; i++) positions[i] = grid.origin[axis] + i * grid.spacing[axis];
  const values = arrays.map((a) => {
    if (!a) return null;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = a[base + i * stride];
    return out;
  });
  return { axis, positions, cursorIndex: cursor[axis], values };
}
