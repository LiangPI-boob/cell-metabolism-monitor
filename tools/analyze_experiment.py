# -*- coding: utf-8 -*-
"""分析 NanoStat 主机导出的 experiment.csv。

只使用 Python 标准库，不需要安装 matplotlib / pandas。

用法：
    python analyze_experiment.py experiment.csv
    python analyze_experiment.py experiment.csv --nominal 5.0
    python analyze_experiment.py experiment.csv --nominal 5.0 --out-dir D:\\Nanostat\\results
    python analyze_experiment.py --demo

输入列（主机会自动写入）：
    uptime_ms, session_ms, cycle, type, current_uA, conc_mM,
    slope_uA_per_mM, intercept_uA, note

输出：
    <输入名>_summary.txt   文本汇总
    <输入名>_summary.csv   每个会话一行的汇总表
    <输入名>_curve.svg     浓度（或电流）随时间变化曲线
"""

import argparse
import csv
import html
import math
import os
import random
import statistics
import tempfile


# ------------------------------------------------------------
# 读取与分组
# ------------------------------------------------------------
def parse_float(value):
    if value is None:
        return None
    value = str(value).strip()
    if value == "":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def load_sessions(path):
    """把 CSV 按 SESSION_START 分成多个会话。"""
    sessions = []
    current = None

    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise ValueError("CSV 没有表头")
        for row in reader:
            row_type = (row.get("type") or "").strip().upper()
            if row_type == "SESSION_START":
                current = {"index": len(sessions) + 1, "measures": []}
                sessions.append(current)
                continue

            if current is None:
                current = {"index": 1, "measures": []}
                sessions.append(current)

            if row_type != "MEASURE":
                continue

            uptime_ms = parse_float(row.get("uptime_ms"))
            session_ms = parse_float(row.get("session_ms"))
            t_ms = session_ms if session_ms is not None else uptime_ms
            if t_ms is None:
                continue

            current["measures"].append({
                "cycle": (row.get("cycle") or "").strip(),
                "t_ms": t_ms,
                "current": parse_float(row.get("current_uA")),
                "conc": parse_float(row.get("conc_mM")),
                "slope": parse_float(row.get("slope_uA_per_mM")),
                "intercept": parse_float(row.get("intercept_uA")),
                "note": (row.get("note") or "").strip(),
            })

    return [s for s in sessions if s["measures"]]


# ------------------------------------------------------------
# 统计
# ------------------------------------------------------------
def mean_std(values):
    if not values:
        return None, None
    if len(values) == 1:
        return values[0], 0.0
    return statistics.mean(values), statistics.pstdev(values)


def linear_fit(xs, ys):
    """最小二乘拟合 y = k*x + b，返回 (k, b, r2)。"""
    n = len(xs)
    if n < 2:
        return 0.0, (ys[0] if ys else 0.0), 0.0
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    sxx = sum((x - mean_x) ** 2 for x in xs)
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    k = sxy / sxx if sxx > 1e-12 else 0.0
    b = mean_y - k * mean_x
    ss_tot = sum((y - mean_y) ** 2 for y in ys)
    ss_res = sum((y - (k * x + b)) ** 2 for x, y in zip(xs, ys))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 1e-12 else 1.0
    return k, b, r2


