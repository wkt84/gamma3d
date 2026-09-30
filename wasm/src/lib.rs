//! Gamma3D のガンマ探索カーネル (WebAssembly)。
//!
//! `src/core/gamma.ts` の `computeSlab` と同じ計算を行い、結果はビット単位で一致させる
//! (浮動小数点の演算順序も TypeScript 版に合わせている。変更するときは両方を直し、
//! `test/wasm.test.ts` で一致を確かめる)。
//!
//! wasm-bindgen は使わない。配列の置き場所はこのモジュールが持ち、JS は reserve_* で得た
//! ポインタに値を書き込んでから set_* で形状を設定する。メモリが増えると JS 側のビューは
//! 無効になるので、JS は呼び出しのたびにビューを作り直す。
//!
//! 呼び出し順:
//!   解析ごとに 1 回: reserve_offsets / reserve_nbr → set_offsets、set_params、
//!                    reserve_range → set_range (比較先全体のブロックの範囲表。gamma.ts と同じもの)
//!   ジョブごと: reserve_ref → set_ref、reserve_eval → set_eval → compute(k0, k1)
//!               → 戻り値のポインタから結果 5 種類を読む
//!
//! 比較元・比較先とも、ジョブに必要な z の範囲 (スライス) だけを受け取る。座標・境界の判定は
//! 常に全体の格子で行い、データの読み出し位置だけを base_k スライス分ずらす
//! (部分範囲の原点で計算し直すと丸めが変わり、TypeScript 版と一致しなくなるため)。
#![allow(clippy::too_many_arguments)]

// ───────── 状態 ─────────

#[derive(Clone, Copy)]
struct Geom {
    n: [usize; 3],
    s: [f64; 3],
    o: [f64; 3],
}

impl Geom {
    const EMPTY: Geom = Geom { n: [0; 3], s: [1.0; 3], o: [0.0; 3] };
}

#[derive(Clone, Copy)]
struct Params {
    dd_percent: f64,
    dta_mm: f64,
    local: bool,
    norm_dose: f64,
    gamma_threshold_percent: f64,
    dd_threshold_percent: f64,
    dd_low_gradient_only: bool,
    gradient_threshold: f64,
    gamma_cap: f64,
    steps_per_dta: f64,
}

struct State {
    ref_geom: Geom,
    ref_base_k: usize,
    ref_data: Vec<f32>,
    eval_geom: Geom,
    eval_base_k: usize,
    eval_data: Vec<f32>,
    /// ブロックごとの比較先線量の最小・最大・勾配の上限を、ブロック数ずつ連続で
    range_nb: [usize; 3],
    range: Vec<f32>,
    /// 探索オフセット: x, y, z, r2, rn を n 個ずつ連続で
    off: Vec<f32>,
    nbr: Vec<i32>,
    n_off: usize,
    step_n: f64,
    p: Params,
    diffs: Vec<f32>,
    stamp: Vec<i32>,
    gen: i32,
    /// 結果: gamma, dd, dta, grad, evalOnRef を n 個ずつ連続で
    out: Vec<f32>,
}

static mut STATE: State = State {
    ref_geom: Geom::EMPTY,
    ref_base_k: 0,
    ref_data: Vec::new(),
    eval_geom: Geom::EMPTY,
    eval_base_k: 0,
    eval_data: Vec::new(),
    range_nb: [0; 3],
    range: Vec::new(),
    off: Vec::new(),
    nbr: Vec::new(),
    n_off: 0,
    step_n: 0.0,
    p: Params {
        dd_percent: 0.0,
        dta_mm: 0.0,
        local: false,
        norm_dose: 0.0,
        gamma_threshold_percent: 0.0,
        dd_threshold_percent: 0.0,
        dd_low_gradient_only: false,
        gradient_threshold: 0.0,
        gamma_cap: 0.0,
        steps_per_dta: 0.0,
    },
    diffs: Vec::new(),
    stamp: Vec::new(),
    gen: 0,
    out: Vec::new(),
};

