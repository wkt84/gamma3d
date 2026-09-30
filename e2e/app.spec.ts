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

test('解析条件をプリセットとして保存・呼び出し・書き出し・削除・読み込みでき、再読み込み後も残る', async ({ page }) => {
  await page.goto('/');
  const preset = page.locator('#preset');
  const status = page.locator('#preset-status');
  await page.click('.presets summary');

  // 保存
  await page.fill('#p-dd', '2');
  await page.fill('#p-dta', '1.5');
  await page.check('input[name="norm"][value="local"]');
  await page.fill('#preset-name', '施設標準');
  await page.click('#preset-save');
  await expect(status).toContainText('保存しました');
  await expect(preset).toHaveValue('saved:施設標準');

  // 値を変えると「カスタム」になる
  await page.fill('#p-dd', '3');
  await expect(preset).toHaveValue('custom');

  // 再読み込みしても残っていて、選ぶと条件が入る
  await page.reload();
  await page.selectOption('#preset', 'saved:施設標準');
  await expect(page.locator('#p-dd')).toHaveValue('2');
  await expect(page.locator('#p-dta')).toHaveValue('1.5');
  await expect(page.locator('input[name="norm"][value="local"]')).toBeChecked();

  // 書き出し
  await page.click('.presets summary');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#preset-export')]);
  const file = (await download.path())!;
  const exported = JSON.parse(readFileSync(file, 'utf8'));
  expect(exported.kind).toBe('gamma3d-presets');
  expect(exported.presets.map((p: { name: string }) => p.name)).toEqual(['施設標準']);

  // 削除すると選択肢から消え、再読み込み後も戻らない
  await page.click('#preset-delete');
  await expect(status).toContainText('削除しました');
  await expect(preset.locator('option[value="saved:施設標準"]')).toHaveCount(0);
  await page.reload();
  await expect(preset.locator('option[value="saved:施設標準"]')).toHaveCount(0);

  // 書き出したファイルを読み込むと戻る
  await page.click('.presets summary');
  await page.locator('#preset-file').setInputFiles(file);
  await expect(status).toContainText('1 件を読み込みました');
  await expect(preset.locator('option[value="saved:施設標準"]')).toHaveCount(1);
});

test('比較元と比較先を入れ替えると、線量・係数が入れ替わり、解析結果は破棄される', async ({ page }) => {
  await load(page);
  await page.fill('[data-side="eval"] .scale-den', '1.01');
  await page.press('[data-side="eval"] .scale-den', 'Tab');
  await analyze(page);
  await expect(page.locator('#pdf')).toBeEnabled();

  await page.click('#swap');
  await expect(page.locator('[data-side="ref"] .set-select')).toContainText('BEAM 合算 ×2');
  await expect(page.locator('[data-side="eval"] .set-select')).toContainText('PLAN');
  await expect(page.locator('[data-side="ref"] .scale-den')).toHaveValue('1.01');
  await expect(page.locator('[data-side="eval"] .scale-den')).toHaveValue('1');
  // 結果は破棄され、再解析できる
  await expect(page.locator('#pdf')).toBeDisabled();
  await expect(page.locator('#run-status')).toHaveText('');
  await expect(page.locator('.stat')).toHaveCount(0);
  await analyze(page);
  await expect(page.locator('.stat')).toHaveCount(3);

  // もう一度押すと元に戻る
  await page.click('#swap');
  await expect(page.locator('[data-side="ref"] .set-select')).toContainText('PLAN');
  await expect(page.locator('[data-side="eval"] .set-select')).toContainText('BEAM 合算 ×2');
});

