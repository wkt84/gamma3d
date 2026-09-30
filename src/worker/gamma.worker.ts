import { buildRangeGrid, computeSlab, type AnalysisParams, type RangeGrid, type SearchOffsets } from '../core/gamma.ts';
import type { Volume } from '../core/volume.ts';
import { WasmKernel } from '../core/wasm-kernel.ts';
import type { Engine, FromWorker, ToWorker } from './protocol.ts';

interface Context {
  ref: Volume;
  ev: Volume;
  evalRange: RangeGrid;
  kernel: WasmKernel | null;
}

/** init (wasm の読み込みを含む) の完了 */
let ready: Promise<Context> | null = null;
const configs = new Map<number, { params: AnalysisParams; offsets: SearchOffsets }>();
/** wasm に今設定してある条件 */
let active = -1;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

async function init(msg: Extract<ToWorker, { type: 'init' }>): Promise<Context> {
  const { ref, ev } = msg;
  const evalRange = buildRangeGrid(ev);
  let kernel: WasmKernel | null = null;
  if (msg.wasmUrl) {
    try {
      const bytes = await (await fetch(msg.wasmUrl)).arrayBuffer();
      kernel = await WasmKernel.create(bytes);
      kernel.setVolumes(ref, ev, evalRange);
    } catch (err) {
      // wasm が使えない環境では TypeScript 版で計算する (結果は同じ)
      console.warn('WebAssembly kernel is unavailable; falling back to TypeScript.', err);
      kernel = null;
    }
  }
  return { ref, ev, evalRange, kernel };
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      ready = init(msg);
      configs.clear();
      active = -1;
      return;
    }
    if (msg.type === 'configure') {
      configs.set(msg.id, { params: msg.params, offsets: msg.offsets });
      return;
    }
    if (!ready) throw new Error('worker is not initialized');
    const ctx = await ready;
    const cfg = configs.get(msg.id);
    if (!cfg) throw new Error(`worker is not configured for ${msg.id}`);
    let engine: Engine;
    let slab;
    if (ctx.kernel) {
      if (active !== msg.id) {
        ctx.kernel.configure(cfg.params, cfg.offsets);
        active = msg.id;
      }
      slab = ctx.kernel.computeSlab(msg.k0, msg.k1);
      engine = 'wasm';
    } else {
      slab = computeSlab(ctx.ref, ctx.ev, cfg.params, cfg.offsets, msg.k0, msg.k1, ctx.evalRange);
      engine = 'ts';
    }
    post({ type: 'result', id: msg.id, slab, engine }, [slab.gamma.buffer, slab.dd.buffer, slab.dta.buffer, slab.grad.buffer, slab.evalOnRef.buffer]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
