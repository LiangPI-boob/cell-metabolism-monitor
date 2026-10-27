# -*- coding: utf-8 -*-
"""软硬联合校准 + 自适应调度 —— 离线验证脚本

用合成数据验证老师四条意见中的两条（①算法校准 ②自适应调度），
不依赖任何硬件，直接运行：

    python tools/calibration_sim.py

电极灵敏度漂移用「指数趋近」模型（早期漂移快、后期趋稳，符合酶电极漂移
的常见规律），对比三种策略的浓度回收率误差。
只依赖 Python 标准库。
"""

import math
import random


# ============ 仿真参数 ============
C_TRUE = 5.0              # 标准液真实浓度 (mM)
SLOPE0 = 2.4              # 初始灵敏度 (uA/mM)
SLOPE_INF = 2.0           # 灵敏度最终稳定值 (uA/mM)
SLOPE_TAU = 12.0          # 漂移时间常数 (h)，越小早期漂移越快
INTERCEPT0 = 1.0          # 初始截距 (uA)
INTERCEPT_INF = 1.15      # 截距最终稳定值 (uA)
INTERCEPT_TAU = 12.0      # 截距漂移时间常数 (h)
WALK_SLOPE = 0.002        # 灵敏度随机游走步长（小扰动）
WALK_INTERCEPT = 0.0005   # 截距随机游走步长
NOISE = 0.02              # 测量噪声 (uA)
DT = 0.25                 # 测量间隔 (h)，每 15 min 一个点
TOTAL_H = 72.0            # 总时长 (h)


def gen_true_series():
    """生成真实（对算法不可见）的 slope/intercept 序列：指数漂移 + 小随机游走。"""
    n = int(TOTAL_H / DT) + 1
    times = [i * DT for i in range(n)]
    slopes, intercepts = [], []
    walk_s, walk_i = 0.0, 0.0
    for k in range(n):
        t = times[k]
        s_true = SLOPE_INF + (SLOPE0 - SLOPE_INF) * math.exp(-t / SLOPE_TAU)
        i_true = INTERCEPT_INF + (INTERCEPT0 - INTERCEPT_INF) * math.exp(-t / INTERCEPT_TAU)
        walk_s += random.gauss(0, WALK_SLOPE)
        walk_i += random.gauss(0, WALK_INTERCEPT)
        slopes.append(s_true + walk_s)
        intercepts.append(i_true + walk_i)
    return times, slopes, intercepts


def gen_measurements(times, slopes, intercepts):
    """按真实 slope/intercept 生成带噪声的测量电流序列（三种策略共享同一份）。"""
    return [slopes[k] * C_TRUE + intercepts[k] + random.gauss(0, NOISE)
            for k in range(len(times))]


def estimate_concentration(current, slope, intercept):
    return (current - intercept) / slope


def interpolate(calib, t):
    """在两次校准点之间线性插值 slope/intercept。calib: [(t,s,i), ...] 按 t 升序。"""
    if t <= calib[0][0]:
        return calib[0][1], calib[0][2]
    if t >= calib[-1][0]:
        return calib[-1][1], calib[-1][2]
    for k in range(len(calib) - 1):
        t0, s0, i0 = calib[k]
        t1, s1, i1 = calib[k + 1]
        if t0 <= t <= t1:
            frac = (t - t0) / (t1 - t0)
            return s0 + frac * (s1 - s0), i0 + frac * (i1 - i0)
    return calib[-1][1], calib[-1][2]


def rmse(errors):
    return (sum(e * e for e in errors) / len(errors)) ** 0.5 if errors else 0.0


def run_fixed(times, slopes, intercepts, measurements, interval):
    """策略 A：固定间隔校准 + 无补偿（现状）。"""
    errors, calib_count = [], 0
    slope_cal, intercept_cal = SLOPE0, INTERCEPT0
    next_calib = 0.0
    for k, t in enumerate(times):
        if t >= next_calib - 1e-9:
            slope_cal, intercept_cal = slopes[k], intercepts[k]
            next_calib += interval
            calib_count += 1
        c = estimate_concentration(measurements[k], slope_cal, intercept_cal)
        errors.append((c - C_TRUE) / C_TRUE * 100.0)
    return errors, calib_count


def run_fixed_comp(times, slopes, intercepts, measurements, interval):
    """策略 B：固定间隔校准 + 线性漂移补偿（离线：先用完整校准点做插值）。"""
    calib, next_calib = [], 0.0
    for k, t in enumerate(times):
        if t >= next_calib - 1e-9:
            calib.append((t, slopes[k], intercepts[k]))
            next_calib += interval
    errors = []
    for k, t in enumerate(times):
        s, it = interpolate(calib, t)
        c = estimate_concentration(measurements[k], s, it)
        errors.append((c - C_TRUE) / C_TRUE * 100.0)
    return errors, len(calib)


def run_adaptive(times, slopes, intercepts, measurements):
    """策略 C：自适应间隔校准 + 线性漂移补偿（先自适应定校准点，再插值）。"""
    calib, next_calib, interval = [], 0.0, 6.0
    for k, t in enumerate(times):
        if t >= next_calib - 1e-9:
            s_now, i_now = slopes[k], intercepts[k]
            if calib:
                t_last, s_last, _ = calib[-1]
                dt = t - t_last
                drift_rate = abs(s_now - s_last) / dt if dt > 0 else 0.0
                interval = 3.0 if drift_rate > 0.006 else 9.0  # 漂移快 -> 加密；慢 -> 放宽
            calib.append((t, s_now, i_now))
            next_calib += interval
    errors = []
    for k, t in enumerate(times):
        s, it = interpolate(calib, t)
        c = estimate_concentration(measurements[k], s, it)
        errors.append((c - C_TRUE) / C_TRUE * 100.0)
    return errors, len(calib)


def main():
    random.seed(42)
    times, slopes, intercepts = gen_true_series()
    measurements = gen_measurements(times, slopes, intercepts)

    print("=" * 62)
    print("软硬联合校准 + 自适应调度 离线验证")
    print("=" * 62)
    print(f"真实浓度 {C_TRUE} mM，总时长 {int(TOTAL_H)} h，测量点 {len(times)} 个")
    print(f"灵敏度从 {slopes[0]:.3f} 漂移到 {slopes[-1]:.3f} uA/mM（指数趋近 + 随机游走）")
    print()

    strategies = [
        ("A 固定6h校准 + 无补偿（现状）", run_fixed(times, slopes, intercepts, measurements, 6.0)),
        ("B 固定6h校准 + 线性补偿",      run_fixed_comp(times, slopes, intercepts, measurements, 6.0)),
        ("C 自适应校准 + 线性补偿",      run_adaptive(times, slopes, intercepts, measurements)),
    ]

    print(f"{'策略':<30}{'校准次数':>8}{'误差RMSE%':>11}{'误差最大%':>11}")
    print("-" * 62)
    for name, (errors, calib_count) in strategies:
        print(f"{name:<30}{calib_count:>8}{rmse(errors):>11.2f}{max(abs(e) for e in errors):>11.2f}")
    print()

    (_, (eA, nA)), (_, (eB, nB)), (_, (eC, nC)) = strategies
    print("结论：")
    print(f"  ① 算法校准：线性补偿把 RMSE 从 {rmse(eA):.2f}% 降到 {rmse(eB):.2f}%")
    print(f"  ② 智能调度：自适应用 {nC} 次校准，误差 {rmse(eC):.2f}%（对比固定 6h 的 {nA} 次）")


if __name__ == "__main__":
    main()
