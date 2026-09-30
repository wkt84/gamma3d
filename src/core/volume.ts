/**
 * 患者座標系に軸を揃えた等間隔の3次元線量グリッド。
 *
 * - 軸 0/1/2 はそれぞれ患者座標 x/y/z に対応し、インデックスの増加方向は座標の増加方向 (spacing > 0)。
 * - origin はボクセル (0,0,0) の中心の患者座標 (mm)。
 * - data のインデックスは i + nx * (j + ny * k)。値は Gy。
 */
export interface Volume {
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  data: Float32Array;
}

export type Vec3 = [number, number, number];

export function voxelCount(v: Pick<Volume, 'dims'>): number {
  return v.dims[0] * v.dims[1] * v.dims[2];
}

export function voxelPosition(v: Volume, i: number, j: number, k: number): Vec3 {
  return [v.origin[0] + i * v.spacing[0], v.origin[1] + j * v.spacing[1], v.origin[2] + k * v.spacing[2]];
}

export function maxValue(data: ArrayLike<number>): number {
  let m = -Infinity;
  for (let n = 0; n < data.length; n++) {
    const d = data[n];
    if (d > m) m = d;
  }
  return m;
}

/** 2つのグリッドの形状・位置が (許容誤差内で) 一致するか。 */
export function sameGeometry(a: Volume, b: Volume, tolMm = 1e-3): boolean {
  for (let ax = 0; ax < 3; ax++) {
    if (a.dims[ax] !== b.dims[ax]) return false;
    if (Math.abs(a.spacing[ax] - b.spacing[ax]) > tolMm) return false;
    if (Math.abs(a.origin[ax] - b.origin[ax]) > tolMm) return false;
  }
  return true;
}

/**
 * 三線形補間のサンプラーを作る。グリッド (ボクセル中心の凸包) の外では NaN を返す。
 * ガンマ探索の最内ループで使うため、定数を事前計算したクロージャにしている。
 */
export function createSampler(v: Volume): (x: number, y: number, z: number) => number {
  const [nx, ny, nz] = v.dims;
  const [ox, oy, oz] = v.origin;
  const ix = 1 / v.spacing[0];
  const iy = 1 / v.spacing[1];
  const iz = 1 / v.spacing[2];
  const data = v.data;
  const sxy = nx * ny;
  const eps = 1e-6;
  const mx = nx - 1 + eps;
  const my = ny - 1 + eps;
  const mz = nz - 1 + eps;
  // 補間セルの左下インデックスの上限 (次元数 1 の軸は 0 で、隣接オフセットも 0 にして補間しない)
  const li = Math.max(nx - 2, 0);
  const lj = Math.max(ny - 2, 0);
  const lk = Math.max(nz - 2, 0);
  const di = nx > 1 ? 1 : 0;
  const dj = ny > 1 ? nx : 0;
  const dk = nz > 1 ? sxy : 0;

  return (x: number, y: number, z: number): number => {
    const fx = (x - ox) * ix;
    const fy = (y - oy) * iy;
    const fz = (z - oz) * iz;
    // NaN もここで弾かれる
    if (!(fx >= -eps && fy >= -eps && fz >= -eps && fx <= mx && fy <= my && fz <= mz)) return NaN;
    let i0 = fx <= 0 ? 0 : fx | 0;
    let j0 = fy <= 0 ? 0 : fy | 0;
    let k0 = fz <= 0 ? 0 : fz | 0;
    if (i0 > li) i0 = li;
    if (j0 > lj) j0 = lj;
    if (k0 > lk) k0 = lk;
    // 端の eps 以内のはみ出しは、わずかな外挿として扱う
    const tx = fx - i0;
    const ty = fy - j0;
    const tz = fz - k0;

    const b = i0 + nx * j0 + sxy * k0;
    const c000 = data[b];
    const c100 = data[b + di];
    const c010 = data[b + dj];
    const c110 = data[b + dj + di];
    const c001 = data[b + dk];
    const c101 = data[b + dk + di];
    const c011 = data[b + dk + dj];
    const c111 = data[b + dk + dj + di];

    const c00 = c000 + (c100 - c000) * tx;
    const c10 = c010 + (c110 - c010) * tx;
    const c01 = c001 + (c101 - c001) * tx;
    const c11 = c011 + (c111 - c011) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  };
}

/**
 * src を target のグリッド上へ三線形補間で再サンプリングする。
 * src の範囲外になる点には fill を入れる。
 */
export function resampleTo(src: Volume, target: Pick<Volume, 'dims' | 'spacing' | 'origin'>, fill = 0): Volume {
  const [nx, ny, nz] = target.dims;
  const out = new Float32Array(nx * ny * nz);
  const sample = createSampler(src);
  let n = 0;
  for (let k = 0; k < nz; k++) {
    const z = target.origin[2] + k * target.spacing[2];
    for (let j = 0; j < ny; j++) {
      const y = target.origin[1] + j * target.spacing[1];
      for (let i = 0; i < nx; i++, n++) {
        const d = sample(target.origin[0] + i * target.spacing[0], y, z);
        out[n] = Number.isNaN(d) ? fill : d;
      }
    }
  }
  return { dims: [...target.dims], spacing: [...target.spacing], origin: [...target.origin], data: out };
}

/**
 * 体積を shift (mm) だけ平行移動したものを返す (データは共有し、原点だけをずらす)。
 * 移動後の位置 x の値は、移動前の位置 x − shift の値になる。
 */
export function shiftVolume(v: Volume, shift: Vec3): Volume {
  if (shift[0] === 0 && shift[1] === 0 && shift[2] === 0) return v;
  return { ...v, origin: [v.origin[0] + shift[0], v.origin[1] + shift[1], v.origin[2] + shift[2]] };
}
