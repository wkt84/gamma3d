import { judge, type ActionLevels } from '../core/judgment.ts';
import type { AnalysisResult } from '../core/runner.ts';
import type { Vec3 } from '../core/volume.ts';
import { formatScale, type DoseScale, type DoseSet } from '../dicom/group.ts';
import type { RtPlan } from '../dicom/rtplan.ts';
import { text, type Msg } from '../i18n/index.ts';
import { derive } from '../ui/results.ts';
import { toNrrd } from './nrrd.ts';
import { zip, type ZipEntry } from './zip.ts';

/**
 * 解析結果の書き出し。統計値と解析条件は JSON と CSV (1 条件 1 行) に、
 * γ・線量差・DTA などのマップは NRRD にして ZIP にまとめる。
 * キーと列名は照合・集計に使うため英語で固定し、言語の設定によらない (ラベル類の値だけ表示中の言語になる)。
 */

export interface ExportSide {
  set: DoseSet;
  scale: DoseScale;
  plan: RtPlan | null;
}

export interface ExportInput {
  version: string;
  createdAt: Date;
  ref: ExportSide;
  ev: ExportSide;
  /** 比較先の平行移動 (mm) */
  shift: Vec3;
  levels: ActionLevels | null;
  /** 計算した条件すべて (一括計算なら 4 条件) と、表示中の結果 (マップはこの結果を書き出す) */
  results: AnalysisResult[];
  shown: AnalysisResult;
  warnings: Msg[];
  includePatient: boolean;
}

const FILE_KIND = 'gamma3d-results';
const FILE_VERSION = 1;

/** NaN・Infinity は JSON では null になる。CSV では空欄にする */
const finiteOrNull = (v: number): number | null => (Number.isFinite(v) ? v : null);

function side(s: ExportSide, includePatient: boolean) {
  const v = s.set.volume;
  return {
    label: text(s.set.label),
    kind: s.set.kind,
    files: s.set.doses.map((d) => d.fileName),
    ...(includePatient ? { patientId: s.set.patientId, patientName: s.set.patientName } : {}),
    frameOfReferenceUID: s.set.frameOfReferenceUID,
    planUID: s.set.planUID,
    plan: s.plan ? { label: s.plan.label || s.plan.name, fractions: s.plan.fractions } : null,
    scale: { numerator: s.scale.num, denominator: s.scale.den },
    grid: { dims: v.dims, spacingMm: v.spacing, originMm: v.origin },
  };
}

function resultEntries(input: ExportInput) {
  return input.results.map((r) => {
    const d = derive(r);
    const { elapsedMs, workers, sharedMemory, searchPoints, engine } = r;
    return {
      shown: r === input.shown,
      params: r.params,
      gamma: d.gamma,
      judgment: input.levels ? judge(d.gamma.passRate, input.levels) : null,
      dd: d.dd,
      dta: d.dta,
      computation: { elapsedMs, workers, sharedMemory, searchPoints, engine },
    };
  });
}

export function resultsJson(input: ExportInput): string {
  const data = {
    kind: FILE_KIND,
    version: FILE_VERSION,
    app: { name: 'Gamma3D', version: input.version },
    createdAt: input.createdAt.toISOString(),
    reference: side(input.ref, input.includePatient),
    evaluated: { ...side(input.ev, input.includePatient), shiftMm: input.shift },
    levels: input.levels,
    results: resultEntries(input),
    warnings: input.warnings.map(text),
  };
  return JSON.stringify(data, (_k, v) => (typeof v === 'number' ? finiteOrNull(v) : v), 2) + '\n';
}

/** CSV の 1 セル (RFC 4180: カンマ・引用符・改行を含む値は引用符で囲む) */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const s = String(v);
  // \x22 は引用符 (")
  return /[\x22,\r\n]/.test(s) ? `"${s.replace(/\x22/g, '""')}"` : s;
}

