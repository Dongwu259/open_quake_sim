#!/usr/bin/env python3
"""
Site amplification calibration — validates the three site amplification
models (linear Vs30, nonlinear SS14, Zhao2006 site classes) against
published reference values from NEHRP, Seyhan & Stewart (2014), and
Zhao et al. (2006).

Ports vs30Amplification, vs30AmplificationNL, and Zhao site class
lookup from physics.js to pure Python. No browser required.

Run: python tools/calibrate_site_amp.py
"""
import math, sys

# ================================================================
#  PHYSICS FORMULAS (ported from physics.js)
# ================================================================

GAL_TO_G = 980.665

def vs30_amplification(vs30, imt='pga'):
    """Linear Vs30 amplification (matches physics.js vs30Amplification)."""
    if not vs30 or vs30 <= 0:
        return 1.0
    v = max(150, min(1500, vs30))
    ref_vs = 760
    exp = 0.55 if imt == 'pgv' else 0.35
    amp = (ref_vs / v) ** exp
    min_amp = 0.60 if imt == 'pgv' else 0.70
    max_amp = 3.20 if imt == 'pgv' else 2.40
    return max(min_amp, min(max_amp, amp))


def vs30_amplification_nl(vs30, imt, rock_pga_gal):
    """Nonlinear Vs30 amplification (matches physics.js vs30AmplificationNL)."""
    amp_lin = vs30_amplification(vs30, imt)
    if not vs30 or vs30 <= 0 or not rock_pga_gal or rock_pga_gal <= 0:
        return amp_lin

    # Convert from gal to g (Seyhan & Stewart use g)
    pga_rock_g = max(0.001, rock_pga_gal / GAL_TO_G)

    # Period-dependent coefficients
    if imt == 'pgv':
        c, f3, f4, f5 = 0.05, 0.05, -0.12, -0.0045
    else:
        c, f3, f4, f5 = 0.10, 0.10, -0.16, -0.00401

    # f1: linear offset term
    f1 = c * math.log(max(vs30, 150) / 760)

    # f2: Vs30-dependent curvature
    v_ref = min(vs30, 760)
    f2 = f4 * (math.exp(f5 * (v_ref - 360)) - math.exp(f5 * (760 - 360)))

    # Nonlinear correction
    f_nl = f1 + f2 * math.log((pga_rock_g + f3) / f3)

    # Combined amplification
    amp = amp_lin * math.exp(f_nl)

    # Clamp
    min_amp = 0.40 if imt == 'pgv' else 0.50
    max_amp = 3.20 if imt == 'pgv' else 2.40
    return max(min_amp, min(max_amp, amp))


# Zhao2006 site class boundaries and coefficients (from physics.js)
ZHAO_CLASS_BOUNDS = [
    (float('inf'), 1100, 0, 'SC_I — 硬岩'),
    (1100, 760, 1, 'SC_II — 岩石'),
    (760, 360, 2, 'SC_III — 硬土'),
    (360, 180, 3, 'SC_IV — 中软土'),
    (180, 0, 4, 'SC_V — 软土'),
]

ZHAO_SITE_PGA = {
    'crustal':    {'I':0.000, 'II':0.110, 'III':0.195, 'IV':0.339, 'V':0.638},
    'interplate': {'I':0.000, 'II':0.102, 'III':0.183, 'IV':0.325, 'V':0.616},
    'intraslab':  {'I':0.000, 'II':0.068, 'III':0.118, 'IV':0.259, 'V':0.538},
}
ZHAO_SITE_PGV = {
    'crustal':    {'I':0.000, 'II':0.094, 'III':0.169, 'IV':0.287, 'V':0.551},
    'interplate': {'I':0.000, 'II':0.083, 'III':0.150, 'IV':0.264, 'V':0.515},
    'intraslab':  {'I':0.000, 'II':0.046, 'III':0.080, 'IV':0.183, 'V':0.460},
}
ZHAO_SITE_KEYS = ['I', 'II', 'III', 'IV', 'V']