def summarize(session, nominal=None):
    measures = session["measures"]
    times_h = [m["t_ms"] / 3600000.0 for m in measures]
    currents = [m["current"] for m in measures if m["current"] is not None]
    concs = [m["conc"] for m in measures if m["conc"] is not None]

    duration_h = (max(times_h) - min(times_h)) if times_h else 0.0
    c_mean, c_std = mean_std(concs)
    i_mean, i_std = mean_std(currents)

    drift = None
    change_pct = None
    if len(concs) >= 2:
        drift, _, _ = linear_fit(times_h, concs)
        if abs(concs[0]) > 1e-9:
            change_pct = (concs[-1] - concs[0]) / concs[0] * 100.0

    recovery = None
    if nominal is not None and nominal != 0 and concs:
        recovery = [c / nominal * 100.0 for c in concs]

    return {
        "index": session["index"],
        "count": len(measures),
        "duration_h": duration_h,
        "current_mean": i_mean,
        "current_std": i_std,
        "current_min": min(currents) if currents else None,
        "current_max": max(currents) if currents else None,
        "conc_mean": c_mean,
        "conc_std": c_std,
        "conc_min": min(concs) if concs else None,
        "conc_max": max(concs) if concs else None,
        "conc_first": concs[0] if concs else None,
        "conc_last": concs[-1] if concs else None,
        "drift": drift,
        "change_pct": change_pct,
        "recovery_mean": statistics.mean(recovery) if recovery else None,
        "recovery_min": min(recovery) if recovery else None,
        "recovery_max": max(recovery) if recovery else None,
        "recovery_std": statistics.pstdev(recovery) if recovery and len(recovery) > 1 else 0.0 if recovery else None,
    }


def fmt(value, digits=4, suffix=""):
    if value is None:
        return "--"
    return ("%." + str(digits) + "f%s") % (value, suffix)


# ------------------------------------------------------------
# 文本 / CSV 输出
# ------------------------------------------------------------
def write_summary_text(path, source, summaries, nominal):
    lines = []
    lines.append("=== 细胞代谢监测 · 实验数据分析 ===")
    lines.append("数据文件: %s" % source)
    lines.append("会话数: %d" % len(summaries))
    if nominal is not None:
        lines.append("标称浓度: %s mM" % fmt(nominal, 4))
    lines.append("")

    for s in summaries:
        lines.append("--- 会话 %d ---" % s["index"])
        lines.append("测量点: %d" % s["count"])
        lines.append("时长: %s h" % fmt(s["duration_h"], 2))
        lines.append("电流 (uA): 均值 %s, 标准差 %s, 范围 %s ~ %s" % (
            fmt(s["current_mean"], 4), fmt(s["current_std"], 4),
            fmt(s["current_min"], 4), fmt(s["current_max"], 4)))
        lines.append("浓度 (mM): 均值 %s, 标准差 %s, 范围 %s ~ %s" % (
            fmt(s["conc_mean"], 4), fmt(s["conc_std"], 4),
            fmt(s["conc_min"], 4), fmt(s["conc_max"], 4)))
        lines.append("首/末浓度: %s / %s mM (变化 %s)" % (
            fmt(s["conc_first"], 4), fmt(s["conc_last"], 4),
            fmt(s["change_pct"], 2, "%")))
        lines.append("漂移斜率: %s mM/h" % fmt(s["drift"], 6))
        if s["recovery_mean"] is not None:
            lines.append("回收率: 均值 %s, 范围 %s ~ %s, 标准差 %s" % (
                fmt(s["recovery_mean"], 2, "%"),
                fmt(s["recovery_min"], 2, "%"),
                fmt(s["recovery_max"], 2, "%"),
                fmt(s["recovery_std"], 2, "%")))
        lines.append("")

    text = "\n".join(lines)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return text


def write_summary_csv(path, summaries):
    fields = [
        "session", "count", "duration_h",
        "current_mean_uA", "current_std_uA", "current_min_uA", "current_max_uA",
        "conc_mean_mM", "conc_std_mM", "conc_min_mM", "conc_max_mM",
        "conc_first_mM", "conc_last_mM", "drift_mM_per_h", "change_pct",
        "recovery_mean_pct", "recovery_min_pct", "recovery_max_pct", "recovery_std_pct",
    ]
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for s in summaries:
            writer.writerow({
                "session": s["index"],
                "count": s["count"],
                "duration_h": s["duration_h"],
                "current_mean_uA": s["current_mean"],
                "current_std_uA": s["current_std"],
                "current_min_uA": s["current_min"],
                "current_max_uA": s["current_max"],
                "conc_mean_mM": s["conc_mean"],
                "conc_std_mM": s["conc_std"],
                "conc_min_mM": s["conc_min"],
                "conc_max_mM": s["conc_max"],
                "conc_first_mM": s["conc_first"],
                "conc_last_mM": s["conc_last"],
                "drift_mM_per_h": s["drift"],
                "change_pct": s["change_pct"],
                "recovery_mean_pct": s["recovery_mean"],
                "recovery_min_pct": s["recovery_min"],
                "recovery_max_pct": s["recovery_max"],
                "recovery_std_pct": s["recovery_std"],
            })


