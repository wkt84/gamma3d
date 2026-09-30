import { resampleTo, sameGeometry, maxValue, type Volume } from '../core/volume.ts';
import type { Msg } from '../i18n/index.ts';
import type { RtDose } from './rtdose.ts';

/** 解析に使える線量の候補 (単一の PLAN 線量、または BEAM 線量の合算)。 */
export interface DoseSet {
  id: string;
  label: Msg;
  kind: 'PLAN' | 'BEAM_SUM' | 'OTHER';
  doses: RtDose[];
  volume: Volume;
  maxDose: number;
  planUID: string | null;
  patientName: string;
  patientId: string;
  frameOfReferenceUID: string;
  summary: Msg;
  warnings: Msg[];
}

function short(uid: string | null): Msg {
  if (!uid) return (m) => m.doseSet.noPlan;
  const s = uid.length > 16 ? '…' + uid.slice(-12) : uid;
  return () => s;
}

function describe(d: RtDose): string {
  return d.seriesDescription || d.fileName;
}

function makeSet(id: string, label: Msg, kind: DoseSet['kind'], doses: RtDose[], volume: Volume, warnings: Msg[]): DoseSet {
  const first = doses[0];
  const [nx, ny, nz] = volume.dims;
  const [sx, sy, sz] = volume.spacing;
  const allWarnings: Msg[] = [...doses.flatMap((d) => d.warnings.map((w): Msg => (m) => m.dicom.fileWarning(d.fileName, w(m)))), ...warnings];
  const maxDose = maxValue(volume.data);
  const dims = `${nx}×${ny}×${nz}`;
  const spacing = `${sx.toFixed(2)}×${sy.toFixed(2)}×${sz.toFixed(2)}`;
  const max = maxDose.toFixed(3);
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
    summary: (m) => m.doseSet.summary(dims, spacing, max),
    warnings: allWarnings,
  };
}

/** BEAM 線量を合算する。格子が異なるものは先頭の格子へ補間する。 */
export function sumDoses(doses: RtDose[]): { volume: Volume; warnings: Msg[] } {
  const base = doses[0].volume;
  const out = new Float32Array(base.data.length);
  const warnings: Msg[] = [];
  for (const d of doses) {
    let v = d.volume;
    if (!sameGeometry(base, v)) {
      v = resampleTo(v, base, 0);
      warnings.push((m) => m.doseSet.gridResampled(d.fileName));
    }
    for (let n = 0; n < out.length; n++) out[n] += v.data[n];
  }
  const units = new Set(doses.map((d) => d.doseUnits));
  if (units.size > 1) warnings.push((m) => m.doseSet.unitsMixed([...units].join(', ')));
  const frs = new Set(doses.map((d) => d.frameOfReferenceUID));
  if (frs.size > 1) warnings.push((m) => m.doseSet.frameOfReferenceMixed);
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
      const plan = short(planUID);
      const label: Msg = (m) => m.doseSet.label(d.summationType, describe(d), plan(m));
      sets.push(makeSet(`${key}:${d.sopInstanceUID || d.fileName}`, label, kind, [d], d.volume, []));
    }

    if (beams.length > 0) {
      beams.sort((a, b) => (a.referencedBeamNumbers[0] ?? 0) - (b.referencedBeamNumbers[0] ?? 0));
      const warnings: Msg[] = [];
      const nums = beams.flatMap((b) => b.referencedBeamNumbers);
      const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
      if (dup.length) warnings.push((m) => m.doseSet.duplicateBeams([...new Set(dup)].join(', ')));
      const uids = beams.map((b) => b.sopInstanceUID).filter(Boolean);
      if (new Set(uids).size !== uids.length) warnings.push((m) => m.doseSet.duplicateInstances);
      const { volume, warnings: w } = beams.length === 1 ? { volume: beams[0].volume, warnings: [] } : sumDoses(beams);
      warnings.push(...w);
      const plan = short(planUID);
      const n = beams.length;
      sets.push(makeSet(`${key}:beam-sum`, (m) => m.doseSet.beamSum(n, plan(m)), 'BEAM_SUM', beams, volume, warnings));
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
