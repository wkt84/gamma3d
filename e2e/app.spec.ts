import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const SAMPLES = new URL('../samples/', import.meta.url).pathname;
const REF = [`${SAMPLES}ref/plan.dcm`];
const EVAL = [`${SAMPLES}eval/beam1.dcm`, `${SAMPLES}eval/beam2.dcm`];

async function load(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('[data-side="ref"] .file-input').setInputFiles(REF);
  await page.locator('[data-side="eval"] .file-input').setInputFiles(EVAL);
  await expect(page.locator('#run')).toBeEnabled();
}

async function analyze(page: Page): Promise<void> {
  await page.click('#run');
  await expect(page.locator('#run-status')).toContainText('完了', { timeout: 30_000 });
}

const sliceLabel = (page: Page) => page.locator('#slice-label');

test('crossOriginIsolated で、SharedArrayBuffer が使える', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test('RTDOSE を読み込み、BEAM を合算して解析できる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page);
  await expect(page.locator('[data-side="ref"] .set-select')).toContainText('PLAN');
  await expect(page.locator('[data-side="eval"] .set-select')).toContainText('BEAM 合算 ×2');

  await analyze(page);
  await expect(page.locator('#run-status')).not.toContainText('共有メモリなし');
  const stats = page.locator('.stat .value');
  await expect(stats).toHaveCount(3);
  // サンプルは 3%/3mm でほぼ合格し、ホットスポットだけが不合格になる
  const passRate = Number((await stats.first().textContent())!.replace('%', ''));
  expect(passRate).toBeGreaterThan(95);
  expect(passRate).toBeLessThan(100);
  await expect(page.locator('#pdf')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('ホイールで 3 パネルのスライスが同期して動き、ダブルクリックで十字カーソルが移動する', async ({ page }) => {
  await load(page);
  await expect(sliceLabel(page)).toHaveText(/^32\/64/);

  const box = (await page.locator('#panel-eval canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 100);
  await expect(sliceLabel(page)).toHaveText(/^29\/64/);
  // トラックパッド相当の細かいスクロールは累積して 1 スライスずつ送る
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 12);
  await expect(sliceLabel(page)).toHaveText(/^27\/64/);

  // シングルクリックでは動かない
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.3);
  await page.click('.plane button[data-plane="sagittal"]');
  await expect(sliceLabel(page)).toHaveText(/^48\/96/);

  // ダブルクリックでその点へ移動し、他の断面の表示位置が変わる
  await page.click('.plane button[data-plane="axial"]');
  await page.mouse.dblclick(box.x + box.width * 0.25, box.y + box.height * 0.3);
  await page.click('.plane button[data-plane="sagittal"]');
  await expect(sliceLabel(page)).not.toHaveText(/^48\/96/);
});

test('ホバーで値表示が変わっても、ツールバーの高さと画像の位置は変わらない', async ({ page }) => {
  await load(page);
  await analyze(page);
  const measure = () =>
    page.evaluate(() => ({
      toolbar: document.querySelector('.toolbar')!.getBoundingClientRect().height,
      grid: document.querySelector('.grid')!.getBoundingClientRect().top,
    }));
  const before = await measure();
  const box = (await page.locator('#panel-map canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.42);
  await expect(page.locator('#readout')).toContainText('DTA');
  expect(await measure()).toEqual(before);
});

test('係数 x / y で線量を換算し、不正な値は 1 として扱う', async ({ page }) => {
  await load(page);
  const norm = page.locator('#p-normdose');
  const full = Number(await norm.inputValue());

  const den = page.locator('[data-side="ref"] .scale-den');
  await den.fill('2');
  await den.press('Tab');
  await expect(page.locator('[data-side="ref"] .scale-value')).toHaveText('= 0.5 倍');
  expect(Number(await norm.inputValue())).toBeCloseTo(full / 2, 2);

  await den.fill('0');
  await den.press('Tab');
  await expect(den).toHaveAttribute('aria-invalid', 'true');
  expect(Number(await norm.inputValue())).toBeCloseTo(full, 2);
});

test('PDF レポートを出力できる', async ({ page }) => {
  await load(page);
  await analyze(page);
  await page.fill('#r-reviewer', '確認 太郎');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#pdf')]);
  expect(download.suggestedFilename()).toMatch(/^gamma3d_GAMMA3D-001_\d{8}_\d{4}\.pdf$/);
  const bytes = readFileSync((await download.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  // 日本語フォントはサブセット化されて埋め込まれる (全体を埋め込むと 5MB を超える)
  expect(bytes.length).toBeGreaterThan(100_000);
  expect(bytes.length).toBeLessThan(2_000_000);
  await expect(page.locator('#pdf-status')).toContainText('出力しました');
});
