import { buildSearchOffsets, type AnalysisParams } from './gamma.ts';
import type { Volume } from './volume.ts';
import { LocalizedError, m } from '../i18n/index.ts';
import type { Engine, FromWorker, ToWorker } from '../worker/protocol.ts';

export interface AnalysisResult {
  params: AnalysisParams;
  ref: Volume;
  gamma: Float32Array;
  dd: Float32Array;
  dta: Float32Array;
  grad: Float32Array;
  evalOnRef: Float32Array;
  elapsedMs: number;
  workers: number;
  sharedMemory: boolean;
  searchPoints: number;
  /** 計算に使った実装。Worker によって違えば 'mixed' */
  engine: Engine | 'mixed';
}

/**
 * 使う実装。URL の ?engine=ts で TypeScript 版に固定できる (切り分け・比較用)。
 * 既定は WebAssembly (読み込めなければ Worker 側で TypeScript 版になる)。
 */
function wasmUrl(): string | null {
  const forced = new URLSearchParams(globalThis.location?.search ?? '').get('engine');
  if (forced === 'ts') return null;
  return new URL('../wasm/gamma3d_kernel.wasm', import.meta.url).href;
}

export class AnalysisCancelled extends LocalizedError {
  constructor() {
    super((t) => t.run.cancelled);
  }
}

/** crossOriginIsolated なら SharedArrayBuffer に載せ替え、Worker 間でコピーせずに共有する。 */
function shareable(v: Volume): Volume {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') return v;
  const data = new Float32Array(new SharedArrayBuffer(v.data.byteLength));
  data.set(v.data);
  return { ...v, data };
}

/**
 * 比較元グリッドのスライスを小さな単位に分け、Worker プールで並列に計算する。
 */
export function runAnalysis(
  refIn: Volume,
  evIn: Volume,
  params: AnalysisParams,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<AnalysisResult> {
  const t0 = performance.now();
  const ref = shareable(refIn);
  const ev = shareable(evIn);
  const sharedMemory = ref.data.buffer instanceof SharedArrayBuffer;
  const offsets = buildSearchOffsets(params.dtaMm, params.stepsPerDta, params.gammaCap);

  const [nx, ny, nz] = ref.dims;
  const plane = nx * ny;
  const total = plane * nz;
  const nWorkers = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16, nz));
  const chunk = Math.max(1, Math.floor(nz / (nWorkers * 6)));
  const jobs: [number, number][] = [];
  for (let k = 0; k < nz; k += chunk) jobs.push([k, Math.min(nz, k + chunk)]);

  const out = {
    gamma: new Float32Array(total),
    dd: new Float32Array(total),
    dta: new Float32Array(total),
    grad: new Float32Array(total),
    evalOnRef: new Float32Array(total),
  };

  return new Promise<AnalysisResult>((resolve, reject) => {
    const workers: Worker[] = [];
    let next = 0;
    let done = 0;
    let finished = false;
    const engines = new Set<Engine>();
    const url = wasmUrl();

    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      workers.forEach((w) => w.terminate());
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        reject(err);
        return;
      }
      resolve({
        params,
        ref: refIn,
        ...out,
        elapsedMs: performance.now() - t0,
        workers: workers.length,
        sharedMemory,
        searchPoints: offsets.r2.length,
        engine: engines.size === 1 ? [...engines][0] : 'mixed',
      });
    };
    const onAbort = () => finish(new AnalysisCancelled());
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) return onAbort();

    const dispatch = (w: Worker) => {
      if (next >= jobs.length) return;
      const [k0, k1] = jobs[next++];
      w.postMessage({ type: 'job', k0, k1 } satisfies ToWorker);
    };

    for (let n = 0; n < nWorkers; n++) {
      const w = new Worker(new URL('../worker/gamma.worker.ts', import.meta.url), { type: 'module' });
      workers.push(w);
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data;
        if (msg.type === 'error') return finish(new Error(msg.message));
        engines.add(msg.engine);
        const s = msg.slab;
        const at = s.k0 * plane;
        out.gamma.set(s.gamma, at);
        out.dd.set(s.dd, at);
        out.dta.set(s.dta, at);
        out.grad.set(s.grad, at);
        out.evalOnRef.set(s.evalOnRef, at);
        done++;
        onProgress(done / jobs.length);
        if (done === jobs.length) finish();
        else dispatch(w);
      };
      w.onerror = (e) => finish(new Error(e.message || m().run.workerError));
      w.postMessage({ type: 'init', ref, ev, params, offsets, wasmUrl: url } satisfies ToWorker);
      dispatch(w);
    }
  });
}
