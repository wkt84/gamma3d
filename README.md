# Gamma3D

> [!WARNING]
> **NOT FOR CLINICAL USE.** 本ソフトウェアは研究・教育・検証用です。医療機器として承認・認証されたものではなく、患者の診断・治療・治療計画の検証などの臨床判断に使用しないでください。計算結果の正確性は保証されません。

2 つの RTDOSE をブラウザ上で比較する 3 次元ガンマ解析ツールです。静的サイトとして配信でき、DICOM データはブラウザの外へ送信されません。

- 比較元 (Ref) と比較先 (Eval) の RTDOSE を読み込み、3D ガンマ・線量差 (DD)・DTA を計算する
- BEAM 線量は参照プランごとに自動で合算する (PLAN 線量と並んでいる場合は選択可)
- 結果は Axial / Sagittal / Coronal の断面表示と、DD・DTA・γ のヒストグラムで確認する
- PDF レポートを出力する (Noto Sans JP を埋め込み、日本語に対応)

## 使い方

1. 「比較元」「比較先」の枠に RTDOSE ファイルかフォルダをドロップする (クリックでファイル選択、「フォルダ選択」も可)。RTDOSE 以外のファイル (CT など) は自動的に無視されます。
2. 候補が複数ある場合 (PLAN と BEAM 合算など) は「線量」から選ぶ。線量を換算したい場合は「係数」を x / y で設定する (既定 1 / 1)。たとえば全分割の PLAN 線量を 1 回分にするなら 1 / 分割回数とする。2 つの枠の間のボタンで、比較元と比較先を係数ごと入れ替えられる。比較先の枠の「位置補正」に x/y/z (mm) を入れると、比較先を平行移動してから比較する (PDF にも記載される)。
3. 解析条件を設定し「解析実行」を押す。γ パス率の判定基準 (許容レベル・アクションレベル、既定は AAPM TG-218 の 95% / 90%) により、結果に合格・要確認・不合格が表示される (判定基準の変更は再解析なしで反映)。よく使う条件は「条件の保存・読み込み」で名前を付けて保存でき、ブラウザに残る。JSON で書き出し・読み込みできるので、施設内で共有できる。
4. 断面はダブルクリックで十字カーソルをその点へ移動する (他の断面の表示位置も変わる)。ホイールかスライダーでスライスを送ると、3 つのパネルが同期して動く。右上のプルダウンでマップを γ / 線量差 / DTA / 線量勾配 に切り替える。
5. 「PDF 出力」でレポートを保存する。断面画像は、表示中の十字カーソル位置のものが掲載されます。

## 解析仕様

| 項目 | 内容 |
|---|---|
| 計算格子 | 比較元の格子。比較先は三線形補間で参照し、比較先の範囲外にある点は評価しない |
| 正規化 | Global (基準線量 × DD%) / Local (各点の比較元線量 × DD%) |
| 基準線量 | 既定は比較元の最大線量。手入力も可。各閾値 (%) はこの線量に対する割合 |
| ガンマ | 比較元の線量が γ 閾値以上の点で評価する。探索半径は γ 上限 × DTA、刻みは DTA / 探索分割数 (既定 10)。格子探索に加え、隣り合う格子点の間で比較先と比較元の線量の大小が入れ替わる辺では、等線量面との交点も調べる (急勾配で γ の谷が刻みより細い場合の見逃しを防ぐ)。その後、最良点の周りを刻みの 1/8 まで詰める。上限以上の点は「≥ 上限」として扱う |
| 線量差 (DD) | 同じ位置での Eval − Ref。比較元の線量が DD 閾値以上の点で評価する。オプションで低勾配領域 (勾配 < 勾配閾値) に限定できる |
| DTA | 比較元の線量勾配が勾配閾値 (既定 3%/mm) 以上で、かつ γ 閾値以上の点で評価する。比較先が比較元と同じ線量になる面までの最短距離を、ガンマと同じ探索範囲で求める。見つからない点は「未検出」とする |
| 勾配 | 比較元の中心差分 (端は片側差分)。単位は基準線量に対する %/mm |
| γ1% | ガンマの 99 パーセンタイル |

## RTDOSE の対応範囲

- 非圧縮の Implicit / Explicit VR Little Endian、BitsAllocated は 16 か 32
- 向きは Axial 系のみ (行方向 = ±X、列方向 = ±Y)。Prone や FFS の反転には対応するが、斜め (oblique) の線量は非対応
- GridFrameOffsetVector は相対値 (先頭が 0) と絶対値の両形式に対応する。スライス間隔が不均一な場合は、最小間隔で再サンプリングする
- 格子の異なる BEAM 線量は、先頭ビームの格子へ補間して合算する (警告を表示)
- FrameOfReferenceUID や患者 ID が一致しない場合は警告を表示する。自動の位置合わせは行わない (手動の平行移動は可能)