# 15 province boxes (from physics.js SOIL_PROVINCES)
SOIL_PROVINCES = [
    (35.0,36.6,139.0,140.8,1.65, "Kanto 平原"),
    (34.8,35.5,136.5,137.2,1.55, "Nobi 平原"),
    (34.3,35.0,135.0,135.8,1.55, "Osaka 盆地"),
    (38.0,38.5,140.7,141.3,1.45, "Sendai 平原"),
    (42.7,43.3,141.1,141.8,1.45, "Ishikari 平原"),
    (37.6,38.1,138.8,139.5,1.40, "Niigata 平原"),
    (36.5,36.9,137.1,137.5,1.35, "Toyama 平原"),
    (33.4,33.8,130.2,130.6,1.40, "Fukuoka 平原"),
    (33.4,33.7,133.4,133.7,1.35, "Kochi 平原"),
    (43.0,44.5,141.3,145.5,1.25, "Kitami 盆地"),
    (35.2,35.6,136.8,137.0,1.30, "Gifu 盆地"),
    (34.5,34.8,135.3,135.6,1.30, "Kyoto 盆地"),
    (35.5,36.0,138.9,139.4,1.25, "Kofu 盆地"),
    (31.2,31.8,130.3,131.2,1.20, "Kagoshima 地区"),
    (26.0,27.0,127.6,128.3,1.30, "Okinawa 地区"),
]


# ================================================================
#  REFERENCE DATA
# ================================================================

# NEHRP site coefficients (FEMA 450 / ASCE 7-16 Table 1613.2.3-1)
# Fa = short-period (0.2s) site coefficient, PGA proxy
# Site classes: A (hard rock), B (rock), C (dense soil), D (stiff soil), E (soft soil)
# Reference: NEHRP at Vs30=760 for B/C boundary
NEHRP_SITE_CLASSES = [
    # (vs30, site_class_name, expected_fa_range_lo, expected_fa_range_hi)
    (1500, "A — 硬岩", 0.8, 0.85),
    (760,  "B/C — 边界", 1.0, 1.0),
    (530,  "C — 密实土", 1.1, 1.3),
    (260,  "D — 硬黏土", 1.3, 1.6),
    (150,  "E — 软土", 1.5, 2.1),
]

# Seyhan & Stewart (2014) nonlinear reduction benchmarks
# Expected amp_nl / amp_lin ratios at specific (Vs30, PGA_rock) combinations
# These are approximate values read from SS14 Figure 8-10 for PGA
SS14_BENCHMARKS = [
    # (vs30, rock_pga_gal, expected_nl_lin_ratio_lo, expected_nl_lin_ratio_hi, description)
    (200,  10,  0.85, 0.95, "Vs30=200, 弱震动 (10 gal)"),
    (200,  100, 0.70, 0.85, "Vs30=200, 中等震动 (100 gal)"),
    (200,  300, 0.55, 0.72, "Vs30=200, 强震动 (300 gal ≈ 0.3g)"),
    (200,  500, 0.48, 0.65, "Vs30=200, 极强震动 (500 gal ≈ 0.5g)"),
    (400,  10,  0.90, 0.98, "Vs30=400, 弱震动"),
    (400,  300, 0.65, 0.82, "Vs30=400, 强震动"),
    (400,  500, 0.58, 0.75, "Vs30=400, 极强震动"),
    (760,  100, 0.92, 1.00, "Vs30=760, B/C 边界 — 微弱非线性"),
    (760,  500, 0.85, 0.98, "Vs30=760, 极强震动 — 微弱非线性"),
    (1100, 500, 0.92, 1.00, "Vs30=1100, 硬岩 — 无非线性"),
]


# ================================================================
#  VERIFICATION
# ================================================================

def check(condition, label):
    return (True, label, "PASS") if condition else (False, label, "FAIL")