#[allow(static_mut_refs)]
fn state() -> &'static mut State {
    // wasm のインスタンスは 1 つの Worker (1 スレッド) からしか呼ばれない
    unsafe { &mut STATE }
}

fn reserve<T: Copy + Default>(v: &mut Vec<T>, n: usize) -> *mut T {
    v.clear();
    v.resize(n, T::default());
    v.as_mut_ptr()
}

// ───────── JS から呼ぶ関数 ─────────

#[no_mangle]
pub extern "C" fn reserve_offsets(n: usize) -> *mut f32 {
    reserve(&mut state().off, 5 * n)
}

#[no_mangle]
pub extern "C" fn reserve_nbr(n: usize) -> *mut i32 {
    reserve(&mut state().nbr, 6 * n)
}

#[no_mangle]
pub extern "C" fn set_offsets(n: usize, step_n: f64) {
    let st = state();
    st.n_off = n;
    st.step_n = step_n;
    st.diffs = vec![0.0; n];
    st.stamp = vec![0; n];
    st.gen = 0;
}

#[no_mangle]
pub extern "C" fn set_params(
    dd_percent: f64,
    dta_mm: f64,
    local: i32,
    norm_dose: f64,
    gamma_threshold_percent: f64,
    dd_threshold_percent: f64,
    dd_low_gradient_only: i32,
    gradient_threshold: f64,
    gamma_cap: f64,
    steps_per_dta: f64,
) {
    state().p = Params {
        dd_percent,
        dta_mm,
        local: local != 0,
        norm_dose,
        gamma_threshold_percent,
        dd_threshold_percent,
        dd_low_gradient_only: dd_low_gradient_only != 0,
        gradient_threshold,
        gamma_cap,
        steps_per_dta,
    };
}

#[no_mangle]
pub extern "C" fn reserve_range(blocks: usize) -> *mut f32 {
    reserve(&mut state().range, 3 * blocks)
}

#[no_mangle]
pub extern "C" fn set_range(nbx: usize, nby: usize, nbz: usize) {
    state().range_nb = [nbx, nby, nbz];
}

/// 比較元のスライス [base_k, base_k + slices) を置く領域
#[no_mangle]
pub extern "C" fn reserve_ref(n: usize) -> *mut f32 {
    reserve(&mut state().ref_data, n)
}

/// 比較元全体の形状と、置いたデータの先頭スライス
#[no_mangle]
pub extern "C" fn set_ref(nx: usize, ny: usize, nz: usize, sx: f64, sy: f64, sz: f64, ox: f64, oy: f64, oz: f64, base_k: usize) {
    let st = state();
    st.ref_geom = Geom { n: [nx, ny, nz], s: [sx, sy, sz], o: [ox, oy, oz] };
    st.ref_base_k = base_k;
}

#[no_mangle]
pub extern "C" fn reserve_eval(n: usize) -> *mut f32 {
    reserve(&mut state().eval_data, n)
}

/// 比較先全体の形状と、置いたデータの先頭スライス
#[no_mangle]
pub extern "C" fn set_eval(nx: usize, ny: usize, nz: usize, sx: f64, sy: f64, sz: f64, ox: f64, oy: f64, oz: f64, base_k: usize) {
    let st = state();
    st.eval_geom = Geom { n: [nx, ny, nz], s: [sx, sy, sz], o: [ox, oy, oz] };
    st.eval_base_k = base_k;
}

// ───────── 三線形補間 (volume.ts の createSampler と同じ) ─────────

struct Sampler<'a> {
    data: &'a [f32],
    /// data の先頭が全体の何番目のボクセルか (base_k スライス分)
    base: usize,
    o: [f64; 3],
    inv: [f64; 3],
    m: [f64; 3],
    last: [usize; 3],
    nx: usize,
    sxy: usize,
    di: usize,
    dj: usize,
    dk: usize,
}

