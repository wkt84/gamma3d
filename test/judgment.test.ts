import { describe, expect, it } from 'vitest';
import { DEFAULT_LEVELS, judge, validLevels } from '../src/core/judgment.ts';

describe('判定基準 (A4)', () => {
  it('境界値はそのレベルを満たす側に含める (TG-218: 許容 95%、アクション 90%)', () => {
    expect(judge(100, DEFAULT_LEVELS)).toBe('pass');
    expect(judge(95.0, DEFAULT_LEVELS)).toBe('pass');
    expect(judge(94.99, DEFAULT_LEVELS)).toBe('review');
    expect(judge(90.0, DEFAULT_LEVELS)).toBe('review');
    expect(judge(89.99, DEFAULT_LEVELS)).toBe('fail');
    expect(judge(0, DEFAULT_LEVELS)).toBe('fail');
  });

  it('表示 (小数 2 桁) と判定が食い違わない', () => {
    // 94.996% は 95.00% と表示されるので合格
    expect(judge(94.996, DEFAULT_LEVELS)).toBe('pass');
    expect(judge(94.994, DEFAULT_LEVELS)).toBe('review');
  });

  it('評価点がなくパス率が求まらないときは判定しない', () => {
    expect(judge(NaN, DEFAULT_LEVELS)).toBeNull();
  });

  it('アクションレベルは許容レベル以下、どちらも 0–100%', () => {
    expect(validLevels({ tolerance: 95, action: 90 })).toBe(true);
    expect(validLevels({ tolerance: 95, action: 95 })).toBe(true);
    expect(validLevels({ tolerance: 90, action: 95 })).toBe(false);
    expect(validLevels({ tolerance: 101, action: 90 })).toBe(false);
    expect(validLevels({ tolerance: 95, action: -1 })).toBe(false);
    expect(validLevels({ tolerance: NaN, action: 90 })).toBe(false);
  });
});