def run_all_checks():
    tests = []
    all_pass = True

    # === 1. Linear Vs30 vs NEHRP site coefficients ===
    for vs30, name, lo, hi in NEHRP_SITE_CLASSES:
        amp = vs30_amplification(vs30, 'pga')
        passed, label, status = check(lo <= amp <= hi,
            f"NEHRP Fa — {name} (Vs30={vs30})")
        tests.append((label, status, f"放大系数={amp:.3f}（预期 {lo:.2f}–{hi:.2f}）"))
        if not passed: all_pass = False

    # === 2. Nonlinear reduction ratios vs SS14 ===
    for vs30, rock_pga, lo, hi, desc in SS14_BENCHMARKS:
        amp_lin = vs30_amplification(vs30, 'pga')
        amp_nl = vs30_amplification_nl(vs30, 'pga', rock_pga)
        ratio = amp_nl / amp_lin if amp_lin > 0 else 1.0
        passed, label, status = check(lo <= ratio <= hi,
            f"SS14 非线性比率 — {desc}")
        tests.append((label, status,
            f"线性={amp_lin:.2f} 非线性={amp_nl:.2f} 比率={ratio:.3f}（预期 {lo:.2f}–{hi:.2f}）"))
        if not passed: all_pass = False

    # === 3. Nonlinear: stronger reduction at higher PGA ===
    for vs30 in [200, 400]:
        ratio_lo = vs30_amplification_nl(vs30, 'pga', 10) / vs30_amplification(vs30, 'pga')
        ratio_hi = vs30_amplification_nl(vs30, 'pga', 500) / vs30_amplification(vs30, 'pga')
        passed, label, status = check(ratio_hi < ratio_lo,
            f"非线性随 PGA 增加而增强 — Vs30={vs30}")
        tests.append((label, status,
            f"10 gal 时比率={ratio_lo:.3f} > 500 gal 时比率={ratio_hi:.3f}"))
        if not passed: all_pass = False

    # === 4. Hard rock shows minimal nonlinearity ===
    amp_lin_1100 = vs30_amplification(1100, 'pga')
    amp_nl_1100_500 = vs30_amplification_nl(1100, 'pga', 500)
    ratio_1100 = amp_nl_1100_500 / amp_lin_1100 if amp_lin_1100 > 0 else 1.0
    passed, label, status = check(ratio_1100 > 0.95,
        "硬岩非线性可忽略 — Vs30=1100, PGA=500 gal")
    tests.append((label, status, f"比率={ratio_1100:.4f}（应 >0.95）"))
    if not passed: all_pass = False

    # === 5. Zhao2006 site class boundaries ===
    boundary_tests = [
        (2000, 0, 'I'), (900, 1, 'II'), (500, 2, 'III'),
        (250, 3, 'IV'), (150, 4, 'V'), (0, 2, 'III (null fallback)'),
    ]
    for vs30, expected_sc, label_suffix in boundary_tests:
        def zhao_sc(v):
            if not v or v <= 0: return 2
            if v > 1100: return 0
            if v > 760: return 1
            if v > 360: return 2
            if v > 180: return 3
            return 4
        sc = zhao_sc(vs30)
        passed, label, status = check(sc == expected_sc,
            f"Zhao2006 场地类别 — Vs30={vs30} → SC_{label_suffix}")
        tests.append((label, status, f"获取类别={sc}，预期={expected_sc}"))
        if not passed: all_pass = False

    # === 6. Zhao2006 site class coefficient ordering ===
    for src_type in ['crustal', 'interplate', 'intraslab']:
        pga_c = ZHAO_SITE_PGA[src_type]
        pgv_c = ZHAO_SITE_PGV[src_type]
        # SC_I = 0, SC_V should be largest
        pga_ok = pga_c['I'] == 0 and pga_c['V'] > pga_c['IV'] > pga_c['III'] > pga_c['II']
        pgv_ok = pgv_c['I'] == 0 and pgv_c['V'] > pgv_c['IV'] > pgv_c['III'] > pgv_c['II']

        passed, label, status = check(pga_ok, f"Zhao2006 PGA 场地类别排序 — {src_type}")
        tests.append((label, status, ""))
        if not passed: all_pass = False

        passed, label, status = check(pgv_ok, f"Zhao2006 PGV 场地类别排序 — {src_type}")
        tests.append((label, status, ""))
        if not passed: all_pass = False

    # Add the PGA/PGV coefficient detail
    for src_type in ['crustal', 'interplate', 'intraslab']:
        pga_vals = [f"{k}={ZHAO_SITE_PGA[src_type][k]:.3f}" for k in ZHAO_SITE_KEYS]
        pgv_vals = [f"{k}={ZHAO_SITE_PGV[src_type][k]:.3f}" for k in ZHAO_SITE_KEYS]
        tests.append((f"Zhao2006 系数 — {src_type} PGA", "  ", ", ".join(pga_vals)))
        tests.append((f"Zhao2006 系数 — {src_type} PGV", "  ", ", ".join(pgv_vals)))

    # === 7. PGV amplification is stronger than PGA (expected: exp 0.55 > 0.35) ===
    for vs30 in [200, 400, 760, 1100]:
        amp_pga = vs30_amplification(vs30, 'pga')
        amp_pgv = vs30_amplification(vs30, 'pgv')
        if vs30 < 760:
            passed, label, status = check(amp_pgv > amp_pga,
                f"PGV 放大系数 > PGA — Vs30={vs30}（软土）")
        else:
            passed, label, status = check(amp_pgv < amp_pga,
                f"PGV 放大系数 < PGA — Vs30={vs30}（硬岩）")
        tests.append((label, status, f"PGA={amp_pga:.3f} PGV={amp_pgv:.3f}"))
        if not passed: all_pass = False

    # === 8. Province model amplification values in reasonable range ===
    for lat_min, lat_max, lng_min, lng_max, val, name in SOIL_PROVINCES:
        # Province value is the amplification factor for that basin
        passed, label, status = check(1.0 < val < 2.0,
            f"省份模型 — {name}")
        tests.append((label, status, f"放大系数={val:.2f}（应 >1.0 且 <2.0，表示软沉积盆地）"))
        if not passed: all_pass = False

    # === 9. Reference Vs30=760 is neutral (amp = 1.0) ===
    amp_760_pga = vs30_amplification(760, 'pga')
    amp_760_pgv = vs30_amplification(760, 'pgv')
    passed, label, status = check(abs(amp_760_pga - 1.0) < 1e-10 and abs(amp_760_pgv - 1.0) < 1e-10,
        "参考 Vs30=760 应处于中性状态")
    tests.append((label, status, f"PGA 放大={amp_760_pga:.10f} PGV 放大={amp_760_pgv:.10f}"))
    if not passed: all_pass = False

    # === 10. Null/zero/negative Vs30 returns 1.0 ===
    for bad_vs30 in [0, None, -100]:
        amp = vs30_amplification(bad_vs30 if bad_vs30 is not None else 0, 'pga')
        passed, label, status = check(amp == 1.0,
            f"无效 Vs30 返回 1.0 — Vs30={bad_vs30}")
        tests.append((label, status, f"放大={amp}"))
        if not passed: all_pass = False

    return all_pass, tests