const EPS: f64 = 1e-6;

impl<'a> Sampler<'a> {
    fn new(g: &Geom, data: &'a [f32], base_k: usize) -> Sampler<'a> {
        let [nx, ny, nz] = g.n;
        Sampler {
            data,
            base: base_k * nx * ny,
            o: g.o,
            inv: [1.0 / g.s[0], 1.0 / g.s[1], 1.0 / g.s[2]],
            m: [nx as f64 - 1.0 + EPS, ny as f64 - 1.0 + EPS, nz as f64 - 1.0 + EPS],
            last: [nx.saturating_sub(2), ny.saturating_sub(2), nz.saturating_sub(2)],
            nx,
            sxy: nx * ny,
            di: usize::from(nx > 1),
            dj: if ny > 1 { nx } else { 0 },
            dk: if nz > 1 { nx * ny } else { 0 },
        }
    }

    #[inline(always)]
    fn sample(&self, x: f64, y: f64, z: f64) -> f64 {
        let fx = (x - self.o[0]) * self.inv[0];
        let fy = (y - self.o[1]) * self.inv[1];
        let fz = (z - self.o[2]) * self.inv[2];
        // NaN もここで弾かれる
        if !(fx >= -EPS && fy >= -EPS && fz >= -EPS && fx <= self.m[0] && fy <= self.m[1] && fz <= self.m[2]) {
            return f64::NAN;
        }
        let i0 = if fx <= 0.0 { 0 } else { (fx as usize).min(self.last[0]) };
        let j0 = if fy <= 0.0 { 0 } else { (fy as usize).min(self.last[1]) };
        let k0 = if fz <= 0.0 { 0 } else { (fz as usize).min(self.last[2]) };
        let tx = fx - i0 as f64;
        let ty = fy - j0 as f64;
        let tz = fz - k0 as f64;
        // 呼び出し側 (JS) が探索に必要な範囲のスライスを渡すので、base 以上で data の範囲内
        let b = i0 + self.nx * j0 + self.sxy * k0 - self.base;
        let d = self.data;
        let (di, dj, dk) = (self.di, self.dj, self.dk);
        // 境界は上で確かめているので添字は範囲内
        let c = |o: usize| unsafe { *d.get_unchecked(b + o) as f64 };
        let c000 = c(0);
        let c100 = c(di);
        let c010 = c(dj);
        let c110 = c(dj + di);
        let c001 = c(dk);
        let c101 = c(dk + di);
        let c011 = c(dk + dj);
        let c111 = c(dk + dj + di);
        let c00 = c000 + (c100 - c000) * tx;
        let c10 = c010 + (c110 - c010) * tx;
        let c01 = c001 + (c101 - c001) * tx;
        let c11 = c011 + (c111 - c011) * tx;
        let c0 = c00 + (c10 - c00) * ty;
        let c1 = c01 + (c11 - c01) * ty;
        c0 + (c1 - c0) * tz
    }
}

// ───────── 本体 ─────────

const BLOCK: usize = 4;
const REFINE_LEVELS: usize = 3;
const REFINE_LEVELS_EDGE: usize = 7;

#[inline(always)]
fn diff(d: &[f32], idx: usize, pos: usize, len: usize, stride: usize, h: f64) -> f64 {
    if len < 2 {
        0.0
    } else if pos == 0 {
        (d[idx + stride] as f64 - d[idx] as f64) / h
    } else if pos == len - 1 {
        (d[idx] as f64 - d[idx - stride] as f64) / h
    } else {
        (d[idx + stride] as f64 - d[idx - stride] as f64) / (2.0 * h)
    }
}

#[inline(always)]
fn block_of(pos: f64, o: f64, sp: f64, len: usize, lower: bool) -> usize {
    let f = (pos - o) / sp;
    let v = if lower { f.floor() } else { f.ceil() };
    let clamped = v.max(0.0).min((len - 1) as f64);
    clamped as usize / BLOCK
}

/// 昇順の配列 a で、a[m] >= v となる最初の m (1 以上)
fn first_at_least(a: &[f32], v: f64) -> usize {
    let (mut lo, mut hi) = (1usize, a.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        if (a[mid] as f64) < v {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

/// 比較元のスライス [k0, k1) を計算する。戻り値は結果の先頭のポインタで、
/// gamma, dd, dta, grad, evalOnRef が (k1 − k0)·nx·ny 個ずつ並ぶ。
#[no_mangle]
pub extern "C" fn compute(k0: usize, k1: usize) -> *const f32 {
    let st = state();
    let p = st.p;
    let r = st.ref_geom;
    let [nx, ny, nz] = r.n;
    let [sx, sy, sz] = r.s;
    let [ox, oy, oz] = r.o;
    let sxy = nx * ny;
    let n = (k1 - k0) * sxy;
    st.out.clear();
    st.out.resize(5 * n, 0.0);
    let (gamma, rest) = st.out.split_at_mut(n);
    let (dd, rest) = rest.split_at_mut(n);
    let (dta, rest) = rest.split_at_mut(n);
    let (grad, eval_on_ref) = rest.split_at_mut(n);

    let rd = &st.ref_data[..];
    let rbase = st.ref_base_k * sxy;
    let e = st.eval_geom;
    let ev = Sampler::new(&e, &st.eval_data[..], st.eval_base_k);
    let n_off = st.n_off;
    let (off_x, rest) = st.off.split_at(n_off);
    let (off_y, rest) = rest.split_at(n_off);
    let (off_z, rest) = rest.split_at(n_off);
    let (off_r2, off_rn) = rest.split_at(n_off);
    let nbr = &st.nbr[..];
    let step_n = st.step_n;
    let diffs = &mut st.diffs;
    let stamp = &mut st.stamp;
    let [nbx, nby, nbz] = st.range_nb;
    let blocks = nbx * nby * nbz;
    let (rmin, rest) = st.range.split_at(blocks);
    let (rmax, rlip) = rest.split_at(blocks);

    let norm = p.norm_dose;
    let gamma_thr = p.gamma_threshold_percent / 100.0 * norm;
    let dd_thr = p.dd_threshold_percent / 100.0 * norm;
    let grad_thr = p.gradient_threshold;
    let grad_scale = 100.0 / norm;
    let global_dd = p.dd_percent / 100.0 * norm;
    let local_frac = p.dd_percent / 100.0;
    let cap2 = p.gamma_cap * p.gamma_cap;
    let refine_limit = (p.gamma_cap + 1.0 / p.steps_per_dta).powi(2);
    let dta_mm = p.dta_mm;
    let step = dta_mm / p.steps_per_dta;
    let inv_dta2 = 1.0 / (dta_mm * dta_mm);
    let radius = p.gamma_cap * dta_mm;

    let mut out = 0usize;
    for k in k0..k1 {
        let z = oz + k as f64 * sz;
        for j in 0..ny {
            let y = oy + j as f64 * sy;
            for i in 0..nx {
                let x = ox + i as f64 * sx;
                let idx = i + nx * j + sxy * k - rbase;
                let dr = rd[idx] as f64;
                let o = out;
                out += 1;

                gamma[o] = f32::NAN;
                dd[o] = f32::NAN;
                dta[o] = f32::NAN;

                let gx = diff(rd, idx, i, nx, 1, sx);
                let gy = diff(rd, idx, j, ny, nx, sy);
                let gz = diff(rd, idx, k, nz, sxy, sz);
                let g = (gx * gx + gy * gy + gz * gz).sqrt() * grad_scale;
                grad[o] = g as f32;

                let de0 = ev.sample(x, y, z);
                eval_on_ref[o] = de0 as f32;
                if de0.is_nan() {
                    continue;
                }

                if dr >= dd_thr && (!p.dd_low_gradient_only || g < grad_thr) {
                    dd[o] = (de0 - dr) as f32;
                }

                if dr < gamma_thr || dr <= 0.0 {
                    continue;
                }

                // 探索球内で比較先が取りうる線量範囲と、勾配の上限
                let mut emin = f32::INFINITY;
                let mut emax = f32::NEG_INFINITY;
                let mut lip = 0f32;
                let bi0 = block_of(x - radius, e.o[0], e.s[0], e.n[0], true);
                let bi1 = block_of(x + radius, e.o[0], e.s[0], e.n[0], false);
                let bj0 = block_of(y - radius, e.o[1], e.s[1], e.n[1], true);
                let bj1 = block_of(y + radius, e.o[1], e.s[1], e.n[1], false);
                let bk0 = block_of(z - radius, e.o[2], e.s[2], e.n[2], true);
                let bk1 = block_of(z + radius, e.o[2], e.s[2], e.n[2], false);
                for bk in bk0..=bk1 {
                    for bj in bj0..=bj1 {
                        let base = nbx * (bj + nby * bk);
                        for bi in bi0..=bi1 {
                            let b = base + bi;
                            if rmin[b] < emin {
                                emin = rmin[b];
                            }
                            if rmax[b] > emax {
                                emax = rmax[b];
                            }
                            if rlip[b] > lip {
                                lip = rlip[b];
                            }
                        }
                    }
                }
                let (emin, emax) = (emin as f64, emax as f64);
                let gap = if dr < emin {
                    emin - dr
                } else if dr > emax {
                    dr - emax
                } else {
                    0.0
                };

                let delta_d = if p.local { local_frac * dr } else { global_dd };
                let inv_d2 = 1.0 / (delta_d * delta_d);
                // 探索点のガンマ² の下限 f(r) = r² + max(gap, T − L·r)² / ΔD² (gamma.ts と同じ)
                let tt = (de0 - dr).abs();
                let ll = lip as f64 * dta_mm;
                let mut r_opt = 0.0f64;
                if ll > 0.0 {
                    let r0 = (inv_d2 * ll * tt) / (1.0 + inv_d2 * ll * ll);
                    r_opt = if tt - ll * r0 >= gap { r0 } else { ((tt - gap) / ll).max(0.0) };
                }
                let mut best = (de0 - dr) * (de0 - dr) * inv_d2;
                let (mut bx, mut by, mut bz) = (0.0f64, 0.0f64, 0.0f64);

                st.gen = st.gen.wrapping_add(1);
                let gen = st.gen;
                diffs[0] = (de0 - dr) as f32;
                stamp[0] = gen;
                let mut margin = 0.0f64;
                for m in 1..n_off {
                    let r2 = off_r2[m] as f64;
                    if r2 > cap2 {
                        break;
                    }
                    let mut rr = off_rn[m] as f64 - margin;
                    if rr < r_opt {
                        rr = r_opt;
                    }
                    let mut u = tt - ll * rr;
                    if u < gap {
                        u = gap;
                    }
                    if rr * rr + u * u * inv_d2 >= (if best < refine_limit { best } else { refine_limit }) {
                        break;
                    }
                    let (ox_, oy_, oz_) = (off_x[m] as f64, off_y[m] as f64, off_z[m] as f64);
                    let de = ev.sample(x + ox_, y + oy_, z + oz_);
                    if de.is_nan() {
                        continue;
                    }
                    let t = de - dr;
                    // TS 版は Float32Array に保持するので、ここでも f32 に丸めてそろえる
                    diffs[m] = t as f32;
                    stamp[m] = gen;
                    let g2 = r2 + t * t * inv_d2;
                    if g2 < best {
                        best = g2;
                        bx = ox_;
                        by = oy_;
                        bz = oz_;
                    }
                    if t == 0.0 {
                        continue;
                    }
                    let nb0 = 6 * m;
                    for q in 0..6 {
                        let nb = nbr[nb0 + q];
                        if nb < 0 {
                            continue;
                        }
                        let nb = nb as usize;
                        if stamp[nb] != gen {
                            continue;
                        }
                        let tn = diffs[nb] as f64;
                        if margin == 0.0 && (t - tn) * (t - tn) * inv_d2 > 1.0 {
                            margin = step_n;
                        }
                        if if t > 0.0 { tn > 0.0 } else { tn < 0.0 } {
                            continue;
                        }
                        let f = t / (t - tn);
                        let px = ox_ + (off_x[nb] as f64 - ox_) * f;
                        let py = oy_ + (off_y[nb] as f64 - oy_) * f;
                        let pz = oz_ + (off_z[nb] as f64 - oz_) * f;
                        let pr2 = (px * px + py * py + pz * pz) * inv_dta2;
                        if pr2 >= best {
                            continue;
                        }
                        let dc = ev.sample(x + px, y + py, z + pz);
                        if dc.is_nan() {
                            continue;
                        }
                        let tc = dc - dr;
                        let gc = pr2 + tc * tc * inv_d2;
                        if gc < best {
                            best = gc;
                            bx = px;
                            by = py;
                            bz = pz;
                        }
                    }
                }

                if best > 0.0 && best < refine_limit {
                    let (mut cx, mut cy, mut cz) = (bx, by, bz);
                    let mut h = step * 0.5;
                    let mut edge = false;
                    let mut lvl = 0usize;
                    while lvl < if edge { REFINE_LEVELS_EDGE } else { REFINE_LEVELS } {
                        let (mut nx_, mut ny_, mut nz_) = (cx, cy, cz);
                        for c in -1i32..=1 {
                            for b in -1i32..=1 {
                                for a in -1i32..=1 {
                                    if a == 0 && b == 0 && c == 0 {
                                        continue;
                                    }
                                    let px = cx + a as f64 * h;
                                    let py = cy + b as f64 * h;
                                    let pz = cz + c as f64 * h;
                                    let r2 = (px * px + py * py + pz * pz) * inv_dta2;
                                    if r2 >= best {
                                        continue;
                                    }
                                    let de = ev.sample(x + px, y + py, z + pz);
                                    if de.is_nan() {
                                        edge = true;
                                        continue;
                                    }
                                    let t = de - dr;
                                    let g2 = r2 + t * t * inv_d2;
                                    if g2 < best {
                                        best = g2;
                                        nx_ = px;
                                        ny_ = py;
                                        nz_ = pz;
                                    }
                                }
                            }
                        }
                        cx = nx_;
                        cy = ny_;
                        cz = nz_;
                        lvl += 1;
                        h *= 0.5;
                    }
                }
                gamma[o] = if best >= cap2 { p.gamma_cap as f32 } else { best.sqrt() as f32 };

                // DTA (高勾配領域のみ)
                if g >= grad_thr {
                    let s0 = de0 - dr;
                    if s0 == 0.0 {
                        dta[o] = 0.0;
                    } else if gap > 0.0 || ll == 0.0 || tt / ll > p.gamma_cap {
                        dta[o] = f32::INFINITY;
                    } else {
                        let mut found = f64::INFINITY;
                        for m in first_at_least(off_rn, tt / ll)..n_off {
                            let de = ev.sample(x + off_x[m] as f64, y + off_y[m] as f64, z + off_z[m] as f64);
                            if de.is_nan() {
                                continue;
                            }
                            let s = de - dr;
                            if s == 0.0 || (s > 0.0) != (s0 > 0.0) {
                                let dist = (off_r2[m] as f64).sqrt() * dta_mm;
                                found = dist * (s0 / (s0 - s));
                                break;
                            }
                        }
                        dta[o] = found as f32;
                    }
                }
            }
        }
    }
    st.out.as_ptr()
}
