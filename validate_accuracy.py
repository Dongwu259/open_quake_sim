#!/usr/bin/env python3
"""
Accuracy validation harness for Earthquake Simulator Pro v4.3.

Runs each preset earthquake to completion and compares the simulated peak JMA
Shindo at each city against the real recorded intensities in
public/geojson/observed.json, reporting per-event and global Bias / RMS
(in JMA-instrumental-intensity units; see SHINDO_SCORE below).

v4.3 additions:
  --csv FILE     Export per-observation residuals as CSV
  --bins         Show distance-binned and magnitude-binned residual statistics
  --llh          Compute log-likelihood (LLH) score using GMPE sigma
  --exclude-estimated  Use only directly observed event records
  --loeo         Show leave-one-event-out sensitivity statistics

Usage:
    1. Start the server:   node server.js
    2. Run:                python validate_accuracy.py [gmpModel] [--csv res.csv] [--bins] [--llh]
       e.g.                python validate_accuracy.py log --bins --llh
                          python validate_accuracy.py si-midorikawa --csv residuals.csv

Requires: pip install playwright ; python -m playwright install chromium
"""
import sys, os, time, math, json, argparse, csv as csv_mod
sys.stdout.reconfigure(encoding="utf-8")
from playwright.sync_api import sync_playwright

# JMA instrumental-intensity midpoints (distinguish 5-/5+/6-/6+; handle pre-1996 integers).
SHINDO_SCORE = {0:0,1:1,2:2,3:3,4:4,5:5.0,6:6.0,7:6.75,'5-':4.75,'5+':5.25,'6-':5.75,'6+':6.25}
def score(s):
    if isinstance(s, dict):
        return SHINDO_SCORE.get(s.get('shindo', s), float(s.get('shindo', 0)))
    return SHINDO_SCORE[s] if s in SHINDO_SCORE else float(s)