# ================================================================
#  SENSITIVITY ANALYSIS
# ================================================================

def print_sensitivity():
    """Show how nonlinear amplification varies with Vs30 and rock PGA."""
    print(f"\n非线性放大敏感性矩阵（PGA，amp_nl 值）：")
    vs30s = [150, 200, 300, 400, 530, 760, 1100, 1500]
    pga_levels = [10, 50, 100, 200, 300, 500, 1000]
    print(f"  {'Vs30':>8s}", end="")
    for pga in pga_levels:
        print(f"  {f'{pga}gal':>8s}", end="")
    print()
    for vs30 in vs30s:
        print(f"  {vs30:8d}", end="")
        for pga in pga_levels:
            amp = vs30_amplification_nl(vs30, 'pga', pga)
            print(f"  {amp:8.2f}", end="")
        print()

    print(f"\n线性放大参考值：")
    for vs30 in vs30s:
        amp = vs30_amplification(vs30, 'pga')
        print(f"  Vs30={vs30:4d} → 线性放大={amp:.2f}")


# ================================================================
#  MAIN
# ================================================================

def main():
    print("场地放大校准 — NEHRP / SS14 / Zhao2006 验证")
    print("=" * 60)

    all_pass, tests = run_all_checks()

    # Print results by category
    current_cat = ""
    for label, status, detail in tests:
        cat = label.split(" — ")[0] if " — " in label else label
        if cat != current_cat:
            current_cat = cat
            print(f"\n{cat}:")
        print(f"  {status} {detail}")

    print(f"\n{'='*60}")
    if all_pass:
        print(f"All checks passed")
    else:
        n_fail = sum(1 for _, s, _ in tests if s == "FAIL")
        print(f"{n_fail} check(s) FAILED")
        print(f"\nItems that need adjustment:")
        for label, status, detail in tests:
            if status == "FAIL":
                print(f"  - {label}: {detail}")

    print_sensitivity()

    return 0 if all_pass else 1


if __name__ == '__main__':
    sys.exit(main())
