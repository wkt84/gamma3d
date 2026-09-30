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
export async function runAnalysis(
  ref: Volume,
  ev: Volume,
  params: AnalysisParams,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<AnalysisResult> {
  return (await runAnalyses(ref, ev, [params], onProgress, signal))[0];
}

/**
 * 複数の解析条件をまとめて計算する。Worker の起動・線量の受け渡し・ブロックの範囲表・wasm の読み込みは
 * 1 回で済ませ、条件ごとには探索表と条件だけを渡す。
 *
 * 条件は ddPercent / dtaMm だけが違う前提で、条件によらない dd・grad・evalOnRef は最初の条件の結果を
 * 全条件で共有する (条件ごとに持つのは gamma と dta だけ)。
 */
export function runAnalyses(
  refIn: Volume,
  evIn: Volume,
  paramsList: AnalysisParams[],
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<AnalysisResult[]> {
  const t0 = performance.now();
  const ref = shareable(refIn);
  const ev = shareable(evIn);
  const sharedMemory = ref.data.buffer instanceof SharedArrayBuffer;
  const offsetsList = paramsList.map((p) => buildSearchOffsets(p.dtaMm, p.stepsPerDta, p.gammaCap));

  const [nx, ny, nz] = ref.dims;
  const plane = nx * ny;
  const total = plane * nz;
  const nWorkers = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16, nz));
  const chunk = Math.max(1, Math.floor(nz / (nWorkers * 6)));
  const slices: [number, number][] = [];
  for (let k = 0; k < nz; k += chunk) slices.push([k, Math.min(nz, k + chunk)]);
  // 条件ごとにまとめて並べる (Worker が wasm の条件を切り替える回数を減らすため)
  const jobs = paramsList.flatMap((_, id) => slices.map(([k0, k1]) => ({ id, k0, k1 })));

  const shared = { dd: new Float32Array(total), grad: new Float32Array(total), evalOnRef: new Float32Array(total) };
  const perCondition = paramsList.map(() => ({ gamma: new Float32Array(total), dta: new Float32Array(total) }));

  return new Promise<AnalysisResult[]>((resolve, reject) => {
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
      const elapsedMs = performance.now() - t0;
      const engine = engines.size === 1 ? [...engines][0] : 'mixed';
      resolve(
        paramsList.map((params, id) => ({
          params,
          ref: refIn,
          ...shared,
          ...perCondition[id],
          elapsedMs,
          workers: workers.length,
          sharedMemory,
          searchPoints: offsetsList[id].r2.length,
          engine,
        })),
      );
    };
    const onAbort = () => finish(new AnalysisCancelled());
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) return onAbort();

    const dispatch = (w: Worker) => {
      if (next >= jobs.length) return;
      w.postMessage({ type: 'job', ...jobs[next++] } satisfies ToWorker);
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
        perCondition[msg.id].gamma.set(s.gamma, at);
        perCondition[msg.id].dta.set(s.dta, at);
        if (msg.id === 0) {
          shared.dd.set(s.dd, at);
          shared.grad.set(s.grad, at);
          shared.evalOnRef.set(s.evalOnRef, at);
        }
        done++;
        onProgress(done / jobs.length);
        if (done === jobs.length) finish();
        else dispatch(w);
      };
      w.onerror = (e) => finish(new Error(e.message || m().run.workerError));
      w.postMessage({ type: 'init', ref, ev, wasmUrl: url } satisfies ToWorker);
      paramsList.forEach((params, id) => w.postMessage({ type: 'configure', id, params, offsets: offsetsList[id] } satisfies ToWorker));
      dispatch(w);
    }
  });
}