export function resultsCsv(input: ExportInput): string {
  const entries = resultEntries(input);
  const common = {
    created_at: input.createdAt.toISOString(),
    app_version: input.version,
    ...(input.includePatient ? { patient_id: input.ref.set.patientId, patient_name: input.ref.set.patientName } : {}),
    ref_label: text(input.ref.set.label),
    eval_label: text(input.ev.set.label),
    ref_scale: formatScale(input.ref.scale),
    eval_scale: formatScale(input.ev.scale),
    shift_x_mm: input.shift[0],
    shift_y_mm: input.shift[1],
    shift_z_mm: input.shift[2],
  };
  const rows = entries.map((e) => {
    const p = e.params;
    return {
      criteria: `${p.ddPercent}%/${p.dtaMm}mm`,
      shown: e.shown,
      dd_percent: p.ddPercent,
      dta_mm: p.dtaMm,
      normalization: p.local ? 'local' : 'global',
      norm_dose_gy: p.normDoseGy,
      gamma_threshold_percent: p.gammaThresholdPercent,
      dd_threshold_percent: p.ddThresholdPercent,
      dd_low_gradient_only: p.ddLowGradientOnly,
      gradient_threshold_percent_per_mm: p.gradientThresholdPercentPerMm,
      gamma_cap: p.gammaCap,
      steps_per_dta: p.stepsPerDta,
      gamma_evaluated: e.gamma.evaluated,
      gamma_pass_rate: e.gamma.passRate,
      gamma_mean: e.gamma.mean,
      gamma_median: e.gamma.median,
      gamma_p99: e.gamma.p99,
      gamma_max: e.gamma.max,
      gamma_max_capped: e.gamma.maxCapped,
      judgment: e.judgment,
      tolerance_level: input.levels?.tolerance ?? null,
      action_level: input.levels?.action ?? null,
      dd_evaluated: e.dd.evaluated,
      dd_pass_rate: e.dd.passRate,
      dd_mean_percent: e.dd.meanPct,
      dd_sd_percent: e.dd.sdPct,
      dd_min_percent: e.dd.minPct,
      dd_max_percent: e.dd.maxPct,
      dta_evaluated: e.dta.evaluated,
      dta_pass_rate: e.dta.passRate,
      dta_not_found: e.dta.notFound,
      dta_mean_mm: e.dta.mean,
      dta_median_mm: e.dta.median,
      ...common,
    };
  });
  const header = Object.keys(rows[0]);
  // 先頭の BOM は、Excel で開いたときに UTF-8 (日本語のラベル) と認識させるため
  return '\ufeff' + [header.join(','), ...rows.map((r) => header.map((k) => csvCell(r[k as keyof typeof r])).join(','))].join('\r\n') + '\r\n';
}

/** DTA の「探索半径内に見つからない」点を NRRD では -1 にする (Infinity は表示ソフトで扱いにくいため) */
export const DTA_NOT_FOUND = -1;

/** 表示中の結果のマップ (NRRD) と、統計値 (results.json) を ZIP にまとめる */
export async function mapsZip(input: ExportInput): Promise<Uint8Array<ArrayBuffer>> {
  const r = input.shown;
  const p = r.params;
  const grid = r.ref;
  const criteria = `${p.ddPercent}%/${p.dtaMm}mm ${p.local ? 'Local' : 'Global'}`;
  const dtaOut = Float32Array.from(r.dta, (v) => (v === Infinity ? DTA_NOT_FOUND : v));
  const maps: [string, Float32Array, Record<string, string>][] = [
    ['gamma.nrrd', r.gamma, { quantity: 'gamma', unit: '1', criteria, cap: String(p.gammaCap), note: 'values >= cap mean gamma >= cap; NaN: not evaluated' }],
    ['dd_percent.nrrd', derive(r).ddPct, { quantity: 'dose difference (eval - ref)', unit: p.local ? '% of local reference dose' : `% of ${p.normDoseGy} Gy`, note: 'NaN: not evaluated' }],
    ['dd_gy.nrrd', r.dd, { quantity: 'dose difference (eval - ref)', unit: 'Gy', note: 'NaN: not evaluated' }],
    ['dta_mm.nrrd', dtaOut, { quantity: 'distance to agreement', unit: 'mm', note: `${DTA_NOT_FOUND}: not found within the search radius; NaN: not evaluated` }],
    ['ref_dose.nrrd', grid.data, { quantity: 'reference dose (scaled)', unit: 'Gy' }],
    ['eval_dose.nrrd', r.evalOnRef, { quantity: 'evaluated dose (scaled, shifted, interpolated onto the reference grid)', unit: 'Gy', note: 'NaN: outside the evaluated dose' }],
  ];
  const entries: ZipEntry[] = [];
  for (const [name, data, kv] of maps) {
    const keyValues = Object.fromEntries(Object.entries(kv).map(([k, v]) => [`gamma3d_${k}`, v]));
    entries.push({ name, data: await toNrrd(grid, data, { keyValues }) });
  }
  entries.push({ name: 'results.json', data: new TextEncoder().encode(resultsJson(input)) });
  return zip(entries, input.createdAt);
}

/** 書き出すファイル名 (患者情報を含める場合だけ患者 ID を入れる) */
export function exportFileName(input: Pick<ExportInput, 'includePatient' | 'ref' | 'createdAt'>, kind: 'results' | 'maps', ext: string): string {
  const d = input.createdAt;
  const p2 = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
  const id = input.includePatient && input.ref.set.patientId ? `_${input.ref.set.patientId.replace(/[^\w.-]+/g, '_')}` : '';
  return `gamma3d${id}_${kind}_${ts}.${ext}`;
}
