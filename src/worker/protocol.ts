import type { AnalysisParams, SearchOffsets, SlabResult } from '../core/gamma.ts';
import type { Volume } from '../core/volume.ts';

/** 計算に使った実装 */
export type Engine = 'wasm' | 'ts';

export type ToWorker =
  | {
      type: 'init';
      ref: Volume;
      ev: Volume;
      params: AnalysisParams;
      offsets: SearchOffsets;
      /** WebAssembly カーネルの URL。null なら TypeScript 版で計算する */
      wasmUrl: string | null;
    }
  | { type: 'job'; k0: number; k1: number };

export type FromWorker = { type: 'result'; slab: SlabResult; engine: Engine } | { type: 'error'; message: string };
