import { describe, expect, it } from 'vitest';
import { merge, parseFile, PresetFileError, PresetStore, serialize, STORAGE_KEY, validateParams, type PresetParams } from '../src/ui/presets.ts';

const params: PresetParams = {
  ddPercent: 3,
  dtaMm: 2,
  local: false,
  normAuto: true,
  normDoseGy: null,
  gammaThresholdPercent: 10,
  ddThresholdPercent: 10,
  ddLowGradientOnly: false,
  gradientThresholdPercentPerMm: 3,
  gammaCap: 2,
  stepsPerDta: 10,
  toleranceLevel: 95,
  actionLevel: 90,
};

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe('プリセット', () => {
  it('範囲外・型違いの条件は受け付けない', () => {
    expect(validateParams(params)).toEqual(params);
    expect(validateParams({ ...params, ddPercent: 0 })).toBeNull();
    expect(validateParams({ ...params, gammaCap: 5 })).toBeNull();
    expect(validateParams({ ...params, stepsPerDta: 7.5 })).toBeNull();
    expect(validateParams({ ...params, local: 'yes' })).toBeNull();
    // 基準線量を手入力にするなら値が必要
    expect(validateParams({ ...params, normAuto: false, normDoseGy: null })).toBeNull();
    expect(validateParams({ ...params, normAuto: false, normDoseGy: 2 })?.normDoseGy).toBe(2);
    // 自動のときに値が入っていても捨てる
    expect(validateParams({ ...params, normDoseGy: 2 })?.normDoseGy).toBeNull();
    // 判定基準: アクションレベルは許容レベル以下
    expect(validateParams({ ...params, toleranceLevel: 90, actionLevel: 95 })).toBeNull();
  });

  it('判定基準を持たない以前のプリセットは既定値 (95% / 90%) で補う', () => {
    const { toleranceLevel: _t, actionLevel: _a, ...old } = params;
    expect(validateParams(old)).toEqual({ ...params, toleranceLevel: 95, actionLevel: 90 });
  });

  it('同じ名前は上書きし、名前順に並べる', () => {
    const a = { name: 'B', params };
    const b = { name: 'A', params };
    const c = { name: 'B', params: { ...params, dtaMm: 3 } };
    expect(merge([a, b], [c]).map((p) => [p.name, p.params.dtaMm])).toEqual([
      ['A', 2],
      ['B', 3],
    ]);
  });

  it('書き出したファイルを読み込める。不正な要素は数えて捨て、別形式のファイルは拒否する', () => {
    const text = serialize([{ name: '  施設標準   3%/2mm ', params }]);
    const { presets, rejected } = parseFile(text);
    expect(presets).toEqual([{ name: '施設標準 3%/2mm', params }]);
    expect(rejected).toBe(0);

    const mixed = JSON.parse(text);
    mixed.presets.push({ name: '', params }, { name: 'x', params: { ...params, dtaMm: -1 } });
    expect(parseFile(JSON.stringify(mixed)).rejected).toBe(2);

    expect(() => parseFile('not json')).toThrow(PresetFileError);
    expect(() => parseFile(JSON.stringify({ presets: [] }))).toThrow(PresetFileError);
  });

  it('保存先に書き込み、次回の起動で読み出せる', () => {
    const storage = new MemoryStorage();
    const store = new PresetStore(storage);
    expect(store.persistent).toBe(true);
    store.save('標準', params);
    store.save('厳しめ', { ...params, ddPercent: 2, dtaMm: 2 });
    store.remove('標準');
    const again = new PresetStore(storage);
    expect(again.all().map((p) => p.name)).toEqual(['厳しめ']);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toHaveLength(1);
  });

  it('保存先が使えなくても動き、画面を開いている間は保持する', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    for (const storage of [broken, null]) {
      const store = new PresetStore(storage);
      expect(store.persistent).toBe(false);
      store.save('一時', params);
      expect(store.get('一時')?.params).toEqual(params);
    }
  });

  it('保存先の中身が壊れていても起動できる', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, '{broken');
    const store = new PresetStore(storage);
    expect(store.all()).toEqual([]);
    expect(store.persistent).toBe(true);
  });
});
