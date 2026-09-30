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

test('右上に GitHub リポジトリへのリンクがある (新しいタブで開く)', async ({ page }) => {
  await page.goto('/');
  const link = page.locator('.app-header a.github');
  await expect(link).toHaveAttribute('href', 'https://github.com/wkt84/gamma3d');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('aria-label', /GitHub/);
});

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

test('RTPLAN を一緒に読み込むと、分割回数・ビーム名を表示し、1 回分への換算ができる', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-side="ref"] .file-input').setInputFiles([...REF, `${SAMPLES}ref/rtplan.dcm`]);
  await page.locator('[data-side="eval"] .file-input').setInputFiles([...EVAL, `${SAMPLES}eval/rtplan.dcm`]);
  await expect(page.locator('#run')).toBeEnabled();

  const ev = page.locator('[data-side="eval"]');
  await expect(ev.locator('.plan-info')).toHaveText('プラン TPS-B ・ 30 回 ・ ビーム 2 門');
  await expect(ev.locator('.file-list summary')).toHaveText('RTDOSE 2 ・ RTPLAN 1 / 3 ファイル');
  await expect(ev.locator('.file-list li').first()).toContainText('#1 G30 212.4 MU');

  const norm = Number(await page.locator('#p-normdose').inputValue());
  const ref = page.locator('[data-side="ref"]');
  await ref.locator('.per-fraction').click();
  await expect(ref.locator('.scale-num')).toHaveValue('1');
  await expect(ref.locator('.scale-den')).toHaveValue('30');
  expect(Number(await page.locator('#p-normdose').inputValue())).toBeCloseTo(norm / 30, 3);
});

test('RTPLAN がなければプランの表示と換算ボタンは出ない', async ({ page }) => {
  await load(page);
  await expect(page.locator('[data-side="ref"] .plan-info')).toBeHidden();
  await expect(page.locator('[data-side="ref"] .per-fraction')).toBeHidden();
});

/** 画面上の日本語 (言語の選択肢 "日本語" を除く、非表示の要素や title などの属性も含む) */
const japaneseOnPage = (page: Page) =>
  page.evaluate(() => {
    const jp = /[぀-ヿ㐀-鿿]+/g;
    const body = document.body.cloneNode(true) as HTMLElement;
    body.querySelector('#lang')?.remove();
    const attrs = [...body.querySelectorAll('*')].flatMap((el) =>
      ['title', 'aria-label', 'placeholder', 'label'].map((a) => el.getAttribute(a) ?? ''),
    );
    return [body.textContent ?? '', ...attrs, document.title].join('\n').match(jp) ?? [];
  });

test('ブラウザの言語が英語なら英語の画面になり、日本語の文字列が残らない', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await load(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#lang')).toHaveValue('en');
  await expect(page.locator('#run')).toHaveText('Run analysis');
  await page.click('#run');
  await expect(page.locator('#run-status')).toContainText('Done', { timeout: 30_000 });
  await expect(page.locator('.stat .label').first()).toContainText('Gamma passing rate');
  await expect(page.locator('.judgment strong').first()).toHaveText(/^(Pass|Review|Fail)$/);
  expect(await japaneseOnPage(page)).toEqual([]);
  await context.close();
});

test('言語を切り替えると、読み込み済みのデータと解析結果を保ったまま文言が変わり、選択は保存される', async ({ page }) => {
  await load(page);
  await analyze(page);
  const passRate = await page.locator('.stat .value').first().textContent();
  await expect(page.locator('[data-side="eval"] .set-select')).toContainText('BEAM 合算 ×2');

  await page.selectOption('#lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#run-status')).toContainText('Done');
  await expect(page.locator('[data-side="eval"] .set-select')).toContainText('BEAM sum ×2');
  await expect(page.locator('#panel-ref .panel-head')).toContainText('Reference (Ref)');
  await expect(page.locator('.stat .value').first()).toHaveText(passRate!);
  expect(await japaneseOnPage(page)).toEqual([]);

  // 日本語に戻すと元の文言になる
  await page.selectOption('#lang', 'ja');
  await expect(page.locator('#run-status')).toContainText('完了');
  await expect(page.locator('#panel-ref .panel-head')).toContainText('比較元 (Ref)');

  // 選択は再読み込み後も残る (ブラウザの言語設定より優先)
  await page.selectOption('#lang', 'en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#lang')).toHaveValue('en');
});

