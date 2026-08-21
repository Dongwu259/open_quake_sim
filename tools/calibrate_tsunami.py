#!/usr/bin/env python3
"""
Tsunami height model calibration — calibrates tsuCoefA & tsuCoefB against
real observed run-up / inundation heights from historical Japan tsunamis.

Important scope: this calibrates only the legacy empirical height branch. It
does not validate slip/rake source coupling, the bathymetric travel field, the
linear shallow-water solver, Green's-law coastal amplification, or inundation.
Those components require separate benchmark datasets and tests.

Current empirical model (physics.js):
  H0 = 10^(tsuCoefA * effM - tsuCoefB)        # source height at 10 km
  H(dist) = H0 * sqrt(10 / max(dist, 0.5))     # cylindrical spreading
  Optionally: H *= Green's Law shallow-water amplification

Default: tsuCoefA=0.50, tsuCoefB=3.30
For M9 at 100 km: H = 10^(4.50-3.30) * sqrt(0.1) = 15.85 * 0.316 = 5.0 m

Run:  python tools/calibrate_tsunami.py [--greens-law] [--step 0.002]
"""
import math, json, sys, os

# ================================================================
#  PHYSICS FORMULAS (ported from physics.js)
# ================================================================

EARTH_R = 6371.0

def haversine_km(lat1, lng1, lat2, lng2):
    """Great-circle distance in km."""
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat/2)**2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlng/2)**2)
    return 2 * EARTH_R * math.atan2(math.sqrt(a), math.sqrt(1-a))

def calc_tsunami_height(mag, dist_km, tsu_coef_a, tsu_coef_b):
    """Core tsunami height formula (matches physics.js calcTsunamiHeight)."""
    if dist_km <= 0.5:
        dist_km = 0.5
    # Magnitude saturation (same as physics.js)
    eff_m = mag if mag <= 9 else 9 + (mag - 9) * 0.3
    h0 = 10 ** (tsu_coef_a * eff_m - tsu_coef_b)
    return h0 * math.sqrt(10 / dist_km)

def tsunami_warning_level(h):
    """Warning level from predicted height."""
    if h >= 3.0: return 'major'
    if h >= 1.0: return 'warn'
    if h >= 0.2: return 'adv'
    return None

