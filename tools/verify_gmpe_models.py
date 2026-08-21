#!/usr/bin/env python3
"""
GMPE model verification — cross-model consistency, physical constraints,
and comparison with published benchmark values.

Ports all 4 GMPE models (log, Si-Midorikawa 1999, Kanno 2006, Zhao 2006)
from physics.js to pure Python. No browser required.

Run: python tools/verify_gmpe_models.py
"""
import math, sys

# ================================================================
#  PHYSICS FORMULAS (ported from physics.js)
# ================================================================

EARTH_R = 6371.0
GAL_TO_G = 980.665

def haversine_km(lat1, lng1, lat2, lng2):
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat/2)**2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlng/2)**2)
    return 2 * EARTH_R * math.atan2(math.sqrt(a), math.sqrt(1-a))

def hypo_dist(slat, slng, elat, elng, depth):
    surf = haversine_km(elat, elng, slat, slng)
    return math.sqrt(surf**2 + depth**2)

# ---- GMPE: log model (hand-tuned) ----
def pga_log(mag, r_km, att_a=0.42, att_b=1.34, att_c=0.31, anelastic=0.001):
    eff_m = mag if mag <= 9 else 9 + (mag - 9) * 0.3
    h = min(5, 10**(0.35 * eff_m - 1.0))
    r_eff = math.sqrt(r_km**2 + h**2)
    return 10**(att_a * eff_m - att_b * math.log10(r_eff) - anelastic * r_eff + att_c)

def pgv_log(mag, r_km, anelastic=0.001, pgv_a=0.48, pgv_b=1.46, pgv_c=-1.20):
    eff_m = mag if mag <= 9 else 9 + (mag - 9) * 0.3
    h = min(5, 10**(0.35 * eff_m - 1.0))
    r_eff = math.sqrt(r_km**2 + h**2)
    return 10**(pgv_a * eff_m - pgv_b * math.log10(r_eff) - anelastic * r_eff + pgv_c)

# ---- Source-type dummy variables ----
def simid_ds(src_type):
    if src_type == 'interplate': return 0.124
    if src_type == 'intraslab': return 0.221
    return 0.0

# ---- GMPE: Si & Midorikawa (1999) ----
def pga_si_mid(mag, r_km, depth_km, src_type):
    d = simid_ds(src_type)
    return 10**(0.50 * mag + 0.0036 * depth_km + 0.61 + d
                - math.log10(r_km + 0.0055 * 10**(0.50 * mag))
                - 0.003 * r_km)

def pgv_si_mid(mag, r_km, depth_km, src_type):
    d = simid_ds(src_type)
    return 10**(0.58 * mag + 0.0038 * depth_km - 1.29 + d
                - math.log10(r_km + 0.0028 * 10**(0.50 * mag))
                - 0.002 * r_km)

# ---- GMPE: Kanno et al. (2006) ----
def kanno_site_corr(vs30, imt):
    if not vs30 or vs30 <= 0: return 0
    p = -0.5514 if imt == 'pga' else -0.7057
    return p * math.log10(vs30 / 800.0)

def pga_kanno_shallow(mw, r_km, vs30):
    a, b, c_coef, d = 0.556, -0.00307, 0.256, 0.00547
    r_eff = r_km + d * 10**(0.50 * mw)
    return 10**(a * mw + b * r_km - math.log10(r_eff) + c_coef + kanno_site_corr(vs30, 'pga'))

def pga_kanno_deep(mw, r_km, vs30):
    a, b, c_coef = 0.556, -0.00307, 0.256
    return 10**(a * mw + b * r_km - math.log10(r_km) + c_coef + kanno_site_corr(vs30, 'pga'))

def pga_kanno(mw, r_km, depth_km, vs30):
    if depth_km <= 30:
        return pga_kanno_shallow(mw, r_km, vs30)
    return pga_kanno_deep(mw, r_km, vs30)

def pgv_kanno(mw, r_km, depth_km, vs30):
    if depth_km <= 30:
        a, b, c_coef, d = 0.702, -0.000925, -1.930, 0.00217
        r_eff = r_km + d * 10**(0.50 * mw)
    else:
        a, b, c_coef, d = 0.702, -0.000925, -1.930, 0
        r_eff = r_km
    return 10**(a * mw + b * r_km - math.log10(r_eff) + c_coef + kanno_site_corr(vs30, 'pgv'))