## 開発

Node.js 24 を使います (Volta で固定済み)。

```sh
npm install
npm run gen:samples   # samples/ に合成 RTDOSE を作成 (比較元: PLAN、比較先: BEAM ×2、+1 mm ずれ・+1.5%・ホットスポット入り)
npm run dev           # 開発サーバー
npm test              # 単体テスト (Vitest)
npm run test:e2e      # E2E テスト (Playwright。初回は npx playwright install chromium)
npm run build         # 型チェック + dist/ へビルド
npm run preview       # ビルド結果の確認
```

ガンマ計算は、解析解・総当たりで求めた真値・pymedphys と照合しています (`npm run validate`、所要 10〜15 分)。方法と結果は [docs/validation.md](docs/validation.md) を参照してください。

GitHub Actions (`.github/workflows/ci.yml`) で、push と PR のたびに型チェック・単体テスト・ビルド・E2E テストを実行します。

計算は Web Worker のプールで、スライス単位に並列実行します。Worker の数は、ブラウザが報告する論理コア数 (最大 16) です。COOP/COEP ヘッダー (`vite.config.ts` / `vercel.json`) で `crossOriginIsolated` にしてあり、線量配列は SharedArrayBuffer で Worker 間で共有します。

### ガンマ探索カーネル (WebAssembly)

ガンマ探索の本体は、Rust で書いた WebAssembly (`wasm/src/lib.rs`) で実行します。TypeScript 版 (`src/core/gamma.ts` の `computeSlab`) と同じ計算で、結果はビット単位で一致します (`test/wasm.test.ts`)。速度は TypeScript 版の約 2 倍です。

- ビルド済みの `src/wasm/gamma3d_kernel.wasm` をコミットしているので、アプリのビルドに Rust は不要です。
- `wasm/` を変更したときは、`npm run build:wasm` で作り直してコミットします。ツールチェーンは `wasm/rust-toolchain.toml` で固定していて、CI でソースから再ビルドしたものと一致するかを確かめます。
- wasm を読み込めない環境では、自動で TypeScript 版で計算します。URL に `?engine=ts` を付けると、TypeScript 版に固定できます (切り分け用)。解析完了の表示に、どちらで計算したかが出ます。
- 計算内容を変えるときは、TypeScript 版と Rust 版の両方を直し、`npm test` で一致を、`npm run validate` で精度を確かめます。

### 構成

```
src/
  core/      volume.ts (格子・補間), gamma.ts (ガンマ/DD/DTA の計算), stats.ts, runner.ts (Worker プール)
  dicom/     rtdose.ts (RTDOSE の読み込みと座標の正規化), group.ts (プランごとのまとめ・BEAM 合算)
  worker/    gamma.worker.ts (wasm を読み込めなければ TypeScript 版で計算)
  wasm/      gamma3d_kernel.wasm (wasm/ からビルドしたもの。コミットする)
  ui/        断面描画・カラーマップ・ヒストグラム・パネル部品
  report/    pdf.ts (jsPDF。フォントは PDF 出力時に遅延読み込み)
  i18n/      ja.ts (UI と PDF の文言の辞書)、index.ts (辞書の切り替えと、HTML の data-i18n 属性への適用)
wasm/        Rust のガンマ探索カーネル (Cargo、rust-toolchain.toml)
scripts/     dicom-writer.ts (テスト・サンプル用の RTDOSE 書き出し), gen-samples.ts
public/fonts Noto Sans JP (SIL Open Font License、OFL.txt 同梱)
```

## デプロイ (Vercel)

GitHub リポジトリを Vercel に接続すると、`main` への push で自動デプロイされます。ビルド設定とヘッダーは `vercel.json` に定義してあり、Node のバージョンは `package.json` の `engines` (24.x) で指定しています。

## 今後の予定

[ROADMAP.md](ROADMAP.md) を参照してください。

## ライセンス

[MIT License](LICENSE)

同梱・利用しているサードパーティのライセンス:

- Noto Sans JP (`public/fonts/`): SIL Open Font License 1.1 ([OFL.txt](public/fonts/OFL.txt))。フォントは MIT ではなく OFL で配布します
- dicom-parser, jsPDF とその依存パッケージ: MIT (DOMPurify は MPL-2.0 / Apache-2.0 のデュアルライセンス、pako は MIT / Zlib)
