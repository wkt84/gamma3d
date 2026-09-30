import { describe, expect, it } from 'vitest';
import { newUid, writeRtDose, writeRtPlan, type RtDoseSpec } from '../scripts/dicom-writer.ts';
import { buildDoseSets, formatScale, scaled, scaleFactor } from '../src/dicom/group.ts';
import { isRtDose, parseRtDose, peekModality } from '../src/dicom/rtdose.ts';
import { parseRtPlan } from '../src/dicom/rtplan.ts';
import { createSampler } from '../src/core/volume.ts';

const toBuffer = (b: Uint8Array): ArrayBuffer => b.slice().buffer;

/** 患者座標の関数から、指定した向きで並べたファイル内配列を作る */
function spec(over: Partial<RtDoseSpec> & Pick<RtDoseSpec, 'ipp'>, f: (x: number, y: number, z: number) => number): RtDoseSpec {
  const cols = 6;
  const rows = 5;
  const frameOffsets = over.frameOffsets ?? [0, 2, 4, 6];
  const iop = over.iop ?? [1, 0, 0, 0, 1, 0];
  const spacing: [number, number] = [2, 3];
  const frames = frameOffsets.length;
  const sliceSign = iop[0] * iop[4];
  const dose = new Float32Array(cols * rows * frames);
  for (let k = 0; k < frames; k++)
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const x = over.ipp[0] + iop[0] * c * spacing[0];
        const y = over.ipp[1] + iop[4] * r * spacing[1];
        const z = over.ipp[2] + sliceSign * (frameOffsets[k] - frameOffsets[0]);
        dose[c + cols * (r + rows * k)] = f(x, y, z);
      }
  const uid = newUid();
  return {
    cols,
    rows,
    frames,
    spacing,
    iop,
    frameOffsets,
    dose,
    summationType: 'PLAN',
    planUID: '1.2.3.4',
    patientName: 'TEST^PATIENT',
    patientId: 'P001',
    seriesDescription: 'test',
    studyUID: uid + '.1',
    seriesUID: uid + '.2',
    sopUID: uid + '.3',
    forUID: '1.2.3.9',
    ...over,
  };
}

const field = (x: number, y: number, z: number) => 1 + 0.01 * x + 0.02 * y + 0.03 * z;

describe('RTDOSE 読み込み', () => {
  it('書き出したファイルを読み込み、座標と線量が一致する', () => {
    const buf = writeRtDose(spec({ ipp: [-5, -6, 10] }, field));
    expect(isRtDose(buf)).toBe(true);
    // 先頭の一部だけでも判定できる (フォルダ読み込み時の高速判定)
    expect(isRtDose(buf.slice(0, 1024))).toBe(true);
    const d = parseRtDose(toBuffer(buf), 'a.dcm');
    expect(d.summationType).toBe('PLAN');
    expect(d.patientName).toBe('TEST PATIENT');
    expect(d.volume.dims).toEqual([6, 5, 4]);
    expect(d.volume.spacing).toEqual([2, 3, 2]);
    expect(d.volume.origin).toEqual([-5, -6, 10]);
    const s = createSampler(d.volume);
    expect(s(-1, 0, 13)).toBeCloseTo(field(-1, 0, 13), 5);
  });

  it('反転した向き (Prone/FFS 相当) と絶対値の GridFrameOffsetVector を正規化する', () => {
    const buf = writeRtDose(spec({ ipp: [5, 6, 10], iop: [-1, 0, 0, 0, -1, 0], frameOffsets: [10, 12, 14, 16] }, field));
    const d = parseRtDose(toBuffer(buf), 'b.dcm');
    // 行 × 列 = +Z なのでスライスは z 増加方向
    expect(d.volume.origin).toEqual([-5, -6, 10]);
    const s = createSampler(d.volume);
    expect(s(-3, -3, 12)).toBeCloseTo(field(-3, -3, 12), 5);
    expect(s(4, 5, 16)).toBeCloseTo(field(4, 5, 16), 5);
  });

  it('BEAM 線量はプランごとに合算される', () => {
    const b1 = parseRtDose(toBuffer(writeRtDose(spec({ ipp: [0, 0, 0], summationType: 'BEAM', beamNumber: 1 }, () => 1))), 'b1.dcm');
    const b2 = parseRtDose(toBuffer(writeRtDose(spec({ ipp: [0, 0, 0], summationType: 'BEAM', beamNumber: 2 }, () => 0.5))), 'b2.dcm');
    const plan = parseRtDose(toBuffer(writeRtDose(spec({ ipp: [0, 0, 0] }, () => 1.5))), 'plan.dcm');
    expect(b1.referencedBeamNumbers).toEqual([1]);
    const sets = buildDoseSets([b2, plan, b1]);
    expect(sets.map((s) => s.kind)).toEqual(['PLAN', 'BEAM_SUM']);
    expect(sets[1].doses.map((d) => d.fileName)).toEqual(['b1.dcm', 'b2.dcm']);
    expect(sets[1].maxDose).toBeCloseTo(1.5, 5);
    expect(sets[1].warnings).toEqual([]);
  });
});

describe('線量の係数 (x / y)', () => {
  it('係数の計算と表示', () => {
    expect(scaleFactor({ num: 1, den: 30 })).toBeCloseTo(1 / 30, 12);
    expect(formatScale({ num: 30, den: 1 })).toBe('×30');
    expect(formatScale({ num: 1, den: 30 })).toBe('×1/30 (= 0.0333333)');
    const v = { dims: [2, 1, 1] as [number, number, number], spacing: [1, 1, 1] as [number, number, number], origin: [0, 0, 0] as [number, number, number], data: new Float32Array([60, 30]) };
    expect(Array.from(scaled(v, scaleFactor({ num: 1, den: 30 })).data)).toEqual([2, 1]);
  });
});

describe('RTPLAN (B1)', () => {
  const planSpec = {
    sopUID: '1.2.3.4',
    label: 'PROSTATE',
    name: '前立腺 VMAT',
    fractions: 39,
    beams: [
      { number: 2, name: 'ARC2', meterset: 301.25 },
      { number: 1, name: 'ARC1', meterset: 298.5 },
    ],
    patientName: 'TEST^PATIENT',
    patientId: 'P001',
    studyUID: '1.2.3.10',
    seriesUID: '1.2.3.11',
    forUID: '1.2.3.9',
  };

  it('分割回数・ビーム名・MU を読む', () => {
    const buf = writeRtPlan(planSpec);
    expect(peekModality(buf.slice(0, 1024))).toBe('RTPLAN');
    expect(isRtDose(buf)).toBe(false);
    const p = parseRtPlan(toBuffer(buf), 'plan.dcm');
    expect(p.sopInstanceUID).toBe('1.2.3.4');
    expect(p.label).toBe('PROSTATE');
    expect(p.name).toBe('前立腺 VMAT');
    expect(p.fractions).toBe(39);
    expect(p.beams).toEqual([
      { number: 1, name: 'ARC1', meterset: 298.5 },
      { number: 2, name: 'ARC2', meterset: 301.25 },
    ]);
  });

  it('分割回数がなければ null、RTDOSE を渡せばエラー', () => {
    expect(parseRtPlan(toBuffer(writeRtPlan({ ...planSpec, fractions: null })), 'p.dcm').fractions).toBeNull();
    const dose = writeRtDose(spec({ ipp: [0, 0, 0] }, () => 1));
    expect(() => parseRtPlan(toBuffer(dose), 'dose.dcm')).toThrow(/RTPLAN ではありません/);
  });
});