def haversine_km(lat1, lng1, lat2, lng2):
    """Great-circle distance in km between two lat/lng points."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng/2)**2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))

PRESETS = ["tohoku","kobe","kumamoto","kanto","chuetsu","iburihigashi","noto2024","tokachi2003",
           "iwate2008","noto2007","fukuoka2005","fukushima2011","tottori2016","yamagata2019","fukushima2021",
           "kushiro1993","tonankai1944","nankai1946","niigata1964"]

# v4.3: Epicenter coordinates for distance computation (from JMA / USGS catalog)
EPI_COORDS = {
    "tohoku":       (38.10, 142.86, 24),
    "kobe":         (34.60, 135.02, 16),
    "kumamoto":     (32.74, 130.81, 11),
    "kanto":        (35.40, 139.20, 23),
    "chuetsu":      (37.29, 138.87, 13),
    "iburihigashi": (42.72, 141.93, 37),
    "noto2024":     (37.50, 137.23, 16),
    "tokachi2003":  (41.78, 144.08, 42),
    "iwate2008":    (39.03, 140.88, 8),
    "noto2007":     (37.22, 136.69, 11),
    "fukuoka2005":  (33.68, 130.17, 9),
    "fukushima2011":(37.00, 140.48, 7),
    "tottori2016":  (35.38, 133.86, 11),
    "yamagata2019": (38.61, 139.53, 14),
    "fukushima2021":(37.73, 141.69, 55),
    "kushiro1993":  (42.85, 144.38, 101),
    "tonankai1944": (33.70, 136.20, 30),
    "nankai1946":   (33.00, 135.60, 30),
    "niigata1964":  (38.37, 139.22, 34),
}

# v4.3: Station coordinates lookup (loaded lazily)
def load_station_coords():
    """Return {city_name: (lat, lng)} from stations.json."""
    try:
        with open("public/geojson/stations.json", "r", encoding="utf-8") as f:
            stations = json.load(f)
        coords = {}
        for s in stations:
            if "name" in s and "lat" in s and "lng" in s:
                coords[s["name"]] = (s["lat"], s["lng"])
        return coords
    except Exception:
        return {}

def main():
    parser = argparse.ArgumentParser(description="Earthquake Simulator accuracy validation")
    parser.add_argument("model", nargs="?", default="log", help="GMPE model to test")
    parser.add_argument("--csv", help="Output residual CSV file path")
    parser.add_argument("--bins", action="store_true", help="Show binned residual analysis")
    parser.add_argument("--llh", action="store_true", help="Compute log-likelihood score")
    parser.add_argument("--include-estimated", action="store_true", help="Include records marked estimated (excluded by default)")
    parser.add_argument("--loeo", action="store_true", help="Show leave-one-event-out sensitivity")
    args = parser.parse_args()

    MODEL = args.model
    station_coords = load_station_coords() if (args.bins or args.csv) else {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width":1280,"height":800})
        page.on("pageerror", lambda e: print("[PAGEERROR]", e))
        page.goto("http://localhost:3000/", wait_until="domcontentloaded")
        page.wait_for_function("() => window.rawLandGrid && window.rawLandGrid.length>0 && window.OBSERVED", timeout=20000)
        OBS = page.evaluate("() => window.OBSERVED")
        page.evaluate(f"() => window.cfgSet('gmpModel','{MODEL}')")
        # The promo overlay (added after this harness was written) intercepts
        # pointer events; dismiss it before any UI interaction.
        page.evaluate("() => { try { window.closePromoModal && window.closePromoModal(); } catch(e){} }")
        extra_cfg = os.environ.get("QS_EXTRA_CFG", "")
        if extra_cfg:
            page.evaluate(f"() => {{ {extra_cfg} }}")
            print(f"[extra cfg] {extra_cfg}")

        all_rows = []  # for CSV export
        sigma_cache = {}
        print(f"\n=== gmpModel = {MODEL} ===")
        for pre in PRESETS:
            if not args.include_estimated and OBS[pre].get("estimated", False):
                continue
            page.evaluate("() => { try { window.resetSimulation() } catch(e){} }")
            page.wait_for_timeout(120)
            page.select_option("#preset", pre)
            page.evaluate("() => { document.getElementById('sim-speed').value = '10'; }")
            page.evaluate("() => { try { window.closePromoModal && window.closePromoModal(); } catch(e){} }")
            page.click("#btn-start")
            obs_entry = OBS[pre]["obs"]
            cities = list(obs_entry.keys())
            deadline = time.time() + 120
            while time.time() < deadline:
                page.wait_for_timeout(700)
                peaks = page.evaluate("() => window.peakShindoByName") or {}
                if all(c in peaks for c in cities): break
            page.wait_for_timeout(1500)
            peaks = page.evaluate("() => window.peakShindoByName") or {}

            ds = []
            mag = OBS[pre].get("mag", 7.0)
            mw_val = OBS[pre].get("mw", mag)
            src_type = OBS[pre].get("src", "crustal")
            epi = (OBS[pre].get("epi_lat"), OBS[pre].get("epi_lng"), OBS[pre].get("depth"))
            if epi[0] is None or epi[1] is None:
                epi = EPI_COORDS.get(pre)

            sigma_key = (MODEL, src_type, round(float(mw_val), 2))
            if sigma_key not in sigma_cache:
                sigma_cache[sigma_key] = page.evaluate(
                    "([model, src, mw]) => Physics.getGmpSigma(model, src, 'pga', mw)",
                    list(sigma_key))
            sigma_log10 = float(sigma_cache[sigma_key])
            # Current validation residuals are continuous JMA intensity scores.
            # For the PGA-controlled branch I = 2.23 log10(PGA) + const.
            sigma_shindo = 2.23 * sigma_log10

            for c in cities:
                sv = peaks.get(c)
                if sv is None: continue
                obs_val = obs_entry[c]
                residual = score(sv) - score(obs_val)
                ds.append(residual)

                # v4.3: Build rich observation row for CSV and binning
                row = {
                    "event": pre, "city": c, "mag": mag, "mw": mw_val,
                    "src_type": src_type, "gmp_model": MODEL,
                    "obs_shindo": obs_val if isinstance(obs_val, (str, int, float)) else obs_val.get("shindo", str(obs_val)),
                    "sim_shindo": sv,
                    "obs_score": score(obs_val), "sim_score": score(sv),
                    "residual": residual,
                    "estimated": bool(OBS[pre].get("estimated", False)),
                    "sigma_log10": sigma_log10,
                    "sigma_shindo": sigma_shindo,
                }
                # Distance from epicenter
                if epi and c in station_coords:
                    dist = haversine_km(epi[0], epi[1], station_coords[c][0], station_coords[c][1])
                    row["dist_km"] = round(dist, 1)
                    row["epi_lat"] = epi[0]
                    row["epi_lng"] = epi[1]
                    row["depth"] = epi[2]
                else:
                    row["dist_km"] = None
                    row["epi_lat"] = epi[0] if epi else None
                    row["epi_lng"] = epi[1] if epi else None
                    row["depth"] = epi[2] if epi else None
                all_rows.append(row)

            rms = math.sqrt(sum(x*x for x in ds)/len(ds)) if ds else float("nan")
            bias = sum(ds)/len(ds) if ds else float("nan")
            print(f"  {pre:15s} bias={bias:+.2f} rms={rms:.2f} (n={len(ds)})")

        all_d = [r["residual"] for r in all_rows]
        grms = math.sqrt(sum(x*x for x in all_d)/len(all_d)) if all_d else float("nan")
        gbias = sum(all_d)/len(all_d) if all_d else float("nan")
        print(f"  {'GLOBAL':15s} bias={gbias:+.3f} rms={grms:.3f} (n={len(all_d)})")
        direct = [r for r in all_rows if not r["estimated"]]
        estimated = [r for r in all_rows if r["estimated"]]
        _print_subset("DIRECT OBS", direct)
        _print_subset("ESTIMATED", estimated)

        # ---- v4.3: Binned residual analysis ----
        if args.bins and all_rows:
            _print_binned_analysis(all_rows)

        # ---- v4.3: Log-likelihood scoring ----
        if args.llh and all_rows:
            n = len(all_rows)
            llh_sum = sum(
                -0.5 * math.log(2 * math.pi * r["sigma_shindo"] ** 2)
                - 0.5 * (r["residual"] / r["sigma_shindo"]) ** 2
                for r in all_rows
            )
            print(f"\n  LLH = {llh_sum:.2f}  (mean LLH = {llh_sum/n:.4f} per obs, n={n})")
            print("  sigma_shindo = 2.23 × model sigma_log10 (PGA-controlled approximation)")

        if args.loeo and all_rows:
            print("\n--- Leave-One-Event-Out Sensitivity ---")
            for event in sorted({r["event"] for r in all_rows}):
                subset = [r for r in all_rows if r["event"] != event]
                residuals = [r["residual"] for r in subset]
                rms = math.sqrt(sum(x*x for x in residuals) / len(residuals))
                bias = sum(residuals) / len(residuals)
                print(f"  without {event:15s} bias={bias:+.3f} rms={rms:.3f} (n={len(residuals)})")

        # ---- v4.3: CSV export ----
        if args.csv and all_rows:
            fieldnames = ["event","city","mag","mw","src_type","gmp_model",
                          "obs_shindo","sim_shindo","obs_score","sim_score",
                          "residual","estimated","sigma_log10","sigma_shindo",
                          "dist_km","epi_lat","epi_lng","depth"]
            with open(args.csv, "w", newline="", encoding="utf-8") as f:
                writer = csv_mod.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
                writer.writeheader()
                writer.writerows(all_rows)
            print(f"\n  Wrote {len(all_rows)} rows to {args.csv}")

        browser.close()

def _print_subset(label, rows):
    if not rows:
        return
    residuals = [r["residual"] for r in rows]
    rms = math.sqrt(sum(x*x for x in residuals) / len(residuals))
    bias = sum(residuals) / len(residuals)
    print(f"  {label:15s} bias={bias:+.3f} rms={rms:.3f} (n={len(residuals)})")

def _print_binned_analysis(rows):
    """Print residuals binned by distance, magnitude, and source type."""
    print("\n--- Binned Residual Analysis ---")

    # Distance bins
    dist_bins = [(0, 50), (50, 100), (100, 200), (200, 400), (400, 9999)]
    print("\n  Distance bins:")
    print(f"  {'Bin':<20s} {'n':>4s}  {'Bias':>8s}  {'RMS':>8s}")
    for lo, hi in dist_bins:
        in_bin = [r for r in rows if r.get("dist_km") and lo <= r["dist_km"] < hi]
        if not in_bin: continue
        n_b = len(in_bin)
        res = [r["residual"] for r in in_bin]
        bias_b = sum(res)/n_b
        rms_b = math.sqrt(sum(x*x for x in res)/n_b)
        label = f"{lo}-{hi}km" if hi < 9999 else f"{lo}+ km"
        print(f"  {label:<20s} {n_b:4d}  {bias_b:+8.3f}  {rms_b:8.3f}")

    # Magnitude bins
    mag_bins = [(6.0, 6.5), (6.5, 7.0), (7.0, 7.5), (7.5, 8.0), (8.0, 10.0)]
    print("\n  Magnitude bins:")
    print(f"  {'Bin':<20s} {'n':>4s}  {'Bias':>8s}  {'RMS':>8s}")
    seen_events = set()
    for lo, hi in mag_bins:
        in_bin = [r for r in rows if lo <= r["mw"] < hi]
        if not in_bin: continue
        n_b = len(in_bin)
        res = [r["residual"] for r in in_bin]
        bias_b = sum(res)/n_b
        rms_b = math.sqrt(sum(x*x for x in res)/n_b)
        events_in_bin = len(set(r["event"] for r in in_bin))
        label = f"M{lo:.1f}-{hi:.1f}"
        print(f"  {label:<20s} {n_b:4d}  {bias_b:+8.3f}  {rms_b:8.3f}  ({events_in_bin} events)")

    # Source type bins
    print("\n  Source type:")
    print(f"  {'Type':<20s} {'n':>4s}  {'Bias':>8s}  {'RMS':>8s}")
    for st in ["crustal", "interplate", "intraslab"]:
        in_bin = [r for r in rows if r["src_type"] == st]
        if not in_bin: continue
        n_b = len(in_bin)
        res = [r["residual"] for r in in_bin]
        bias_b = sum(res)/n_b
        rms_b = math.sqrt(sum(x*x for x in res)/n_b)
        print(f"  {st:<20s} {n_b:4d}  {bias_b:+8.3f}  {rms_b:8.3f}")

if __name__ == "__main__":
    main()