# Optional: Green's Law shallow-water amplification
def load_bathymetry(path='public/geojson/bathymetry.json'):
    """Load bathymetry grid, return (grid_2d, lat_range, lng_range, dlat, dlng)."""
    if not os.path.exists(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    # Expected format: {grid: [[depth,...],...], latMin, latMax, lngMin, lngMax}
    if isinstance(data, dict) and isinstance(data.get('data'), list):
        nx, ny = int(data.get('nx', 0)), int(data.get('ny', 0))
        flat = data['data']
        if nx > 1 and ny > 1 and len(flat) == nx * ny:
            grid = [flat[i*nx:(i+1)*nx] for i in range(ny)]
            origin = data.get('origin', [120, 20])
            res = float(data.get('res', 0.15))
            data = dict(data)
            data.update({'latMin':origin[1], 'latMax':origin[1]+res*(ny-1),
                         'lngMin':origin[0], 'lngMax':origin[0]+res*(nx-1)})
        else:
            grid = []
    else:
        grid = data.get('grid', data) if isinstance(data, dict) else data
    if isinstance(grid, dict):
        grid = grid.get('grid', [])
    if isinstance(grid, list) and len(grid) > 0 and isinstance(grid[0], list):
        depths = grid
    else:
        return None
    lat_min = data.get('latMin', data.get('lat_min', 20))
    lat_max = data.get('latMax', data.get('lat_max', 50))
    lng_min = data.get('lngMin', data.get('lng_min', 120))
    lng_max = data.get('lngMax', data.get('lng_max', 150))
    n_lat = len(depths)
    n_lng = len(depths[0]) if n_lat > 0 else 0
    if n_lat < 2 or n_lng < 2:
        return None
    dlat = (lat_max - lat_min) / (n_lat - 1)
    dlng = (lng_max - lng_min) / (n_lng - 1)
    return {'grid': depths, 'lat_min': lat_min, 'lat_max': lat_max,
            'lng_min': lng_min, 'lng_max': lng_max,
            'n_lat': n_lat, 'n_lng': n_lng, 'dlat': dlat, 'dlng': dlng}

def sample_depth(bathy, lat, lng):
    """Bilinear interpolation of water depth at (lat, lng). Returns meters, or None."""
    if bathy is None:
        return None
    lat_i = (lat - bathy['lat_min']) / bathy['dlat']
    lng_i = (lng - bathy['lng_min']) / bathy['dlng']
    i0 = int(lat_i)
    j0 = int(lng_i)
    if i0 < 0 or i0 >= bathy['n_lat']-1 or j0 < 0 or j0 >= bathy['n_lng']-1:
        return None
    fi = lat_i - i0
    fj = lng_i - j0
    g = bathy['grid']
    # Bilinear interpolation
    d = (g[i0][j0] * (1-fi) * (1-fj) +
         g[i0+1][j0] * fi * (1-fj) +
         g[i0][j0+1] * (1-fi) * fj +
         g[i0+1][j0+1] * fi * fj)
    # Positive values = land above sea level; negative = water depth
    if d > 0:
        return None  # on land — no water depth
    return abs(d)  # return positive depth in meters

def greens_law_amplification(h_source_depth, h_coast_depth):
    """Green's Law: H_coast/H_deep = (h_deep/h_coast)^0.25, capped at 5x."""
    if (h_source_depth is None or h_coast_depth is None or
        h_coast_depth <= 0 or h_source_depth <= 0):
        return 1.0
    return min(5.0, (h_source_depth / max(h_coast_depth, 10)) ** 0.25)


# ================================================================
#  OBSERVATION DATA — historical Japan tsunami run-up heights
#  Sources: JMA tsunami database, NOAA NGDC/WDS Global Historical
#  Tsunami Database, Mori et al. (2012) for Tohoku, JMA reports.
# ================================================================

# Each event: (name, mag, epi_lat, epi_lng, source_depth_m,
#              [(location, lat, lng, coastal_depth_m, observed_height_m), ...])
# source_depth_m = approximate water depth at epicenter (meters)
# coastal_depth_m = approximate water depth near observation point

TSUNAMI_EVENTS = [
    # 2011 Tohoku M9.1 — best-documented tsunami in history
    # Observed max run-up heights from Mori et al. (2012) and JMA
    ("tohoku2011", 9.1, 38.10, 142.86, 3000, [
        ("Ofunato",        39.07, 141.72, 20, 23.6),
        ("Onagawa",        38.45, 141.44, 25, 18.4),
        ("Rikuzentakata",  39.01, 141.63, 15, 17.6),
        ("Kesennuma",      38.90, 141.58, 15, 16.7),
        ("Otsuchi",        39.36, 141.90, 20, 15.6),
        ("Sendai",         38.27, 140.87, 10, 10.4),
        ("Soma",           37.80, 140.92, 10, 9.3),
        ("Miyako",         39.64, 141.95, 25, 8.5),
        ("Kamaishi",       39.27, 141.88, 25, 8.1),
        ("Ishinomaki",     38.42, 141.30, 10, 7.6),
        ("Hachinohe",      40.50, 141.49, 15, 6.2),
        ("Kuji",           40.19, 141.77, 20, 5.4),
        ("Mutsu",          41.29, 141.21, 20, 3.5),
        ("Kushiro",        42.98, 144.37, 10, 2.8),
        ("Hakodate",       41.77, 140.73, 15, 2.4),
        ("Nemuro",         43.33, 145.58, 15, 2.0),
    ]),

    # 1993 Hokkaido Nansei-oki M7.7 — extreme local run-up at Okushiri
    # Source: JMA + Hokkaido University survey
    ("hokkaido1993", 7.7, 42.78, 139.18, 2500, [
        ("Okushiri_Aonae",   42.07, 139.43, 5, 31.7),  # extreme local
        ("Okushiri_Hamanaka",42.07, 139.45, 5, 10.2),
        ("Esashi",           41.87, 140.13, 8, 4.5),
        ("Setana",           42.45, 139.85, 10, 3.2),
        ("Suttsu",           42.79, 140.23, 10, 2.5),
    ]),

    # 2003 Tokachi-oki M8.3 — moderate tsunami
    ("tokachi2003", 8.3, 41.78, 144.08, 3500, [
        ("Tomakomai", 42.63, 141.60, 8, 2.5),
        ("Urakawa",   42.17, 142.77, 10, 2.1),
        ("Kushiro",   42.98, 144.37, 10, 1.8),
        ("Hachinohe", 40.50, 141.49, 15, 1.5),
    ]),

    # 1983 Nihonkai-Chubu M7.7 — Japan Sea tsunami, killed 100 people
    ("nihonkai1983", 7.7, 40.93, 139.10, 2500, [
        ("Noshiro",  40.21, 140.03, 10, 6.0),
        ("Akita",    39.72, 140.10, 10, 3.5),
        ("Oga",      39.88, 139.85, 10, 5.2),
        ("Fukaura",  40.65, 139.93, 10, 4.8),
    ]),

    # 1960 Chile M9.5 — trans-Pacific tsunami (far-field test)
    # Tests whether the model can handle very distant events
    ("chile1960", 9.5, -38.14, -73.41, 4000, [
        ("Ofunato",      39.07, 141.72, 20, 3.1),
        ("Kushiro",      42.98, 144.37, 10, 2.4),
        ("Hachinohe",    40.50, 141.49, 15, 2.8),
        ("Onagawa",      38.45, 141.44, 25, 1.8),
        ("Miyako",       39.64, 141.95, 25, 2.0),
        ("Kesennuma",    38.90, 141.58, 15, 2.3),
    ]),

    # 1946 Nankai M8.4 — large thrust event, well-documented
    ("nankai1946", 8.4, 33.00, 135.60, 3000, [
        ("Kushimoto", 33.47, 135.78, 10, 5.3),
        ("Muroto",    33.28, 134.17, 12, 5.2),
        ("Kochi",     33.56, 133.53, 8, 4.6),
        ("Owase",     34.07, 136.19, 10, 4.1),
    ]),

    # 1944 Tonankai M8.1
    ("tonankai1944", 8.1, 33.70, 136.20, 3000, [
        ("Owase",    34.07, 136.19, 10, 6.5),
        ("Shingu",   33.73, 135.98, 12, 4.5),
        ("Toba",     34.48, 136.84, 10, 3.8),
        ("Kumano",   33.90, 136.10, 10, 5.0),
    ]),

    # 1896 Meiji-Sanriku M8.5 — "tsunami earthquake" (slow rupture, huge tsunami)
    # Known for extreme run-up relative to magnitude
    ("meiji1896", 8.5, 39.50, 144.00, 4000, [
        ("Ofunato",    39.07, 141.72, 20, 5.5),
        ("Kamaishi",   39.27, 141.88, 25, 6.1),
        ("Miyako",     39.64, 141.95, 25, 4.2),
        ("Kesennuma",  38.90, 141.58, 15, 4.5),
    ]),
]


# ================================================================
#  CALIBRATION
# ================================================================

def compute_all_predictions(tsu_a, tsu_b, use_greens_law=False, bathy=None):
    """Return list of (event_name, location, obs_h, pred_h, dist_km) tuples."""
    results = []
    for ev_name, mag, elat, elng, src_depth, obs_list in TSUNAMI_EVENTS:
        for loc_name, llat, llng, coast_depth, obs_h in obs_list:
            dist = haversine_km(elat, elng, llat, llng)
            pred_h = calc_tsunami_height(mag, dist, tsu_a, tsu_b)

            if use_greens_law:
                # Get actual source depth from bathymetry if available
                src_d = sample_depth(bathy, elat, elng) if bathy else None
                if src_d is None:
                    src_d = src_depth  # fallback to hardcoded estimate
                amp = greens_law_amplification(src_d, coast_depth)
                pred_h *= amp

            results.append((ev_name, loc_name, obs_h, pred_h, dist))
    return results


def evaluate(tsu_a, tsu_b, use_greens_law=False, bathy=None):
    """Compute log-height bias/RMS; observations span orders of magnitude."""
    all_results = compute_all_predictions(tsu_a, tsu_b, use_greens_law, bathy)

    # Global stats
    residuals = [math.log(max(r[3], 0.01)) - math.log(max(r[2], 0.01)) for r in all_results]
    n = len(residuals)
    if n == 0:
        return float('inf'), float('inf'), {}, []
    bias = sum(residuals) / n
    rms = math.sqrt(sum(r*r for r in residuals) / n)

    # Per-event stats
    per_event = {}
    for r in all_results:
        ev = r[0]
        if ev not in per_event:
            per_event[ev] = []
        per_event[ev].append(r)

    return bias, rms, per_event, all_results


def grid_search(use_greens_law=False, step=0.005):
    """Grid search over tsuCoefA × tsuCoefB for minimum RMS."""
    bathy = load_bathymetry() if use_greens_law else None
    if use_greens_law:
        if bathy:
            print(f"加载测深数据：{bathy['n_lat']}×{bathy['n_lng']} 网格")
        else:
            print("警告：测深数据不可用 — 使用硬编码深度估算值")

    best_rms = float('inf')
    best_a, best_b = 0.50, 3.30
    best_bias = 0

    a_min, a_max = 0.10, 1.00
    b_min, b_max = 1.00, 5.00
    n_a = int((a_max - a_min) / step) + 1
    n_b = int((b_max - b_min) / step) + 1
    total = n_a * n_b

    count = 0
    a = a_min
    while a <= a_max + 1e-9:
        b = b_min
        while b <= b_max + 1e-9:
            bias, rms, _, _ = evaluate(round(a, 4), round(b, 4), use_greens_law, bathy)
            if rms < best_rms:
                best_rms = rms
                best_a = round(a, 4)
                best_b = round(b, 4)
                best_bias = bias
            count += 1
            if count % 20000 == 0:
                print(f"  已扫描 {count}/{total} ({100*count/total:.0f}%)...")
            b += step
        a += step

    return best_a, best_b, best_bias, best_rms, count


# ================================================================
#  MAIN
# ================================================================

def main():
    use_gl = '--greens-law' in sys.argv
    step = 0.005
    for i, arg in enumerate(sys.argv):
        if arg == '--step' and i+1 < len(sys.argv):
            step = float(sys.argv[i+1])

    print("海啸校准 — 网格搜索 tsuCoefA/B")
    print("=" * 60)
    print(f"网格步长: {step}   Green's Law: {'开启' if use_gl else '关闭'}")
    print(f"事件数: {len(TSUNAMI_EVENTS)}")

    # Baseline: current defaults
    bl_bias, bl_rms, bl_per, _ = evaluate(0.50, 3.30, use_gl)
    bl_n = sum(len(v) for v in bl_per.values())
    print(f"\n当前默认值: A=0.50 B=3.30  全局偏差={bl_bias:+.2f}m  RMS={bl_rms:.2f}m  (n={bl_n})")

    # Grid search
    print(f"\n正在运行网格搜索...")
    best_a, best_b, best_bias, best_rms, scanned = grid_search(use_gl, step)
    print(f"已扫描 {scanned} 个组合")

    # Optimal results
    opt_bias, opt_rms, opt_per, opt_all = evaluate(best_a, best_b, use_gl)
    opt_n = sum(len(v) for v in opt_per.values())
    improvement = (bl_rms - opt_rms) / bl_rms * 100 if bl_rms > 0 else 0

    print(f"\n最优值:  A={best_a:.4f}  B={best_b:.4f}  全局偏差={opt_bias:+.2f}m  RMS={opt_rms:.2f}m  (n={opt_n})")
    print(f"改进: {improvement:+.1f}%")

    # Per-event breakdown
    print(f"\n按事件统计:")
    print(f"  {'事件':<20s} {'n':>3s}  {'偏差/m':>8s}  {'RMS/m':>8s}  {'中位数/m':>8s}")
    print(f"  {'-'*20} {'-'*3}  {'-'*8}  {'-'*8}  {'-'*8}")
    for ev_name, ev_mag, _, _, _, obs_list in TSUNAMI_EVENTS:
        ev_results = opt_per.get(ev_name, [])
        if not ev_results:
            continue
        diffs = [r[3] - r[2] for r in ev_results]  # pred - obs
        n_ev = len(diffs)
        bias_ev = sum(diffs) / n_ev
        rms_ev = math.sqrt(sum(d*d for d in diffs) / n_ev)
        sorted_diffs = sorted(diffs)
        med = sorted_diffs[n_ev//2] if n_ev % 2 == 1 else (sorted_diffs[n_ev//2-1] + sorted_diffs[n_ev//2])/2
        print(f"  {ev_name:<20s} {n_ev:3d}  {bias_ev:+8.2f}  {rms_ev:8.2f}  {med:+8.2f}")

    # Detail for worst-fitting observations
    if opt_all:
        residuals = [(abs(r[3]-r[2]), r) for r in opt_all]
        residuals.sort(reverse=True)
        print(f"\n最大残差（前 5）：")
        for abs_res, r in residuals[:5]:
            ev, loc, obs, pred, dist = r
            print(f"  {ev}/{loc}: 观测值={obs:.1f}m  预测值={pred:.1f}m  差值={pred-obs:+.1f}m  距离={dist:.0f}km")

    # Suggested config.js update
    print(f"\n=== 建议更新 config.js ===")
    print(f"  tsuCoefA: {{ v:{best_a:.2f}, min:0.10, max:1.00, step:0.01, fmt:'%.2f', cat:'tsunami' }},")
    print(f"  tsuCoefB: {{ v:{best_b:.2f}, min:1.00, max:5.00, step:0.01, fmt:'%.2f', cat:'tsunami' }},")

    # Also check: if we split by near-field vs far-field, does cylindrical spreading hold?
    print(f"\n=== 几何扩散检查 ===")
    for label, dist_filter in [("近场 (<100km)", lambda d: d < 100),
                                ("中场 (100-300km)", lambda d: 100 <= d < 300),
                                ("远场 (300+ km)", lambda d: d >= 300)]:
        filt = [r for r in opt_all if dist_filter(r[4])]
        if not filt:
            continue
        diffs = [r[3] - r[2] for r in filt]
        n_f = len(diffs)
        bias_f = sum(diffs)/n_f
        rms_f = math.sqrt(sum(d*d for d in diffs)/n_f)
        print(f"  {label:<20s} n={n_f:2d}  偏差={bias_f:+5.1f}m  RMS={rms_f:.1f}m")

    # Magnitude-based breakdown
    print(f"\n=== 按震级统计 ===")
    mag_groups = {}
    for r in opt_all:
        for ev_name, ev_mag, _, _, _, _ in TSUNAMI_EVENTS:
            if ev_name == r[0]:
                m_bin = f"M{ev_mag:.1f}"
                if m_bin not in mag_groups:
                    mag_groups[m_bin] = []
                mag_groups[m_bin].append(r)
                break
    for m_bin in sorted(mag_groups.keys()):
        gr = mag_groups[m_bin]
        diffs = [r[3] - r[2] for r in gr]
        bias_m = sum(diffs)/len(diffs)
        rms_m = math.sqrt(sum(d*d for d in diffs)/len(diffs))
        print(f"  {m_bin:<8s} n={len(gr):2d}  偏差={bias_m:+5.1f}m  RMS={rms_m:.1f}m")


if __name__ == '__main__':
    main()
