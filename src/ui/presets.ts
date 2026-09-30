import { DEFAULT_LEVELS, validLevels } from '../core/judgment.ts';

/**
 * 解析条件のプリセット (名前付きで保存した解析条件)。
 * ブラウザの localStorage に保存し、JSON ファイルで書き出し・読み込みできる。
 * localStorage が使えない環境 (プライベートブラウズ等) では、画面を開いている間だけ保持する。
 */

/** プリセットに保存する解析条件 (画面の入力欄に対応) */
export interface PresetParams {
  ddPercent: number;
  dtaMm: number;
  local: boolean;
  /** true: 基準線量に比較元の最大線量を使う */
  normAuto: boolean;
  /** normAuto が false のときの基準線量 (Gy) */
  normDoseGy: number | null;
  gammaThresholdPercent: number;
  ddThresholdPercent: number;
  ddLowGradientOnly: boolean;
  gradientThresholdPercentPerMm: number;
  gammaCap: number;
  stepsPerDta: number;
  /** γ パス率の判定基準 (%)。これらを持たない以前のプリセットは既定値で補う */
  toleranceLevel: number;
  actionLevel: number;
}

export interface Preset {
  name: string;
  params: PresetParams;
}

export const STORAGE_KEY = 'gamma3d.presets.v1';
const FILE_KIND = 'gamma3d-presets';
const FILE_VERSION = 1;
export const MAX_NAME_LENGTH = 60;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** 値の型と範囲を確かめ、正しければ PresetParams を返す (範囲は解析実行時のチェックと同じ) */
export function validateParams(v: unknown): PresetParams | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const levels = {
    tolerance: o.toleranceLevel === undefined ? DEFAULT_LEVELS.tolerance : o.toleranceLevel,
    action: o.actionLevel === undefined ? DEFAULT_LEVELS.action : o.actionLevel,
  };
  if (!isNum(levels.tolerance) || !isNum(levels.action) || !validLevels(levels as { tolerance: number; action: number })) return null;
  const ok =
    isNum(o.ddPercent) &&
    o.ddPercent > 0 &&
    isNum(o.dtaMm) &&
    o.dtaMm > 0 &&
    isBool(o.local) &&
    isBool(o.normAuto) &&
    (o.normAuto ? o.normDoseGy === null || o.normDoseGy === undefined || isNum(o.normDoseGy) : isNum(o.normDoseGy) && o.normDoseGy > 0) &&
    isNum(o.gammaThresholdPercent) &&
    o.gammaThresholdPercent >= 0 &&
    o.gammaThresholdPercent < 100 &&
    isNum(o.ddThresholdPercent) &&
    o.ddThresholdPercent >= 0 &&
    o.ddThresholdPercent < 100 &&
    isBool(o.ddLowGradientOnly) &&
    isNum(o.gradientThresholdPercentPerMm) &&
    o.gradientThresholdPercentPerMm >= 0 &&
    isNum(o.gammaCap) &&
    o.gammaCap >= 1 &&
    o.gammaCap <= 3 &&
    isNum(o.stepsPerDta) &&
    Number.isInteger(o.stepsPerDta) &&
    o.stepsPerDta >= 2 &&
    o.stepsPerDta <= 20;
  if (!ok) return null;
  return {
    ddPercent: o.ddPercent as number,
    dtaMm: o.dtaMm as number,
    local: o.local as boolean,
    normAuto: o.normAuto as boolean,
    normDoseGy: o.normAuto ? null : (o.normDoseGy as number),
    gammaThresholdPercent: o.gammaThresholdPercent as number,
    ddThresholdPercent: o.ddThresholdPercent as number,
    ddLowGradientOnly: o.ddLowGradientOnly as boolean,
    gradientThresholdPercentPerMm: o.gradientThresholdPercentPerMm as number,
    gammaCap: o.gammaCap as number,
    stepsPerDta: o.stepsPerDta as number,
    toleranceLevel: levels.tolerance,
    actionLevel: levels.action,
  };
}

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
}

/** 配列からプリセットを取り出す。不正な要素は数えて捨てる */
function readList(v: unknown): { presets: Preset[]; rejected: number } {
  if (!Array.isArray(v)) return { presets: [], rejected: 0 };
  const presets: Preset[] = [];
  let rejected = 0;
  for (const item of v) {
    const name = item && typeof item === 'object' && typeof (item as Preset).name === 'string' ? normalizeName((item as Preset).name) : '';
    const params = item && typeof item === 'object' ? validateParams((item as Preset).params) : null;
    if (name && params) presets.push({ name, params });
    else rejected++;
  }
  return { presets, rejected };
}

/** 同じ名前は後から来たもので上書きし、名前順に並べる */
export function merge(base: Preset[], incoming: Preset[]): Preset[] {
  const map = new Map(base.map((p) => [p.name, p]));
  for (const p of incoming) map.set(p.name, p);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function serialize(presets: Preset[]): string {
  return JSON.stringify({ kind: FILE_KIND, version: FILE_VERSION, presets }, null, 2) + '\n';
}

export class PresetFileError extends Error {}

/** 書き出したファイルを読み込む。形式が違えば PresetFileError */
export function parseFile(textContent: string): { presets: Preset[]; rejected: number } {
  let data: unknown;
  try {
    data = JSON.parse(textContent);
  } catch {
    throw new PresetFileError('invalid JSON');
  }
  const o = data as { kind?: unknown; version?: unknown; presets?: unknown } | null;
  if (!o || o.kind !== FILE_KIND || o.version !== FILE_VERSION || !Array.isArray(o.presets)) {
    throw new PresetFileError('not a preset file');
  }
  return readList(o.presets);
}

/** 保存先。テストでは差し替える */
export interface PresetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage を包み、使えないときはメモリ上だけで保持するストア */
export class PresetStore {
  private list: Preset[] = [];
  /** 保存先に書き込めているか (false なら画面を閉じると消える) */
  persistent: boolean;

  private readonly storage: PresetStorage | null;

  constructor(storage: PresetStorage | null) {
    this.storage = storage;
    this.persistent = false;
    if (!storage) return;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      try {
        this.list = raw ? readList(JSON.parse(raw)).presets : [];
      } catch {
        // 中身が壊れていれば空から始める (次の保存で上書きされる)
        this.list = [];
      }
      // 書き込みもできるか確かめる
      storage.setItem(STORAGE_KEY, JSON.stringify(this.list));
      this.persistent = true;
    } catch {
      this.persistent = false;
    }
  }

  all(): Preset[] {
    return [...this.list];
  }

  get(name: string): Preset | undefined {
    return this.list.find((p) => p.name === name);
  }

  save(name: string, params: PresetParams): Preset {
    const preset = { name: normalizeName(name), params };
    this.list = merge(this.list, [preset]);
    this.flush();
    return preset;
  }

  remove(name: string): void {
    this.list = this.list.filter((p) => p.name !== name);
    this.flush();
  }

  import(presets: Preset[]): void {
    this.list = merge(this.list, presets);
    this.flush();
  }

  private flush(): void {
    if (!this.storage || !this.persistent) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.list));
    } catch {
      this.persistent = false;
    }
  }
}

/** ブラウザの localStorage (アクセス自体が例外になる環境では null) */
export function browserStorage(): PresetStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