# ------------------------------------------------------------
# 纯标准库 SVG 曲线
# ------------------------------------------------------------
def nice_ticks(vmin, vmax, count=5):
    if vmin == vmax:
        return [vmin]
    span = vmax - vmin
    step = span / (count - 1)
    return [vmin + step * i for i in range(count)]


def write_svg(path, sessions, title):
    width, height = 960, 460
    left, right, top, bottom = 80, 30, 50, 60
    plot_w = width - left - right
    plot_h = height - top - bottom

    series = []
    for s in sessions:
        pts = [(m["t_ms"] / 3600000.0, m["conc"] if m["conc"] is not None else m["current"])
               for m in s["measures"]]
        pts = [(x, y) for x, y in pts if y is not None]
        if pts:
            series.append((s["index"], pts))

    if not series:
        raise ValueError("没有可画的数据")

    all_pts = [p for _, pts in series for p in pts]
    xs = [p[0] for p in all_pts]
    ys = [p[1] for p in all_pts]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    if xmax - xmin < 1e-9:
        xmax = xmin + 1.0
    pad_y = (ymax - ymin) * 0.1 if ymax - ymin > 1e-9 else max(abs(ymax) * 0.1, 1.0)
    ymin -= pad_y
    ymax += pad_y

    def sx(x):
        return left + (x - xmin) / (xmax - xmin) * plot_w

    def sy(y):
        return top + plot_h - (y - ymin) / (ymax - ymin) * plot_h

    colors = ["#0d6efd", "#198754", "#dc3545", "#fd7e14", "#6f42c1"]
    parts = []
    parts.append('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">' % (width, height, width, height))
    parts.append('<rect width="100%%" height="100%%" fill="#ffffff"/>')
    parts.append('<text x="%d" y="28" font-family="Microsoft YaHei, sans-serif" font-size="18" font-weight="bold" fill="#1f2937">%s</text>' % (left, html.escape(title)))
    parts.append('<rect x="%d" y="%d" width="%d" height="%d" fill="#fbfcfe" stroke="#e3e8ef"/>' % (left, top, plot_w, plot_h))

    for tick in nice_ticks(ymin, ymax, 5):
        y = sy(tick)
        parts.append('<line x1="%d" y1="%.2f" x2="%d" y2="%.2f" stroke="#e9edf3"/>' % (left, y, left + plot_w, y))
        parts.append('<text x="%d" y="%.2f" font-family="Consolas, monospace" font-size="11" text-anchor="end" fill="#6b7280">%.3f</text>' % (left - 8, y + 4, tick))

    for tick in nice_ticks(xmin, xmax, 6):
        x = sx(tick)
        parts.append('<line x1="%.2f" y1="%d" x2="%.2f" y2="%d" stroke="#e9edf3"/>' % (x, top, x, top + plot_h))
        parts.append('<text x="%.2f" y="%d" font-family="Consolas, monospace" font-size="11" text-anchor="middle" fill="#6b7280">%.2f</text>' % (x, top + plot_h + 18, tick))

    for idx, (session_index, pts) in enumerate(series):
        color = colors[idx % len(colors)]
        d = " ".join("%.2f,%.2f" % (sx(x), sy(y)) for x, y in pts)
        parts.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="2"/>' % (d, color))
        parts.append('<circle cx="%.2f" cy="%.2f" r="2.5" fill="%s"/>' % (sx(pts[-1][0]), sy(pts[-1][1]), color))
        lx = left + 12 + idx * 120
        parts.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s" stroke-width="3"/>' % (lx, top + 16, lx + 22, top + 16, color))
        parts.append('<text x="%d" y="%d" font-family="Microsoft YaHei, sans-serif" font-size="12" fill="#374151">会话 %d</text>' % (lx + 28, top + 20, session_index))

    parts.append('<text x="%d" y="%d" font-family="Microsoft YaHei, sans-serif" font-size="12" text-anchor="middle" fill="#6b7280">时间 (h)</text>' % (left + plot_w // 2, height - 18))
    parts.append('<text x="18" y="%d" font-family="Microsoft YaHei, sans-serif" font-size="12" text-anchor="middle" fill="#6b7280" transform="rotate(-90 18 %d)">浓度 (mM) / 电流 (uA)</text>' % (top + plot_h // 2, top + plot_h // 2))
    parts.append('</svg>')

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))


# ------------------------------------------------------------
# 演示数据
# ------------------------------------------------------------
def make_demo_csv(path, hours=72.0, interval_min=15.0, nominal=5.0):
    """生成 72 h、每 15 min 一个点、带缓慢漂移和噪声的演示数据。"""
    rows = []
    rows.append(["uptime_ms", "session_ms", "cycle", "type", "current_uA",
                 "conc_mM", "slope_uA_per_mM", "intercept_uA", "note"])
    rows.append(["5000", "0", "0", "SESSION_START", "0", "", "2.4", "1.0", ""])

    slope = 2.4
    intercept = 1.0
    total_min = int(hours * 60)
    cycle = 0
    t_min = 0
    while t_min <= total_min:
        t_h = t_min / 60.0
        cycle += 1
        conc = nominal - 0.0045 * t_h + random.gauss(0, 0.025)
        if cycle in (37, 128):
            conc -= 0.35  # 两个异常点
        current = slope * conc + intercept + random.gauss(0, 0.03)
        t_ms = int(t_min * 60000)
        rows.append([str(5000 + t_ms), str(t_ms), str(cycle), "MEASURE",
                     "%.5f" % current, "%.5f" % conc, "%.4f" % slope,
                     "%.4f" % intercept, ""])
        t_min += int(interval_min)

    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(rows)
    return nominal


# ------------------------------------------------------------
# 入口
# ------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="分析 NanoStat 的 experiment.csv")
    parser.add_argument("csv", nargs="?", help="experiment.csv 路径")
    parser.add_argument("--nominal", type=float, default=None,
                        help="标称浓度 (mM)，用于计算回收率")
    parser.add_argument("--out-dir", default=None, help="输出目录")
    parser.add_argument("--demo", action="store_true", help="用合成的 72 h 数据自检")
    args = parser.parse_args()

    if args.demo:
        temp_dir = tempfile.mkdtemp(prefix="nanostat_demo_")
        csv_path = os.path.join(temp_dir, "experiment.csv")
        nominal = make_demo_csv(csv_path, nominal=args.nominal or 5.0)
        source = csv_path
        out_dir = args.out_dir or temp_dir
        if args.nominal is None:
            args.nominal = nominal
    else:
        if not args.csv:
            parser.error("请提供 experiment.csv，或使用 --demo")
        csv_path = args.csv
        source = os.path.abspath(csv_path)
        out_dir = args.out_dir or os.path.dirname(source) or "."
        if not os.path.exists(csv_path):
            parser.error("文件不存在: %s" % csv_path)

    os.makedirs(out_dir, exist_ok=True)
    sessions = load_sessions(csv_path)
    if not sessions:
        print("没有找到 MEASURE 数据。")
        return 1

    base = os.path.splitext(os.path.basename(csv_path))[0]
    text_path = os.path.join(out_dir, base + "_summary.txt")
    csv_out_path = os.path.join(out_dir, base + "_summary.csv")
    svg_path = os.path.join(out_dir, base + "_curve.svg")

    summaries = [summarize(s, args.nominal) for s in sessions]
    text = write_summary_text(text_path, source, summaries, args.nominal)
    write_summary_csv(csv_out_path, summaries)
    write_svg(svg_path, sessions, "细胞代谢监测 · 浓度/电流曲线")

    print(text)
    print("已生成:")
    print("  " + text_path)
    print("  " + csv_out_path)
    print("  " + svg_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