# ---- GMPE: Zhao et al. (2006) ----
ZHAO_SITE_CLASSES = ['I', 'II', 'III', 'IV', 'V']

def zhao_site_class(vs30):
    if not vs30 or vs30 <= 0: return 2
    if vs30 > 1100: return 0
    if vs30 > 760: return 1
    if vs30 > 360: return 2
    if vs30 > 180: return 3
    return 4

ZHAO_COEFFS = {
    'crustal':    {'a':0.522, 'b':0.00128, 'c':-0.00244, 'd':0.00346, 'h':10.3, 'ePGA':0.23, 'ePGV':0.17},
    'interplate': {'a':0.598, 'b':0.00224, 'c':-0.00201, 'd':0.00300, 'h':20.6, 'ePGA':0.17, 'ePGV':0.14},
    'intraslab':  {'a':0.680, 'b':-0.00030,'c':-0.00187, 'd':0.00365, 'h':35.0, 'ePGA':0.10, 'ePGV':0.08},
}

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

def pga_zhao2006(mw, r_km, depth_km, src_type, vs30):
    coeff = ZHAO_COEFFS.get(src_type, ZHAO_COEFFS['crustal'])
    X = depth_km - 15
    r = math.sqrt(r_km**2 + coeff['h']**2)
    log_pga = (coeff['a'] * mw + coeff['b'] * X - math.log10(r)
               + coeff['c'] * r + coeff['d'] * depth_km + coeff['ePGA'])
    sc = zhao_site_class(vs30)
    site = ZHAO_SITE_PGA.get(src_type, ZHAO_SITE_PGA['crustal'])
    log_pga += site.get(ZHAO_SITE_CLASSES[sc], 0)
    return 10**log_pga

def pgv_zhao2006(mw, r_km, depth_km, src_type, vs30):
    coeff = ZHAO_COEFFS.get(src_type, ZHAO_COEFFS['crustal'])
    X = depth_km - 15
    r = math.sqrt(r_km**2 + coeff['h']**2)
    log_pgv = (coeff['a'] * mw + coeff['b'] * X - math.log10(r)
               + coeff['c'] * r + coeff['d'] * depth_km + coeff['ePGV'] - 1.0)
    sc = zhao_site_class(vs30)
    site = ZHAO_SITE_PGV.get(src_type, ZHAO_SITE_PGV['crustal'])
    log_pgv += site.get(ZHAO_SITE_CLASSES[sc], 0)
    return 10**log_pgv

# ---- GMPE routing (matches resolveGmpModel) ----
def resolve_model(gmp_model, src_type, mw):
    if gmp_model != 'auto':
        return gmp_model
    if src_type == 'crustal' and mw >= 7.5:
        return 'si-midorikawa'
    return 'log-ff'

def calc_pga(mag, r_km, gmp_model, depth_km, src_type, vs30=760,
             att_a=0.42, att_b=1.34, att_c=0.31, anelastic=0.001):
    if r_km <= 0.5: r_km = 0.5
    model = resolve_model(gmp_model, src_type, mag)
    if model == 'kanno2006':
        return pga_kanno(mag, r_km, depth_km, vs30)
    if model == 'zhao2006':
        return pga_zhao2006(mag, r_km, depth_km, src_type, vs30)
    if model == 'si-midorikawa':
        return pga_si_mid(mag, r_km, depth_km, src_type)
    if model == 'log-ff':
        return pga_log(mag, r_km, att_a, att_b, att_c, anelastic) * 10**simid_ds(src_type)
    return pga_log(mag, r_km, att_a, att_b, att_c, anelastic)


# ================================================================
#  VERIFICATION
# ================================================================

def check(condition, label):
    """Return (passed, label, message)."""
    if condition:
        return (True, label, "PASS")
    else:
        return (False, label, "FAIL")

