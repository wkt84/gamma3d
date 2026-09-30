import { buildRangeGrid, computeSlab, type SlabResult } from '../core/gamma.ts';
import { WasmKernel } from '../core/wasm-kernel.ts';
import type { Engine, FromWorker, ToWorker } from './protocol.ts';

type Compute = (k0: number, k1: number) => SlabResult;

/** 初期化 (wasm の読み込みを含む) が終わると、スライスを計算する関数になる */
let ready: Promise<{ compute: Compute; engine: Engine }> | null = null;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

async function init(msg: Extract<ToWorker, { type: 'init' }>): Promise<{ compute: Compute; engine: Engine }> {
  const { ref, ev, params, offsets } = msg;
  const evalRange = buildRangeGrid(ev);
  if (msg.wasmUrl) {
    try {
      const bytes = await (await fetch(msg.wasmUrl)).arrayBuffer();
      const kernel = await WasmKernel.create(bytes);
      kernel.setup(ref, ev, params, offsets, evalRange);
      return { compute: (k0, k1) => kernel.computeSlab(k0, k1), engine: 'wasm' };
    } catch (err) {
      // wasm が使えない環境では TypeScript 版で計算する (結果は同じ)
      console.warn('WebAssembly kernel is unavailable; falling back to TypeScript.', err);
    }
  }
  return { compute: (k0, k1) => computeSlab(ref, ev, params, offsets, k0, k1, evalRange), engine: 'ts' };
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      ready = init(msg);
      return;
    }
    if (!ready) throw new Error('worker is not initialized');
    const { compute, engine } = await ready;
    const slab = compute(msg.k0, msg.k1);
    post({ type: 'result', slab, engine }, [slab.gamma.buffer, slab.dd.buffer, slab.dta.buffer, slab.grad.buffer, slab.evalOnRef.buffer]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
