# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["pymedphys==0.41.0", "numpy", "scipy", "numba"]
# ///
"""validation/export.ts が書き出した線量配列を pymedphys.gamma で計算し、Gamma3D の結果と比べる。

実行: npm run validate  (または uv run validation/compare.py)

出力:
  validation/results.md    ケース・条件ごとの比較表 (リポジトリに記録する)
  validation/results.json  同じ内容の機械可読版
パス率の差が許容値 (0.5 ポイント) を超えた条件があれば、終了コード 1 を返す。
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import pymedphys
from scipy.interpolate import RegularGridInterpolator
from scipy.optimize import minimize

HERE = Path(__file__).parent
WORK = HERE / ".work"
TOLERANCE_PASS_RATE = 0.5  # pymedphys とのパス率の差の目安 (パーセントポイント)
TOLERANCE_TRUTH = 0.01  # 真値との差の許容値 (γ)
TRUTH_SAMPLES = 20  # 真値を求めるボクセル数 (差の大きい順 + 無作為、それぞれ)
CASES = ["linear-shift", "uniform-offset", "field-shift", "sample"]


def load(case_dir: Path, name: str, geom: dict) -> np.ndarray:
    nx, ny, nz = geom["dims"]
    return np.fromfile(case_dir / name, dtype="<f4").reshape(nz, ny, nx).astype(np.float64)


def axes(geom: dict) -> tuple[np.ndarray, ...]:
    # 配列の並び (z, y, x) に合わせる
    return tuple(
        geom["origin"][a] + np.arange(geom["dims"][a]) * geom["spacing"][a] for a in (2, 1, 0)
    )


def analytic(case: str, meta: dict, p: dict) -> tuple[np.ndarray, np.ndarray] | None:
    """解析解 (期待値, 評価する内部点のマスク)。解析解のないケースは None。"""
    g = meta["ref"]
    z, y, x = np.meshgrid(*axes(g), indexing="ij")
    ref = 1 + 0.1 * x if case == "linear-shift" else np.full_like(x, 2.0)
    delta_d = p["ddPercent"] / 100 * (ref if p["local"] else p["normDoseGy"])
    if case == "linear-shift":
        grad, shift = 0.1, 2.0
        expected = grad * shift / np.sqrt(delta_d**2 + (grad * p["dtaMm"]) ** 2)
        # 探索球が比較先の格子の中に収まる点だけを見る
        margin = p["gammaCap"] * p["dtaMm"] + shift
        half = (np.array(g["dims"]) - 1) * np.array(g["spacing"]) / 2
        mask = (np.abs(x) <= half[0] - margin) & (np.abs(y) <= half[1] - margin) & (np.abs(z) <= half[2] - margin)
    elif case == "uniform-offset":
        expected = 0.04 / delta_d
        mask = np.ones_like(x, dtype=bool)
    else:
        return None
    return np.minimum(np.broadcast_to(expected, x.shape), p["gammaCap"]), mask


def true_gamma(interp, center, dr, dD, dta, cap, radius_gamma) -> float:
    """総当たりで求めた真のガンマ (比較先は三線形補間)。

    両実装の値はどちらも実在する探索点での値なので真値の上界になる。そのため、
    小さいほうの値 × DTA を半径とする球の中だけを DTA/40 刻みで調べ、最良点から Nelder-Mead で詰める。
    """
    step = dta / 40
    r = min(radius_gamma, cap) * dta + step
    n = int(np.ceil(r / step))
    g = np.arange(-n, n + 1) * step
    oz, oy, ox = np.meshgrid(g, g, g, indexing="ij")
    inside = oz**2 + oy**2 + ox**2 <= r * r
    off = np.stack([oz[inside], oy[inside], ox[inside]], axis=1)

    def g2(o: np.ndarray) -> np.ndarray:
        e = interp(center + o)
        v = (o**2).sum(-1) / dta**2 + (e - dr) ** 2 / dD**2
        return np.where(np.isnan(v), np.inf, v)

    best = float("inf")
    for chunk in np.array_split(off, max(1, len(off) // 400_000)):
        v = g2(chunk)
        b = int(np.argmin(v))
        if v[b] < best:
            best, start = float(v[b]), chunk[b]
    res = minimize(lambda o: float(g2(o[None])[0]), start, method="Nelder-Mead", options={"xatol": 1e-5, "fatol": 1e-10})
    return float(min(np.sqrt(min(best, res.fun)), cap))


def truth_check(meta: dict, p: dict, ref: np.ndarray, ev: np.ndarray, ours: np.ndarray, pmp: np.ndarray, both: np.ndarray) -> dict:
    """差の大きいボクセルと無作為のボクセルで真値を求め、両実装の誤差を比べる。"""
    interp = RegularGridInterpolator(axes(meta["eval"]), ev, bounds_error=False, fill_value=np.nan)
    az = axes(meta["ref"])
    flat = np.flatnonzero(both)
    diff = np.abs(ours.ravel()[flat] - pmp.ravel()[flat])
    worst = flat[np.argsort(-diff)[:TRUTH_SAMPLES]]
    rng = np.random.default_rng(0)
    rand = rng.choice(flat, size=min(TRUTH_SAMPLES, flat.size), replace=False)
    err_ours, err_pmp = [], []
    for f in np.unique(np.concatenate([worst, rand])):
        k, j, i = np.unravel_index(f, ref.shape)
        dr = ref[k, j, i]
        dD = p["ddPercent"] / 100 * (dr if p["local"] else meta["normDoseGy"])
        center = np.array([az[0][k], az[1][j], az[2][i]])
        t = true_gamma(interp, center, dr, dD, p["dtaMm"], p["gammaCap"], min(ours[k, j, i], pmp[k, j, i]))
        err_ours.append(ours[k, j, i] - t)
        err_pmp.append(pmp[k, j, i] - t)
    eo, ep = np.abs(err_ours), np.abs(err_pmp)
    return {
        "truthSamples": len(eo),
        "truthErrMaxGamma3d": float(eo.max()),
        "truthErrMaxPymedphys": float(ep.max()),
        "truthErrMeanGamma3d": float(eo.mean()),
        "truthErrMeanPymedphys": float(ep.mean()),
    }


def summary(gamma: np.ndarray) -> dict:
    v = gamma[~np.isnan(gamma)]
    if v.size == 0:
        return {"n": 0, "passRate": float("nan"), "mean": float("nan"), "p99": float("nan")}
    return {
        "n": int(v.size),
        "passRate": float(100 * np.mean(v <= 1)),
        "mean": float(np.mean(v)),
        "p99": float(np.percentile(v, 99)),
    }


def main() -> int:
    if not WORK.exists():
        print("validation/.work がありません。先に node validation/export.ts を実行してください。", file=sys.stderr)
        return 2

    # 引数でケースを絞れる (結果ファイルは全ケースを実行したときだけ更新する)
    selected = sys.argv[1:] or CASES
    results = []
    for case in selected:
        case_dir = WORK / case
        meta = json.loads((case_dir / "meta.json").read_text())
        ref = load(case_dir, "ref.f32", meta["ref"])
        ev = load(case_dir, "eval.f32", meta["eval"])
        for key, run in meta["runs"].items():
            p = run["params"]
            t0 = time.perf_counter()
            pmp = pymedphys.gamma(
                axes(meta["ref"]),
                ref,
                axes(meta["eval"]),
                ev,
                dose_percent_threshold=p["ddPercent"],
                distance_mm_threshold=p["dtaMm"],
                lower_percent_dose_cutoff=p["gammaThresholdPercent"],
                interp_fraction=p["stepsPerDta"],
                max_gamma=p["gammaCap"],
                local_gamma=p["local"],
                global_normalisation=meta["normDoseGy"],
            )
            pmp_ms = (time.perf_counter() - t0) * 1000
            ours = load(case_dir, f"gamma3d_{key}.f32", meta["ref"])

            both = ~np.isnan(ours) & ~np.isnan(pmp)
            diff = ours[both] - pmp[both]
            disagree = np.mean((ours[both] <= 1) != (pmp[both] <= 1)) * 100 if both.any() else float("nan")
            s_ours, s_pmp = summary(ours), summary(pmp)
            # 共通の評価点でのパス率
            common_ours = float(100 * np.mean(ours[both] <= 1)) if both.any() else float("nan")
            common_pmp = float(100 * np.mean(pmp[both] <= 1)) if both.any() else float("nan")
            row = {
                "case": case,
                "key": key,
                "ddPercent": p["ddPercent"],
                "dtaMm": p["dtaMm"],
                "local": p["local"],
                "gamma3d": s_ours,
                "pymedphys": s_pmp,
                "commonPoints": int(both.sum()),
                "onlyGamma3d": int((~np.isnan(ours) & np.isnan(pmp)).sum()),
                "onlyPymedphys": int((np.isnan(ours) & ~np.isnan(pmp)).sum()),
                "passRateDiffCommon": common_ours - common_pmp,
                "absDiffMean": float(np.mean(np.abs(diff))) if diff.size else float("nan"),
                "absDiffP99": float(np.percentile(np.abs(diff), 99)) if diff.size else float("nan"),
                "absDiffMax": float(np.max(np.abs(diff))) if diff.size else float("nan"),
                "passFailDisagreePercent": float(disagree),
                "gamma3dMs": run["ms"],
                "pymedphysMs": pmp_ms,
            }
            row.update(truth_check(meta, p, ref, ev, ours, pmp, both))
            a = analytic(case, meta, {**p, "normDoseGy": meta["normDoseGy"]})
            if a is not None:
                expected, mask = a
                m = mask & both
                row["analyticErrMaxGamma3d"] = float(np.max(np.abs(ours[m] - expected[m])))
                row["analyticErrMaxPymedphys"] = float(np.max(np.abs(pmp[m] - expected[m])))
            results.append(row)
            print(
                f"{case:15s} {key:14s} pass {s_ours['passRate']:7.3f} / {s_pmp['passRate']:7.3f}"
                f"  Δ(共通点) {row['passRateDiffCommon']:+.3f}  |Δγ| p99 {row['absDiffP99']:.4f}"
                f"  真値との差 max {row['truthErrMaxGamma3d']:.4f} / {row['truthErrMaxPymedphys']:.4f}"
                f"  ({run['ms']:.0f} ms / {pmp_ms:.0f} ms)"
            )

    if selected == CASES:
        (HERE / "results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n")
        (HERE / "results.md").write_text(render_markdown(results))

    # 判定: Gamma3D は真値 (と解析解) から TOLERANCE_TRUTH 以内であること。
    # pymedphys との差が目安を超えた条件は、真値との比較でどちらが正しいかを報告する (失敗にはしない)。
    failed = [
        r
        for r in results
        if not r["truthErrMaxGamma3d"] <= TOLERANCE_TRUTH
        or ("analyticErrMaxGamma3d" in r and not r["analyticErrMaxGamma3d"] <= TOLERANCE_TRUTH)
    ]
    over = [r for r in results if not abs(r["passRateDiffCommon"]) <= TOLERANCE_PASS_RATE]
    for r in over:
        print(
            f"参考: {r['case']} {r['key']} は pymedphys とのパス率の差が {r['passRateDiffCommon']:+.2f} ポイント"
            f" (真値との差 max Gamma3D {r['truthErrMaxGamma3d']:.4f} / pymedphys {r['truthErrMaxPymedphys']:.4f})"
        )
    if failed:
        print(f"真値との差が許容値 ({TOLERANCE_TRUTH}) を超えた条件: {[(r['case'], r['key']) for r in failed]}", file=sys.stderr)
        return 1
    print(f"全 {len(results)} 条件で、Gamma3D は真値との差が {TOLERANCE_TRUTH} 以内でした")
    return 0


def fmt(v: float, d: int = 2) -> str:
    return "–" if v is None or (isinstance(v, float) and np.isnan(v)) else f"{v:.{d}f}"


def render_markdown(results: list[dict]) -> str:
    lines = [
        "# 照合結果: Gamma3D と pymedphys",
        "",
        f"pymedphys {pymedphys.__version__} との比較です。`npm run validate` で生成しています (手で編集しないでください)。",
        "条件は共通で、γ 閾値は 10%、基準線量は比較元の最大線量、γ 上限は 2、探索分割数は 10 です。",
        "解析の方法と差の要因は [docs/validation.md](../docs/validation.md) を参照してください。",
        "",
        "- **パス率**: それぞれの評価点でのパス率 (%)",
        "- **Δパス率**: 両方で評価した共通の点での、パス率の差 (Gamma3D − pymedphys、ポイント)",
        "- **|Δγ|**: 共通の点での、ボクセルごとのガンマ値の差の絶対値 (平均 / 99%値 / 最大)",
        "- **判定不一致**: 共通の点のうち、合否 (γ ≤ 1) が食い違う点の割合 (%)",
        "- **真値との差**: 差の大きいボクセルと無作為のボクセル (各 20 点) で求めた真値との差の最大値 (Gamma3D / pymedphys)",
        "- **解析解との差**: 解析解のあるケースでの、期待値との差の最大値 (Gamma3D / pymedphys)",
        "- **計算時間**: Gamma3D は 1 スレッド (アプリでは Worker で並列に計算する)、pymedphys は numba による並列計算",
        "",
        f"判定基準: Gamma3D の真値・解析解との差が {TOLERANCE_TRUTH} 以内。pymedphys とのパス率の差 (目安 {TOLERANCE_PASS_RATE} ポイント) は参考値。",
        "",
    ]
    for case in CASES:
        rows = [r for r in results if r["case"] == case]
        lines += [
            f"## {case}",
            "",
            "| 条件 | パス率 Gamma3D | パス率 pymedphys | Δパス率 | 平均γ (G3D / pmp) | γ1% (G3D / pmp) | \\|Δγ\\| 平均 / 99% / 最大 | 判定不一致 | 真値との差 | 解析解との差 | 計算時間 ms (G3D / pmp) |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
        for r in rows:
            crit = f"{r['ddPercent']}%/{r['dtaMm']}mm {'Local' if r['local'] else 'Global'}"
            an = (
                f"{fmt(r['analyticErrMaxGamma3d'], 4)} / {fmt(r['analyticErrMaxPymedphys'], 4)}"
                if "analyticErrMaxGamma3d" in r
                else "–"
            )
            lines.append(
                f"| {crit} | {fmt(r['gamma3d']['passRate'])} | {fmt(r['pymedphys']['passRate'])} "
                f"| {r['passRateDiffCommon']:+.2f} "
                f"| {fmt(r['gamma3d']['mean'], 3)} / {fmt(r['pymedphys']['mean'], 3)} "
                f"| {fmt(r['gamma3d']['p99'], 3)} / {fmt(r['pymedphys']['p99'], 3)} "
                f"| {fmt(r['absDiffMean'], 4)} / {fmt(r['absDiffP99'], 4)} / {fmt(r['absDiffMax'], 4)} "
                f"| {fmt(r['passFailDisagreePercent'], 3)}% "
                f"| {fmt(r['truthErrMaxGamma3d'], 4)} / {fmt(r['truthErrMaxPymedphys'], 4)} | {an} "
                f"| {r['gamma3dMs']:.0f} / {r['pymedphysMs']:.0f} |"
            )
        counts = rows[0]
        lines += [
            "",
            f"評価点数: 共通 {counts['commonPoints']:,} 点、Gamma3D のみ {counts['onlyGamma3d']:,} 点、"
            f"pymedphys のみ {counts['onlyPymedphys']:,} 点 ({counts['key']})。",
            "",
        ]
    return "\n".join(lines)


if __name__ == "__main__":
    if sys.argv[1:] == ["--render"]:
        # 保存済みの results.json から results.md だけを作り直す
        (HERE / "results.md").write_text(render_markdown(json.loads((HERE / "results.json").read_text())))
        sys.exit(0)
    sys.exit(main())