def run_all_checks():
    tests = []
    all_pass = True

    # === 1. Magnitude scaling: M8 > M7 for all models ===
    for model in ['log', 'si-midorikawa', 'kanno2006', 'zhao2006']:
        pga_m7 = calc_pga(7.0, 50, model, 30, 'crustal')
        pga_m8 = calc_pga(8.0, 50, model, 30, 'crustal')
        passed, label, status = check(pga_m8 > pga_m7,
            f"震级缩放 M8 > M7 — {model}")
        tests.append((label, status, f"M7={pga_m7:.0f} M8={pga_m8:.0f}"))
        if not passed: all_pass = False

    # === 2. Distance decay: 200km < 50km for all models ===
    for model in ['log', 'si-midorikawa', 'kanno2006', 'zhao2006']:
        pga_50 = calc_pga(7.0, 50, model, 30, 'crustal')
        pga_200 = calc_pga(7.0, 200, model, 30, 'crustal')
        passed, label, status = check(pga_200 < pga_50,
            f"距离衰减 200km < 50km — {model}")
        tests.append((label, status, f"50km={pga_50:.0f} 200km={pga_200:.0f}"))
        if not passed: all_pass = False

    # === 3. Site amplification ordering: soft > hard for all models ===
    for model in ['log', 'kanno2006', 'zhao2006']:
        pga_soft = calc_pga(7.0, 50, model, 30, 'crustal', vs30=200)
        pga_hard = calc_pga(7.0, 50, model, 30, 'crustal', vs30=1100)
        passed, label, status = check(pga_soft > pga_hard,
            f"软土 > 硬岩 — {model}")
        tests.append((label, status, f"软土(Vs30=200)={pga_soft:.0f} 硬岩(Vs30=1100)={pga_hard:.0f}"))
        if not passed: all_pass = False

    # === 4. Zhao2006 source-type ordering: intraslab > interplate > crustal ===
    pga_c = pga_zhao2006(7.0, 50, 30, 'crustal', 760)
    pga_i = pga_zhao2006(7.0, 50, 30, 'interplate', 760)
    pga_s = pga_zhao2006(7.0, 50, 30, 'intraslab', 760)
    passed, label, status = check(pga_s > pga_i > pga_c,
        "Zhao2006 震源项排序：板内 > 板间 > 地壳")
    tests.append((label, status, f"板内={pga_s:.0f} 板间={pga_i:.0f} 地壳={pga_c:.0f}"))
    if not passed: all_pass = False

    # === 5. Magnitude saturation: M9.5 ≈ M9.0 ===
    pga_m9 = pga_log(9.0, 50, 0.42, 1.34, 0.31, 0)
    pga_m95 = pga_log(9.5, 50, 0.42, 1.34, 0.31, 0)
    ratio_sat = pga_m95 / pga_m9
    passed, label, status = check(0.5 < ratio_sat < 2.0,
        "震级饱和：M9.5 ≈ M9.0（比率应在 0.5–2.0）")
    tests.append((label, status, f"比率={ratio_sat:.2f} M9.0={pga_m9:.0f}gal M9.5={pga_m95:.0f}gal"))
    if not passed: all_pass = False

    # === 6. Cross-model consistency at common (M,R) ===
    test_cases = [
        (6.0, 30, 'crustal', 760, "M6 R30 地壳"),
        (7.0, 50, 'crustal', 760, "M7 R50 地壳"),
        (7.0, 50, 'interplate', 760, "M7 R50 板间"),
        (8.0, 80, 'crustal', 400, "M8 R80 地壳 Vs30=400"),
    ]
    for mag, r_km, src, vs30, desc in test_cases:
        pgas = {}
        for model in ['log', 'si-midorikawa', 'kanno2006', 'zhao2006']:
            pgas[model] = calc_pga(mag, r_km, model, 30, src, vs30)
        max_pga = max(pgas.values())
        min_pga = min(pgas.values())
        ratio = max_pga / min_pga if min_pga > 0 else float('inf')
        passed, label, status = check(ratio < 3.0,
            f"跨模型一致性 ({desc}) — 最大/最小比率 < 3.0")
        detail = ", ".join(f"{m}={v:.0f}" for m, v in pgas.items()) + f" 比率={ratio:.1f}"
        tests.append((label, status, detail))
        if not passed: all_pass = False

    # === 7. Attenuation monotonically decreases with distance ===
    dists = [10, 20, 50, 100, 200, 400]
    for model in ['log', 'si-midorikawa', 'kanno2006', 'zhao2006']:
        pgas_dist = [calc_pga(7.0, d, model, 30, 'crustal') for d in dists]
        monotonic = all(pgas_dist[i] > pgas_dist[i+1] for i in range(len(pgas_dist)-1))
        passed, label, status = check(monotonic,
            f"距离单调递减 — {model}")
        tests.append((label, status, " → ".join(f"{d}km={v:.0f}" for d, v in zip(dists, pgas_dist))))
        if not passed: all_pass = False

    # === 8. Kanno2006 shallow vs deep routing ===
    pga_shallow = pga_kanno(7.0, 50, 20, 400)
    pga_deep = pga_kanno(7.0, 50, 60, 400)
    # Deep events typically have slightly different PGA due to d=0 in Reff formula
    # Both should be reasonable values
    passed, label, status = check(pga_shallow > 0 and pga_deep > 0 and
                                  0.5 < pga_shallow/pga_deep < 2.0,
        "Kanno2006 浅源/深源路由 — 两者均为合理值")
    tests.append((label, status, f"浅源(20km)={pga_shallow:.0f} 深源(60km)={pga_deep:.0f}"))
    if not passed: all_pass = False

    # === 9. Zhao2006 comparison with published benchmark values ===
    # Zhao et al. (2006) Table 5 gives example PGA for SC_III (hard soil, vs30~500)
    # These are approximate values read from the published curves
    benchmarks = [
        # (mw, r_km, depth, src, vs30, expected_pga_range, description)
        (6.0, 30, 20, 'crustal', 500, (80, 160), "M6 R30 地壳 SC_III"),
        (7.0, 50, 25, 'crustal', 500, (60, 140), "M7 R50 地壳 SC_III"),
        (8.0, 80, 30, 'interplate', 500, (100, 220), "M8 R80 板间 SC_III"),
    ]
    for mw, r_km, depth, src, vs30, (lo, hi), desc in benchmarks:
        pga = pga_zhao2006(mw, r_km, depth, src, vs30)
        passed, label, status = check(lo <= pga <= hi,
            f"Zhao2006 基准 — {desc}")
        tests.append((label, status, f"预测值={pga:.0f} gal（预期范围 {lo}–{hi}）"))
        if not passed: all_pass = False

    # === 10. PGA values are physically reasonable (no NaN, positive, finite) ===
    test_configs = [
        (9.1, 5, 'log', 24, 'interplate', 400),
        (6.5, 10, 'si-midorikawa', 10, 'crustal', 760),
        (7.5, 500, 'kanno2006', 30, 'crustal', 200),
        (8.0, 1, 'zhao2006', 15, 'intraslab', 760),
    ]
    for mag, r_km, model, depth, src, vs30 in test_configs:
        pga = calc_pga(mag, r_km, model, depth, src, vs30)
        passed, label, status = check(
            pga > 0 and math.isfinite(pga) and pga < 20000,
            f"物理合理性 — {model} M{mag} R{r_km}km")
        tests.append((label, status, f"PGA={pga:.0f} gal"))
        if not passed: all_pass = False

    return all_pass, tests


# ================================================================
#  MAIN
# ================================================================

def main():
    print("GMPE 模型验证 — 跨模型一致性、物理约束与基准对比")
    print("=" * 60)

    all_pass, tests = run_all_checks()

    # Print results
    categories = {}
    current_cat = ""
    for label, status, detail in tests:
        # Determine category from label prefix
        if " — " in label:
            cat = label.split(" — ")[0]
        else:
            cat = label

        if cat not in categories:
            categories[cat] = []
        categories[cat].append((label, status, detail))

    for cat, cat_tests in categories.items():
        n_pass = sum(1 for _, s, _ in cat_tests if s == "PASS")
        n_total = len(cat_tests)
        print(f"\n{cat} ({n_pass}/{n_total}):")
        for label, status, detail in cat_tests:
            print(f"  {status} {detail}")

    print(f"\n{'='*60}")
    if all_pass:
        print(f"All {len(tests)} checks passed")
    else:
        n_fail = sum(1 for _, s, _ in tests if s != "PASS")
        print(f"{n_fail}/{len(tests)} checks FAILED")
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
