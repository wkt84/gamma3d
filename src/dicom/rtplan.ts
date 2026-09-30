import type { DataSet } from 'dicom-parser';
import { LocalizedError } from '../i18n/index.ts';
import { parse } from './rtdose.ts';
import { charsetOf, readText } from './charset.ts';

export interface RtPlanBeam {
  number: number;
  name: string;
  /** MU (FractionGroupSequence の BeamMeterset)。なければ null */
  meterset: number | null;
}

/** 分割回数の換算とビーム名の表示に必要な範囲だけを読んだ RTPLAN */
export interface RtPlan {
  fileName: string;
  sopInstanceUID: string;
  label: string;
  name: string;
  patientId: string;
  frameOfReferenceUID: string;
  /** NumberOfFractionsPlanned (最初の分割グループ)。なければ null */
  fractions: number | null;
  beams: RtPlanBeam[];
}

const str = (ds: DataSet | undefined, tag: string): string => (ds?.string(tag) ?? '').trim();

export function parseRtPlan(buffer: ArrayBuffer, fileName: string): RtPlan {
  const ds = parse(new Uint8Array(buffer));
  const cs = charsetOf(ds);
  const modality = str(ds, 'x00080060').toUpperCase();
  if (modality !== 'RTPLAN') throw new LocalizedError((m) => m.dicom.notRtplan(fileName, modality));

  // FractionGroupSequence (最初のグループ): 分割回数と、ビームごとの MU
  const fg = ds.elements['x300a0070']?.items?.[0]?.dataSet;
  const fractions = fg?.intString('x300a0078') ?? null;
  const meterset = new Map<number, number>();
  for (const item of fg?.elements['x300c0004']?.items ?? []) {
    const n = item.dataSet?.intString('x300c0006');
    const mu = item.dataSet?.floatString('x300a0086');
    if (n !== undefined && mu !== undefined && Number.isFinite(mu)) meterset.set(n, mu);
  }

  // BeamSequence: 番号と名前
  const beams: RtPlanBeam[] = [];
  for (const item of ds.elements['x300a00b0']?.items ?? []) {
    const n = item.dataSet?.intString('x300a00c0');
    if (n === undefined) continue;
    beams.push({ number: n, name: item.dataSet ? readText(item.dataSet, 'x300a00c2', cs) : '', meterset: meterset.get(n) ?? null });
  }
  beams.sort((a, b) => a.number - b.number);

  return {
    fileName,
    sopInstanceUID: str(ds, 'x00080018'),
    label: readText(ds, 'x300a0002', cs),
    name: readText(ds, 'x300a0003', cs),
    patientId: str(ds, 'x00100020'),
    frameOfReferenceUID: str(ds, 'x00200052'),
    fractions: fractions !== null && Number.isFinite(fractions) && fractions > 0 ? fractions : null,
    beams,
  };
}
