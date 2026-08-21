#!/usr/bin/env python3
"""
Calibrate GMPE coefficients (attA, attB, attC) to minimize RMS against
observed JMA Shindo data. Uses scipy.optimize for gradient-free optimization.

Run: python tools/calibrate_gmpe.py
"""
import json
import math
import sys
from scipy.optimize import minimize

# Load observed data
with open('public/geojson/observed.json', 'r', encoding='utf-8') as f:
    observed = json.load(f)

# Load stations
with open('public/geojson/stations.json', 'r', encoding='utf-8') as f:
    stations = json.load(f)

# Station name -> (lat, lng, vs30) lookup
station_lookup = {}
for s in stations:
    station_lookup[s['name']] = (s['lat'], s['lng'], s.get('vs30', 400))


# ---- Replicate physics.js calculations (same formulas) ----

EARTH_R = 6371

def haversine_dist(lat1, lng1, lat2, lng2):
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng/2)**2
    return 2 * EARTH_R * math.atan2(math.sqrt(a), math.sqrt(1-a))

def hypo_dist(slat, slng, elat, elng, depth):
    surf = haversine_dist(elat, elng, slat, slng)
    return math.sqrt(surf**2 + depth**2)

def pga_log(mag, Rkm, attA, attB, attC, anelastic=0):
    effM = mag if mag <= 9 else 9 + (mag-9)*0.3
    h = 10**(0.35*effM - 1.0)
    Reff = math.sqrt(Rkm**2 + h**2)
    return 10**(attA*effM - attB*math.log10(Reff) - anelastic*Reff + attC)

def pgv_log(mag, Rkm, pgvA=0.50, pgvB=1.40, pgvC=-1.20, anelastic=0):
    effM = mag if mag <= 9 else 9 + (mag-9)*0.3
    h = 10**(0.35*effM - 1.0)
    Reff = math.sqrt(Rkm**2 + h**2)
    return 10**(pgvA*effM - pgvB*math.log10(Reff) - anelastic*Rkm + pgvC)

def jma_intensity(pga_gal, pgv_cms):
    if pga_gal <= 0.01 and pgv_cms <= 0.001:
        return 0
    ipga = 2.23*math.log10(pga_gal*0.94)+0.5 if pga_gal>0.01 else 0
    ipgv = 2.68+1.72*math.log10(pgv_cms) if pgv_cms>0.001 else 0
    return max(0, max(ipgv, ipga))

def shindo_score(s):
    """Convert Shindo display value to numeric score"""
    table = {0:0,1:1,2:2,3:3,4:4,5:5.0,6:6.0,7:6.75,'5-':4.75,'5+':5.25,'6-':5.75,'6+':6.25}
    if s in table: return table[s]
    try: return float(s)
    except: return 0


def predict_shindo(event, attA, attB, attC, pgvA=0.50, pgvB=1.40, pgvC=-1.20, ds_inter=0.12, ds_intra=0.22):
    """Predict Shindo for all cities in an event, return list of (observed, predicted) scores."""
    mag = event['mag']
    mw = event.get('mw', mag)
    depth = event['depth']
    elat = event['lat']
    elng = event['lng']
    src = event.get('src', 'crustal')

    # log-FF source boost
    src_boost = 0.0
    if src == 'interplate':
        src_boost = ds_inter
    elif src == 'intraslab':
        src_boost = ds_intra

    results = []
    for city_name, obs_shindo_str in event['obs'].items():
        if city_name not in station_lookup:
            continue
        slat, slng, vs30 = station_lookup[city_name]
        dist = hypo_dist(slat, slng, elat, elng, depth)

        # Compute PGA/PGV using log model, with source boost
        pga = pga_log(mw, dist, attA, attB, attC) * 10**src_boost
        pgv = pgv_log(mw, dist, pgvA, pgvB, pgvC) * 10**src_boost

        # Apply site amplification
        if vs30 and vs30 > 0:
            sa_pga = 10**(1.4 - 0.4*math.log10(vs30/400))
            sa_pgv = 10**(1.83 - 0.53*math.log10(vs30/400))
            pga *= sa_pga
            pgv *= sa_pgv

        # JMA intensity -> Shindo
        I = jma_intensity(pga, pgv)

        # Convert to Shindo (same threshold as intensityToShindo)
        if I < 0.5: sh = 0
        elif I < 1.5: sh = 1
        elif I < 2.5: sh = 2
        elif I < 3.5: sh = 3
        elif I < 4.5: sh = 4
        elif I < 5.0: sh = '5-'
        elif I < 5.5: sh = '5+'
        elif I < 6.0: sh = '6-'
        elif I < 6.5: sh = '6+'
        else: sh = 7

        obs_score = shindo_score(obs_shindo_str)
        pred_score = shindo_score(sh)
        results.append((obs_shindo_str, sh, obs_score, pred_score, dist, pga, I))

    return results


