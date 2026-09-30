/** γ パス率の判定基準 (%)。既定値は AAPM TG-218 の推奨 */
export interface ActionLevels {
  /** 許容レベル: これ以上なら合格 */
  tolerance: number;
  /** アクションレベル: これ以上なら要確認、未満なら不合格 */
  action: number;
}

export const DEFAULT_LEVELS: ActionLevels = { tolerance: 95, action: 90 };

export type Judgment = 'pass' | 'review' | 'fail';

export function validLevels(l: ActionLevels): boolean {
  return (
    Number.isFinite(l.tolerance) && Number.isFinite(l.action) && l.action >= 0 && l.tolerance <= 100 && l.action <= l.tolerance
  );
}

/**
 * パス率を判定する。境界値はそのレベルを満たす側に含める (95.0% は合格、90.0% は要確認)。
 * 表示と同じ桁 (小数 2 桁) で丸めてから比べ、表示上 95.00% なのに要確認となる食い違いを避ける。
 * パス率が求まらない (評価点なし) ときは null。
 */
export function judge(passRate: number, levels: ActionLevels): Judgment | null {
  if (!Number.isFinite(passRate)) return null;
  const r = Math.round(passRate * 100) / 100;
  if (r >= levels.tolerance) return 'pass';
  if (r >= levels.action) return 'review';
  return 'fail';
}
