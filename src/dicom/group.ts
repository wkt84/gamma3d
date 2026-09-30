import { resampleTo, sameGeometry, maxValue, type Volume } from '../core/volume.ts';
import type { RtDose } from './rtdose.ts';

/** 解析に使える線量の候補 (単一の PLAN 線量、または BEAM 線量の合算)。 */
export interface DoseSet {
  id: string;
  label: string;
  kind: 'PLAN' | 'BEAM_SUM' | 'OTHER';
  doses: RtDose[];
  volume: Volume;
  maxDose: number;
  planUID: string | null;
  patientName: string;
  patientId: string;
  frameOfReferenceUID: string;
  summary: string;
  warnings: string[];
}

function short(uid: string | null): string {
  if (!uid) return '参照プランなし';
  return uid.length > 16 ? '…' + uid.slice(-12) : uid;
}

function describe(d: RtDose): string {
  return d.seriesDescription || d.fileName;
}

function makeSet(id: string, label: string, kind: DoseSet['kind'], doses: RtDose[], volume: Volume, warnings: string[]): DoseSet {
  const first = doses[0];
  const [nx, ny, nz] = volume.dims;
  const [sx, sy, sz] = volume.spacing;
  const allWarnings = [...new Set([...doses.flatMap((d) => d.warnings.map((w) => `${d.fileName}: ${w}`)), ...warnings])];
  const maxDose = maxValue(volume.data);
  return {
    id,
    label,
    kind,
    doses,
    volume,
    maxDose,
    planUID: first.referencedPlanUID,
    patientName: first.patientName,
    patientId: first.patientId,
    frameOfReferenceUID: first.frameOfReferenceUID,
    summary: `${nx}×${ny}×${nz} / ${sx.toFixed(2)}×${sy.toFixed(2)}×${sz.toFixed(2)} mm / 最大 ${maxDose.toFixed(3)} Gy`,
    warnings: allWarnings,
  };
}

/** BEAM 線量を合算する。格子が異なるものは先頭の格子へ補間する。 */
export function sumDoses(doses: RtDose[]): { volume: Volume; warnings: string[] } {
  const base = doses[0].volume;
  const out = new Float32Array(base.data.length);
  const warnings: string[] = [];
  for (const d of doses) {
    let v = d.volume;
    if (!sameGeometry(base, v)) {
      v = resampleTo(v, base, 0);
      warnings.push(`${d.fileName}: 格子が異なるため先頭ビームの格子へ補間して合算しました`);
    }
    for (let n = 0; n < out.length; n++) out[n] += v.data[n];
  }
  const units = new Set(doses.map((d) => d.doseUnits));
  if (units.size > 1) warnings.push(`線量単位が混在しています (${[...units].join(', ')})`);
  const frs = new Set(doses.map((d) => d.frameOfReferenceUID));
  if (frs.size > 1) warnings.push('FrameOfReferenceUID の異なる線量が混在しています');
  return { volume: { dims: [...base.dims], spacing: [...base.spacing], origin: [...base.origin], data: out }, warnings };
}

/**
 * 読み込んだ RTDOSE を参照プランごとにまとめ、解析候補を作る。
 * - PLAN / FRACTION 等はファイルごとに 1 候補
 * - BEAM はプランごとに合算して 1 候補
 */
export function buildDoseSets(doses: RtDose[]): DoseSet[] {
  const groups = new Map<string, RtDose[]>();
  for (const d of doses) {
    const key = d.referencedPlanUID ?? `series:${d.seriesInstanceUID || d.fileName}`;
    const g = groups.get(key);
    if (g) g.push(d);
    else groups.set(key, [d]);
  }

  const sets: DoseSet[] = [];
  for (const [key, list] of groups) {
    const planUID = list[0].referencedPlanUID;
    const beams = list.filter((d) => d.summationType === 'BEAM');
    const others = list.filter((d) => d.summationType !== 'BEAM');

    for (const d of others) {
      const kind = d.summationType === 'PLAN' ? 'PLAN' : 'OTHER';
      sets.push(makeSet(`${key}:${d.sopInstanceUID || d.fileName}`, `${d.summationType}: ${describe(d)} (${short(planUID)})`, kind, [d], d.volume, []));
    }

    if (beams.length > 0) {
      beams.sort((a, b) => (a.referencedBeamNumbers[0] ?? 0) - (b.referencedBeamNumbers[0] ?? 0));
      const warnings: string[] = [];
      const nums = beams.flatMap((b) => b.referencedBeamNumbers);
      const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
      if (dup.length) warnings.push(`同じビーム番号が複数あります (${[...new Set(dup)].join(', ')})`);
      const uids = beams.map((b) => b.sopInstanceUID).filter(Boolean);
      if (new Set(uids).size !== uids.length) warnings.push('同一の SOPInstanceUID のファイルが重複しています');
      const { volume, warnings: w } = beams.length === 1 ? { volume: beams[0].volume, warnings: [] } : sumDoses(beams);
      warnings.push(...w);
      sets.push(makeSet(`${key}:beam-sum`, `BEAM 合算 ×${beams.length} (${short(planUID)})`, 'BEAM_SUM', beams, volume, warnings));
    }
  }

  // PLAN を優先して並べる
  const order = { PLAN: 0, BEAM_SUM: 1, OTHER: 2 } as const;
  return sets.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** 線量に掛ける係数 (num / den)。PLAN を 1 回分にするときは 1 / 分割回数 など。 */
export interface DoseScale {
  num: number;
  den: number;
}

export const scaleFactor = (s: DoseScale): number => s.num / s.den;

export function formatScale(s: DoseScale): string {
  const f = scaleFactor(s);
  const v = Number(f.toPrecision(6));
  return s.den === 1 ? `×${s.num}` : `×${s.num}/${s.den} (= ${v})`;
}

/** 係数を掛けた体積を返す (係数 1 ならそのまま)。 */
export function scaled(v: Volume, factor: number): Volume {
  if (factor === 1) return v;
  const data = new Float32Array(v.data.length);
  for (let n = 0; n < data.length; n++) data[n] = v.data[n] * factor;
  return { ...v, data };
}
