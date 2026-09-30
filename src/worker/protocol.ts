import type { AnalysisParams, SearchOffsets, SlabResult } from '../core/gamma.ts';
import type { Volume } from '../core/volume.ts';

/** 計算に使った実装 */
export type Engine = 'wasm' | 'ts';

/**
 * Worker への指示。init (解析ごとに 1 回) → configure (条件ごと) → job (スライスごと)。
 * 複数の条件をまとめて計算するときも、線量の受け渡し・ブロックの範囲表・wasm の読み込みは 1 回で済む。
 */
export type ToWorker =
  | {
      type: 'init';
      ref: Volume;
      ev: Volume;
      /** WebAssembly カーネルの URL。null なら TypeScript 版で計算する */
      wasmUrl: string | null;
    }
  | { type: 'configure'; id: number; params: AnalysisParams; offsets: SearchOffsets }
  | { type: 'job'; id: number; k0: number; k1: number };

export type FromWorker = { type: 'result'; id: number; slab: SlabResult; engine: Engine } | { type: 'error'; message: string };
