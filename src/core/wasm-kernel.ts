import type { AnalysisParams, RangeGrid, SearchOffsets, SlabResult } from './gamma.ts';
import type { Volume } from './volume.ts';

/**
 * WebAssembly 版のガンマ探索カーネル (wasm/src/lib.rs) を呼び出すラッパー。
 * computeSlab (gamma.ts) と同じ結果を返す (test/wasm.test.ts で一致を確かめている)。
 *
 * ジョブごとに、比較元はそのスライスと前後 1 枚、比較先は探索に必要な z の範囲だけを
 * wasm のメモリへコピーする。wasm のメモリは縮まないので、解析ごとにインスタンスを作り直す。
 */

interface Exports {
  memory: WebAssembly.Memory;
  reserve_offsets(n: number): number;
  reserve_nbr(n: number): number;
  set_offsets(n: number, stepN: number): void;
  set_params(
    ddPercent: number,
    dtaMm: number,
    local: number,
    normDose: number,
    gammaThresholdPercent: number,
    ddThresholdPercent: number,
    ddLowGradientOnly: number,
    gradientThreshold: number,
    gammaCap: number,
    stepsPerDta: number,
  ): void;
  reserve_range(blocks: number): number;
  set_range(nbx: number, nby: number, nbz: number): void;
  reserve_ref(n: number): number;
  set_ref(nx: number, ny: number, nz: number, sx: number, sy: number, sz: number, ox: number, oy: number, oz: number, baseK: number): void;
  reserve_eval(n: number): number;
  set_eval(nx: number, ny: number, nz: number, sx: number, sy: number, sz: number, ox: number, oy: number, oz: number, baseK: number): void;
  compute(k0: number, k1: number): number;
}

export class WasmKernel {
  private readonly ex: Exports;
  private ref: Volume | null = null;
  private ev: Volume | null = null;
  private params: AnalysisParams | null = null;

  private constructor(ex: Exports) {
    this.ex = ex;
  }

  /** wasm のバイト列 (またはその取得) からカーネルを作る */
  static async create(source: BufferSource | Promise<Response>): Promise<WasmKernel> {
    const { instance } =
      source instanceof Promise
        ? await WebAssembly.instantiateStreaming(source, {})
        : await WebAssembly.instantiate(source as BufferSource, {});
    return new WasmKernel(instance.exports as unknown as Exports);
  }

  private f32(ptr: number, n: number): Float32Array {
    return new Float32Array(this.ex.memory.buffer, ptr, n);
  }

  /** 線量と、比較先全体のブロックの範囲表 (gamma.ts の buildRangeGrid) を設定する (解析ごとに 1 回) */
  setVolumes(ref: Volume, ev: Volume, evalRange: RangeGrid): void {
    const ex = this.ex;
    const blocks = evalRange.min.length;
    const rp = ex.reserve_range(blocks);
    const range = this.f32(rp, 3 * blocks);
    range.set(evalRange.min, 0);
    range.set(evalRange.max, blocks);
    range.set(evalRange.lip, 2 * blocks);
    ex.set_range(...evalRange.nb);
    this.ref = ref;
    this.ev = ev;
  }

  /** 解析条件と探索表 (gamma.ts の buildSearchOffsets) を設定する (条件ごと) */
  configure(p: AnalysisParams, offsets: SearchOffsets): void {
    const ex = this.ex;
    const n = offsets.r2.length;
    const op = ex.reserve_offsets(n);
    const off = this.f32(op, 5 * n);
    off.set(offsets.x, 0);
    off.set(offsets.y, n);
    off.set(offsets.z, 2 * n);
    off.set(offsets.r2, 3 * n);
    off.set(offsets.rn, 4 * n);
    const np = ex.reserve_nbr(n);
    new Int32Array(ex.memory.buffer, np, 6 * n).set(offsets.nbr);
    ex.set_offsets(n, offsets.stepN);
    ex.set_params(
      p.ddPercent,
      p.dtaMm,
      p.local ? 1 : 0,
      p.normDoseGy,
      p.gammaThresholdPercent,
      p.ddThresholdPercent,
      p.ddLowGradientOnly ? 1 : 0,
      p.gradientThresholdPercentPerMm,
      p.gammaCap,
      p.stepsPerDta,
    );
    this.params = p;
  }

  /** setVolumes と configure をまとめて行う */
  setup(ref: Volume, ev: Volume, p: AnalysisParams, offsets: SearchOffsets, evalRange: RangeGrid): void {
    this.setVolumes(ref, ev, evalRange);
    this.configure(p, offsets);
  }

  /** 比較元のスライス [k0, k1) を計算する */
  computeSlab(k0: number, k1: number): SlabResult {
    const { ex, ref, ev, params: p } = this;
    if (!ref || !ev || !p) throw new Error('WasmKernel: setup() has not been called');
    const [nx, ny, nz] = ref.dims;
    const sxy = nx * ny;

    // 比較元: 勾配の計算に前後 1 枚ずつ必要
    const ka = Math.max(0, k0 - 1);
    const kb = Math.min(nz, k1 + 1);
    const rp = ex.reserve_ref((kb - ka) * sxy);
    this.f32(rp, (kb - ka) * sxy).set(ref.data.subarray(ka * sxy, kb * sxy));
    ex.set_ref(nx, ny, nz, ...ref.spacing, ...ref.origin, ka);

    // 比較先: 探索半径 + 局所詰めのずれ (1 刻み未満) + 補間の 1 セルを余裕として含む z の範囲
    const [enx, eny, enz] = ev.dims;
    const esxy = enx * eny;
    const esz = ev.spacing[2];
    const reach = p.gammaCap * p.dtaMm + p.dtaMm / p.stepsPerDta;
    const zLo = ref.origin[2] + k0 * ref.spacing[2] - reach;
    const zHi = ref.origin[2] + (k1 - 1) * ref.spacing[2] + reach;
    const ea = Math.max(0, Math.min(enz - 1, Math.floor((zLo - ev.origin[2]) / esz) - 2));
    const eb = Math.max(ea + 1, Math.min(enz, Math.ceil((zHi - ev.origin[2]) / esz) + 3));
    const ep = ex.reserve_eval((eb - ea) * esxy);
    this.f32(ep, (eb - ea) * esxy).set(ev.data.subarray(ea * esxy, eb * esxy));
    ex.set_eval(enx, eny, enz, ...ev.spacing, ...ev.origin, ea);

    const n = (k1 - k0) * sxy;
    const out = ex.compute(k0, k1);
    // compute の中でメモリが増えることがあるので、ビューは呼び出し後に作る
    const all = this.f32(out, 5 * n);
    return {
      k0,
      k1,
      gamma: all.slice(0, n),
      dd: all.slice(n, 2 * n),
      dta: all.slice(2 * n, 3 * n),
      grad: all.slice(3 * n, 4 * n),
      evalOnRef: all.slice(4 * n, 5 * n),
    };
  }
}
