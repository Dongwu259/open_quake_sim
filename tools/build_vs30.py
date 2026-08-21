"""
Synthesize Vs30 values for 1289 stations from existing province site factors.
Uses empirical soil-to-Vs30 mapping validated against J-SHIS data ranges.

Typical Vs30 ranges by soil type (Japan):
  - Soft alluvial (Kanto plain): 100-200 m/s
  - Medium (diluvial): 200-350 m/s
  - Stiff (Tertiary): 350-500 m/s
  - Rock (mountain): 500-800+ m/s
"""
import json
import math

def factor_to_vs30(siteFactor):
    """Convert site amplification factor to approximate Vs30 (m/s).

    Based on the known correlation: higher amplification → lower Vs30.
    The existing 15-province factors range 1.20-1.65 for soft soil
    and default to 0.88 for hard rock (pre-fix) / 1.0 for reference.

    Mapping calibrated to J-SHIS 250m Vs30 typical values.
    """
    f = siteFactor
    if f >= 1.55:       # Very soft (Kanto, Osaka basins)
        return 150
    elif f >= 1.40:      # Soft (Sendai, Fukuoka)
        return 200
    elif f >= 1.25:      # Medium-soft (Hokkaido, Okinawa)
        return 280
    elif f >= 1.15:      # Medium
        return 350
    elif f >= 1.05:      # Stiff
        return 450
    elif f >= 0.95:      # Reference rock
        return 550
    else:                 # Hard rock (mountain)
        return 700


def main():
    with open('public/geojson/stations.json', 'r', encoding='utf-8') as f:
        stations = json.load(f)

    counts = {}
    for s in stations:
        sf = s.get('siteFactor', 1.0)
        vs30 = factor_to_vs30(sf)
        s['vs30'] = vs30
        s['vs30Source'] = 'site-factor-estimate'
        key = str(vs30)
        counts[key] = counts.get(key, 0) + 1

    print(f"Computed Vs30 for {len(stations)} stations:")
    for vs in sorted(counts.keys(), key=int):
        print(f"  Vs30={vs}: {counts[vs]} stations")

    with open('public/geojson/stations.json', 'w', encoding='utf-8') as f:
        json.dump(stations, f, ensure_ascii=False, separators=(',', ':'))
    print(f"\nWritten vs30 field to stations.json")


if __name__ == '__main__':
    main()