test('既定では WebAssembly で計算し、?engine=ts (TypeScript 版) と同じ結果になる', async ({ page }) => {
  const summary = async () => (await page.locator('.stat').allTextContents()).join(' | ');
  await load(page);
  await analyze(page);
  await expect(page.locator('#run-status')).toContainText('WebAssembly');
  const wasm = await summary();

  await page.goto('/?engine=ts');
  await page.locator('[data-side="ref"] .file-input').setInputFiles(REF);
  await page.locator('[data-side="eval"] .file-input').setInputFiles(EVAL);
  await expect(page.locator('#run')).toBeEnabled();
  await analyze(page);
  await expect(page.locator('#run-status')).toContainText('TypeScript');
  expect(await summary()).toBe(wasm);
});

test('比較先を平行移動 (手動シフト) すると結果に反映され、入れ替えると向きが反転する', async ({ page }) => {
  const passRate = async () => Number((await page.locator('.stat .value').first().textContent())!.replace('%', ''));
  await load(page);
  await page.fill('#p-dd', '1');
  await page.fill('#p-dta', '1');
  await analyze(page);
  const before = await passRate();

  // サンプルの比較先は x 方向に +1 mm ずれているので、−1 mm 動かすと合う
  const x = page.locator('[data-side="eval"] .shift[data-axis="0"]');
  await x.fill('-1');
  await x.press('Tab');
  await expect(page.locator('#pdf')).toBeDisabled(); // 結果は破棄される
  await analyze(page);
  const after = await passRate();
  expect(after).toBeGreaterThan(before + 1);

  await page.click('#swap');
  await expect(x).toHaveValue('1');
  await page.click('[data-side="eval"] .shift-reset');
  await expect(x).toHaveValue('0');
});

test('判定基準 (許容・アクションレベル) で合否を表示し、変更は再解析なしで反映される', async ({ page }) => {
  await load(page);
  await analyze(page);
  const badge = page.locator('.stat .judgment');
  await expect(badge).toHaveClass(/pass/);
  await expect(badge).toContainText('合格');
  await expect(badge).toContainText('許容 95% / アクション 90%');

  // 許容レベルを上げると要確認になる (結果は破棄されない)
  await page.fill('#p-tol', '99.9');
  await page.press('#p-tol', 'Tab');
  await expect(badge).toHaveClass(/review/);
  await expect(badge).toContainText('要確認');
  await expect(page.locator('#pdf')).toBeEnabled();
  await expect(page.locator('#run-status')).toContainText('完了');

  // アクションレベル > 許容レベルは不正: 欄を赤枠にして判定は出さない
  await page.fill('#p-act', '100');
  await page.press('#p-act', 'Tab');
  await expect(page.locator('#p-act')).toHaveAttribute('aria-invalid', 'true');
  await expect(badge).toHaveCount(0);
});

test('標準 4 条件をまとめて計算し、比較表から表示を切り替えられる (個別に計算した値と一致)', async ({ page }) => {
  const gammaTile = page.locator('.stat').first();
  // 2%/2mm を個別に計算した値
  await load(page);
  await page.selectOption('#preset', '2,2');
  await analyze(page);
  const single = await gammaTile.locator('.value').textContent();

  await page.check('#p-batch');
  await page.selectOption('#preset', '3,3');
  await analyze(page);
  await expect(page.locator('#run-status')).toContainText('4 条件');
  const rows = page.locator('table.compare tbody tr');
  await expect(rows).toHaveCount(4);
  // 入力欄の条件 (3%/3mm) が表示されている
  await expect(page.locator('table.compare tr.selected')).toContainText('3%/3mm');
  await expect(gammaTile).toContainText('3%/3mm');

  await rows.nth(2).locator('button').click();
  await expect(page.locator('table.compare tr.selected')).toContainText('2%/2mm');
  await expect(gammaTile).toContainText('2%/2mm');
  await expect(gammaTile.locator('.value')).toHaveText(single!);
  await expect(page.locator('#chart-gamma')).toHaveAttribute('aria-label', /2%\/2mm/);
  // 比較表の値とも一致
  await expect(rows.nth(2).locator('td').nth(1)).toHaveText(single!);

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#pdf')]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
});
