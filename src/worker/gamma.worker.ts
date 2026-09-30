import { buildRangeGrid, computeSlab, type AnalysisParams, type RangeGrid, type SearchOffsets } from '../core/gamma.ts';
import type { Volume } from '../core/volume.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

let state: { ref: Volume; ev: Volume; params: AnalysisParams; offsets: SearchOffsets; evalRange: RangeGrid } | null = null;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      state = { ref: msg.ref, ev: msg.ev, params: msg.params, offsets: msg.offsets, evalRange: buildRangeGrid(msg.ev) };
      return;
    }
    if (!state) throw new Error('worker is not initialized');
    const slab = computeSlab(state.ref, state.ev, state.params, state.offsets, msg.k0, msg.k1, state.evalRange);
    post({ type: 'result', slab }, [slab.gamma.buffer, slab.dd.buffer, slab.dta.buffer, slab.grad.buffer, slab.evalOnRef.buffer]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