def compute_metrics(event_list, attA, attB, attC, pgvA=0.50, pgvB=1.40, pgvC=-1.20, ds_inter=0.12, ds_intra=0.22):
    """Compute global RMS and bias for given coefficients."""
    all_diffs = []
    per_event = {}

    for key in event_list:
        event = observed[key]
        event['lat'] = PRESET_COORDS[key][0]
        event['lng'] = PRESET_COORDS[key][1]
        event['depth'] = PRESET_COORDS[key][2]
        results = predict_shindo(event, attA, attB, attC, pgvA, pgvB, pgvC, ds_inter, ds_intra)
        if not results:
            continue
        diffs = [pred - obs for _, _, obs, pred, _, _, _ in results]
        rms = math.sqrt(sum(d**2 for d in diffs)/len(diffs))
        bias = sum(diffs)/len(diffs)
        per_event[key] = (bias, rms, len(diffs), results)
        all_diffs.extend(diffs)

    global_rms = math.sqrt(sum(d**2 for d in all_diffs)/len(all_diffs))
    global_bias = sum(all_diffs)/len(all_diffs)
    return global_bias, global_rms, per_event


# Event coordinates from app.js PRESETS
PRESET_COORDS = {
    'tohoku': (38.10, 142.86, 24),
    'kobe': (34.58, 135.02, 16),
    'kumamoto': (32.75, 130.76, 11),
    'kanto': (35.33, 139.50, 23),
    'chuetsu': (37.29, 138.87, 13),
    'iburihigashi': (42.69, 142.01, 37),
    'noto2024': (37.50, 137.27, 16),
    'tokachi2003': (41.78, 144.08, 42),
    'iwate2008': (39.03, 140.88, 8),
    'noto2007': (37.22, 136.69, 11),
    'fukuoka2005': (33.68, 130.15, 9),
    'fukushima2011': (37.00, 140.48, 6),
    'tottori2016': (35.38, 133.86, 11),
    'yamagata2019': (38.61, 139.53, 14),
    'fukushima2021': (37.73, 141.70, 55),
    'kushiro1993': (42.93, 144.38, 103),
}

EVENT_LIST = list(PRESET_COORDS.keys())


def objective(params):
    """Minimize global RMS."""
    attA, attB, attC, pgvA, pgvB, pgvC, ds_inter, ds_intra = params
    _, rms, _ = compute_metrics(EVENT_LIST, attA, attB, attC, pgvA, pgvB, pgvC, ds_inter, ds_intra)
    return rms


