import type { AnalysisParams, SearchOffsets, SlabResult } from '../core/gamma.ts';
import type { Volume } from '../core/volume.ts';

export type ToWorker =
  | { type: 'init'; ref: Volume; ev: Volume; params: AnalysisParams; offsets: SearchOffsets }
  | { type: 'job'; k0: number; k1: number };

export type FromWorker = { type: 'result'; slab: SlabResult } | { type: 'error'; message: string };