test('英語の PDF は小さい英字用フォントで作り、データに日本語があれば日本語フォントを使う', async ({ page }) => {
  const fonts: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/fonts/')) fonts.push(r.url().split('/').pop()!);
  });
  await page.goto('/?lang=en');
  await page.locator('[data-side="ref"] .file-input').setInputFiles(REF);
  await page.locator('[data-side="eval"] .file-input').setInputFiles(EVAL);
  await page.click('#run');
  await expect(page.locator('#run-status')).toContainText('Done', { timeout: 30_000 });

  await page.fill('#r-reviewer', 'John Smith');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#pdf')]);
  const bytes = readFileSync((await download.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(fonts.sort()).toEqual(['NotoSansJP-Latin-Bold.ttf', 'NotoSansJP-Latin-Regular.ttf']);
  await expect(page.locator('#pdf-status')).toContainText('Saved');

  // 確認者の名前が日本語なら、英語の画面でも日本語フォントを読み込む
  fonts.length = 0;
  await page.fill('#r-reviewer', '確認 太郎');
  await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#pdf')]);
  expect(fonts.sort()).toEqual(['NotoSansJP-Bold.ttf', 'NotoSansJP-Regular.ttf']);
});

test('下段をプロファイルに切り替えると x・y・z のプロファイルが出て、ダブルクリックで十字カーソルが移動する', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page);
  await expect(page.locator('#profile-x')).toBeHidden();
  await page.click('.bottom-view button[data-bottom="profile"]');
  await expect(page.locator('#chart-dd')).toBeHidden();
  for (const a of ['x', 'y', 'z']) await expect(page.locator(`#profile-${a} canvas`)).toBeVisible();
  await expect(page.locator('#profile-x')).toHaveAttribute('aria-label', /^x プロファイル \(y = .+, z = .+ mm\)$/);

  // プロファイル上のホバー位置を断面にも印で示し、値表示もその点になる (外れると戻る)
  const pixels = () => page.locator('#panel-ref canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const plain = await pixels();
  const readout = await page.locator('#readout').textContent();
  const px = (await page.locator('#profile-x canvas').boundingBox())!;
  await page.mouse.move(px.x + px.width * 0.7, px.y + px.height * 0.5);
  await expect.poll(pixels).not.toBe(plain);
  await expect(page.locator('#readout')).not.toHaveText(readout!);
  await page.mouse.move(px.x + px.width * 0.7, px.y - 20);
  await expect.poll(pixels).toBe(plain);
  await expect(page.locator('#readout')).toHaveText(readout!);

  // Axial 表示では z 方向のプロファイル上の位置がスライスになる
  await expect(sliceLabel(page)).toHaveText(/^32\/64/);
  const box = (await page.locator('#profile-z canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await expect(page.locator('#profile-z .tooltip')).toContainText('z = ');
  await page.mouse.dblclick(box.x + box.width * 0.3, box.y + box.height * 0.5);
  const moved = Number((await sliceLabel(page).textContent())!.split('/')[0]);
  expect(moved).toBeLessThan(32);
  // 断面側でスライスを送ると、x プロファイルの見出し (z 座標) が追従する
  const before = await page.locator('#profile-x').getAttribute('aria-label');
  await page.locator('#slice').fill('40');
  await expect(page.locator('#profile-x')).not.toHaveAttribute('aria-label', before!);

  await analyze(page);
  await page.click('.bottom-view button[data-bottom="hist"]');
  await expect(page.locator('#chart-gamma canvas')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Ctrl+ホイールで 3 パネルが同期してズームし、ドラッグで移動、表示範囲の変更とリセットができる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page);
  await analyze(page);
  const pixels = (id: string) => page.locator(`${id} canvas`).evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const before = await Promise.all(['#panel-ref', '#panel-eval', '#panel-map'].map(pixels));

  const box = (await page.locator('#panel-ref canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await page.keyboard.down('Control');
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect(page.locator('#zoom-reset')).toBeVisible();
  await expect(page.locator('#zoom-reset')).toHaveText(/^×\d\.\d$/);
  await expect(sliceLabel(page)).toHaveText(/^32\/64/); // Ctrl+ホイールではスライスは動かない
  const zoomed = await Promise.all(['#panel-ref', '#panel-eval', '#panel-map'].map(pixels));
  zoomed.forEach((z, i) => expect(z).not.toBe(before[i]));

  // ドラッグで表示位置が動く (3 パネルとも)
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
  const panned = await Promise.all(['#panel-ref', '#panel-eval', '#panel-map'].map(pixels));
  panned.forEach((p, i) => expect(p).not.toBe(zoomed[i]));

  // ズーム中もホイールでスライス送り、ダブルクリックでカーソル移動ができる
  await page.mouse.wheel(0, 100);
  await expect(sliceLabel(page)).toHaveText(/^31\/64/);
  await page.click('.plane button[data-plane="sagittal"]');
  await expect(page.locator('#zoom-reset')).toBeHidden(); // ズームは断面ごと
  await page.click('.plane button[data-plane="axial"]');
  await expect(page.locator('#zoom-reset')).toBeVisible();

  // 表示範囲: 最大と低線量の閾値
  await page.click('.window-menu summary');
  await page.fill('#win-max', '1');
  await page.locator('#win-max').dispatchEvent('change');
  await expect(page.locator('#panel-ref .colorbar .ticks span').last()).toHaveText('1.00 Gy');
  await page.fill('#win-cut', '50');
  await page.locator('#win-cut').dispatchEvent('change');
  await expect(page.locator('#panel-eval .colorbar .extras')).toContainText('0.99 Gy');
  // 最小 ≥ 最大は不正 (赤枠にして既定の範囲で表示)
  await page.fill('#win-min', '2');
  await page.locator('#win-min').dispatchEvent('change');
  await expect(page.locator('#win-min')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#panel-ref .colorbar .ticks span').last()).toHaveText('1.98 Gy');

  // リセットで初期表示に戻る
  await page.click('#view-reset');
  await expect(page.locator('#zoom-reset')).toBeHidden();
  await expect(page.locator('#win-max')).toHaveValue('');
  await expect(page.locator('#panel-eval .colorbar .extras')).toHaveCount(0);
  await page.mouse.click(10, 10); // メニューの外をクリックすると閉じる
  await expect(page.locator('.window-menu')).not.toHaveAttribute('open', '');
  expect(await pixels('#panel-ref')).not.toBe(before[0]); // スライスは 31 のまま

  // ズームしたままでも PDF は出力できる (断面は全体を載せる)
  await page.keyboard.down('Control');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#pdf')]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect(errors).toEqual([]);
});

test('ヒストグラムのビンをクリックすると該当する点を断面上で強調し、スライス移動と解除ができる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await load(page);
  await analyze(page);
  const pixels = (id: string) => page.locator(`${id} canvas`).evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const before = await pixels('#panel-map');

  // γ ヒストグラムで度数のあるバーを右 (γ の大きい側) から探してクリックする
  const box = (await page.locator('#chart-gamma canvas').boundingBox())!;
  let clicked = false;
  for (let f = 0.9; f > 0.1 && !clicked; f -= 0.02) {
    await page.mouse.move(box.x + box.width * f, box.y + box.height * 0.7);
    const tip = page.locator('#chart-gamma .tooltip');
    if ((await tip.isVisible()) && !/: 0 点/.test((await tip.textContent()) ?? '')) {
      await page.mouse.click(box.x + box.width * f, box.y + box.height * 0.7);
      clicked = true;
    }
  }
  expect(clicked).toBe(true);
  const bar = page.locator('#chart-gamma .selection-bar');
  await expect(bar).toBeVisible();
  await expect(bar.locator('.text')).toHaveText(/^γ .+: [\d,]+ 点 \(表示中のスライス [\d,]+ 点\)$/);
  expect(await pixels('#panel-map')).not.toBe(before);

  // 次の該当スライスへ移動すると、そのスライスに該当点がある
  const next = bar.locator('button').nth(1);
  if (await next.isEnabled()) {
    const label = await sliceLabel(page).textContent();
    await next.click();
    await expect(sliceLabel(page)).not.toHaveText(label!);
    await expect(bar.locator('.text')).not.toContainText('(表示中のスライス 0 点)');
  }

  // 同じバーをもう一度クリックするか Esc で解除
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  // 別のヒストグラム (DD) で選ぶと、帯はそちらへ移る
  const ddBox = (await page.locator('#chart-dd canvas').boundingBox())!;
  await page.mouse.click(ddBox.x + ddBox.width * 0.5, ddBox.y + ddBox.height * 0.7);
  await expect(page.locator('#chart-dd .selection-bar .text')).toHaveText(/^DD .+%: /);
  await page.mouse.click(ddBox.x + ddBox.width * 0.5, ddBox.y + ddBox.height * 0.7);
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('結果を CSV・JSON・マップ (NRRD の ZIP) で書き出せ、値が画面と一致する', async ({ page }) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { gunzipSync } = await import('node:zlib');

  await load(page);
  await expect(page.locator('#export-csv')).toBeDisabled();
  await page.check('#p-batch');
  await analyze(page);
  const shownRate = Number((await page.locator('.stat .value').first().textContent())!.replace('%', ''));
  const save = async (id: string) => {
    const [d] = await Promise.all([page.waitForEvent('download'), page.click(id)]);
    return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
  };

  // CSV: 1 条件 1 行 (一括計算で 4 行)。患者情報は既定では含めない
  const csv = await save('#export-csv');
  expect(csv.name).toMatch(/^gamma3d_results_\d{8}_\d{4}\.csv$/);
  const lines = csv.bytes.toString('utf8').replace(/^﻿/, '').trim().split('\r\n');
  const header = lines[0].split(',');
  expect(lines).toHaveLength(5);
  expect(header).not.toContain('patient_id');
  const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [header[i], v])));
  expect(rows.map((r) => r.criteria)).toEqual(['3%/3mm', '3%/2mm', '2%/2mm', '1%/1mm']);
  expect(rows.filter((r) => r.shown === 'true')).toHaveLength(1);
  expect(Number(rows[0].gamma_pass_rate)).toBeCloseTo(shownRate, 2);

  // JSON: 患者情報を含めるとファイル名にも患者 ID が入る
  await page.check('#x-patient');
  const json = await save('#export-json');
  expect(json.name).toMatch(/^gamma3d_GAMMA3D-001_results_\d{8}_\d{4}\.json$/);
  const data = JSON.parse(json.bytes.toString('utf8'));
  expect(data.kind).toBe('gamma3d-results');
  expect(data.results).toHaveLength(4);
  expect(data.reference.patientId).toBe('GAMMA3D-001');
  expect(data.reference.grid.dims).toEqual([96, 88, 64]);
  expect(data.evaluated.shiftMm).toEqual([0, 0, 0]);

  // マップ: ZIP の中の NRRD。γ のマップから求めたパス率が画面の値と一致する
  const maps = await save('#export-maps');
  expect(maps.name).toMatch(/_maps_\d{8}_\d{4}\.zip$/);
  const dir = mkdtempSync(join(tmpdir(), 'gamma3d-maps-'));
  const zipPath = join(dir, 'maps.zip');
  (await import('node:fs')).writeFileSync(zipPath, maps.bytes);
  execFileSync('python3', ['-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zipPath, dir]);
  expect(readdirSync(dir).sort()).toEqual(['dd_gy.nrrd', 'dd_percent.nrrd', 'dta_mm.nrrd', 'eval_dose.nrrd', 'gamma.nrrd', 'maps.zip', 'ref_dose.nrrd', 'results.json']);
  const nrrd = readFileSync(join(dir, 'gamma.nrrd'));
  const split = nrrd.indexOf('\n\n');
  const head = nrrd.subarray(0, split).toString('latin1');
  expect(head).toContain('sizes: 96 88 64');
  expect(head).toContain('space: left-posterior-superior');
  const raw = gunzipSync(nrrd.subarray(split + 2));
  const gamma = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  let n = 0;
  let pass = 0;
  for (const g of gamma) {
    if (Number.isNaN(g)) continue;
    n++;
    if (g <= 1) pass++;
  }
  expect((100 * pass) / n).toBeCloseTo(shownRate, 2);
  await expect(page.locator('#export-status')).toContainText('書き出しました');
});