def main():
    # Baseline (current calibrated values from v3.3)
    bl_attA, bl_attB, bl_attC = 0.42, 1.34, 0.31
    bl_pgvA, bl_pgvB, bl_pgvC = 0.50, 1.40, -1.20
    bl_dsI, bl_dsN = 0.12, 0.22

    print("=== Baseline (current calibrated) ===")
    b_bias, b_rms, b_per = compute_metrics(EVENT_LIST, bl_attA, bl_attB, bl_attC, bl_pgvA, bl_pgvB, bl_pgvC, bl_dsI, bl_dsN)
    for key in EVENT_LIST:
        if key in b_per:
            bias, rms, n, _ = b_per[key]
            print(f"  {key:20s} bias={bias:+5.2f} rms={rms:.2f} (n={n})")
    print(f"  {'GLOBAL':20s} bias={b_bias:+5.2f} rms={b_rms:.3f} (n={sum(v[2] for v in b_per.values())})")

    # Optimize 8 parameters
    print("\n=== Optimizing 8 parameters (PGA + PGV + source boosts) ===")
    x0 = [bl_attA, bl_attB, bl_attC, bl_pgvA, bl_pgvB, bl_pgvC, bl_dsI, bl_dsN]
    bounds = [
        (0.10, 1.00),   # attA
        (0.50, 2.00),   # attB
        (-1.0, 2.00),   # attC
        (0.20, 0.80),   # pgvA
        (0.80, 2.00),   # pgvB
        (-2.50, 0.00),  # pgvC
        (0.00, 0.30),   # ds_inter
        (0.05, 0.40),   # ds_intra
    ]
    result = minimize(objective, x0, method='Nelder-Mead', bounds=bounds,
                      options={'maxiter': 1000, 'xatol': 0.0001, 'fatol': 0.00001})
    bestA, bestB, bestC, bestPA, bestPB, bestPC, bestDI, bestDN = result.x
    print(f"  Converged after {result.nit} iterations")
    print(f"  PGA: attA={bestA:.4f}, attB={bestB:.4f}, attC={bestC:.4f}")
    print(f"  PGV: pgvA={bestPA:.4f}, pgvB={bestPB:.4f}, pgvC={bestPC:.4f}")
    print(f"  log-FF: ds_inter={bestDI:.4f}, ds_intra={bestDN:.4f}")

    # Optimized result
    print(f"\n=== Optimized ===")
    o_bias, o_rms, o_per = compute_metrics(EVENT_LIST, bestA, bestB, bestC, bestPA, bestPB, bestPC, bestDI, bestDN)
    for key in EVENT_LIST:
        if key in o_per:
            bias, rms, n, results = o_per[key]
            print(f"  {key:20s} bias={bias:+5.2f} rms={rms:.2f} (n={n})")
            if rms > 1.5:
                for obs_sh, pred_sh, obs_sc, pred_sc, d, pga, I in results:
                    print(f"    {obs_sh:>4s} -> {str(pred_sh):>4s}  d={d:.0f}km  PGA={pga:.0f}gal  I={I:.1f}")
    print(f"  {'GLOBAL':20s} bias={o_bias:+5.2f} rms={o_rms:.3f}")

    improvement = (b_rms - o_rms) / b_rms * 100
    print(f"\n  Improvement: {improvement:.1f}%")

    # Suggest config.js update
    print(f"\n=== Suggested config.js update ===")
    print(f"  attA:     {{ v:{bestA:.2f}, ... }}")
    print(f"  attB:     {{ v:{bestB:.2f}, ... }}")
    print(f"  attC:     {{ v:{bestC:.2f}, ... }}")
    print(f"  pgvA:     {{ v:{bestPA:.2f}, ... }}")
    print(f"  pgvB:     {{ v:{bestPB:.2f}, ... }}")
    print(f"  pgvC:     {{ v:{bestPC:.2f}, ... }}")
    print(f"  dsInter:  {{ v:{bestDI:.3f}, ... }}")
    print(f"  dsIntra:  {{ v:{bestDN:.3f}, ... }}")


if __name__ == '__main__':
    if 'scipy' not in sys.modules:
        try:
            import scipy
        except ImportError:
            print("Need scipy: pip install scipy")
            sys.exit(1)
    main()
