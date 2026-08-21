"""
Add per-station site factors to stations.json.
Uses the existing 15-province box model to compute factors,
defaulting to 1.0 for stations outside any province.
"""
import json
import math

# Same 15 province boxes as physics.js SOIL_PROVINCES
# [lat_min, lat_max, lng_min, lng_max, factor]
PROVINCES = [
    [35.0,36.6,139.0,140.8,1.65],  # Kanto
    [34.8,35.5,136.5,137.2,1.55],  # Chukyo
    [34.3,35.0,135.0,135.8,1.55],  # Kinki
    [38.0,38.5,140.7,141.3,1.45],  # Sendai
    [42.7,43.3,141.1,141.8,1.45],  # Ishikari
    [37.6,38.1,138.8,139.5,1.40],  # Niigata
    [36.5,36.9,137.1,137.5,1.35],  # Toyama
    [33.4,33.8,130.2,130.6,1.40],  # Fukuoka
    [33.4,33.7,133.4,133.7,1.35],  # Kochi
    [43.0,44.5,141.3,145.5,1.25],  # Hokkaido east
    [35.2,35.6,136.8,137.0,1.30],  # Gifu
    [34.5,34.8,135.3,135.6,1.30],  # Osaka
    [35.5,36.0,138.9,139.4,1.25],  # Yamanashi
    [31.2,31.8,130.3,131.2,1.20],  # Kagoshima
    [26.0,27.0,127.6,128.3,1.30],  # Okinawa
]

# Default site factors: hardMin was 0.88, but physically 1.0 is more reasonable
# for unknown sites (no amplification, no deamplification)
DEFAULT_FACTOR = 1.0
SITEHARD_MIN = 0.88
SITESOFT_MAX = 1.65
SITEBASE = 1.00

def get_province_factor(lat, lng):
    """Compute site factor matching physics.js soilAmp function."""
    for p in PROVINCES:
        if p[0] <= lat <= p[1] and p[2] <= lng <= p[3]:
            return SITEBASE + (p[4] - 1.0) * (SITESOFT_MAX - SITEHARD_MIN) / 0.77
    return SITEHARD_MIN  # default outside any province

def main():
    with open('public/geojson/stations.json', 'r', encoding='utf-8') as f:
        stations = json.load(f)

    province_count = 0
    for s in stations:
        factor = get_province_factor(s['lat'], s['lng'])
        s['siteFactor'] = round(factor, 3)
        if factor > SITEHARD_MIN:
            province_count += 1

    print(f"Added siteFactor to {len(stations)} stations")
    print(f"  {province_count} stations in known soft-soil provinces")
    print(f"  {len(stations) - province_count} stations with default (hard rock) factor")

    with open('public/geojson/stations.json', 'w', encoding='utf-8') as f:
        json.dump(stations, f, ensure_ascii=False, separators=(',', ':'))
    print("Written to public/geojson/stations.json")


if __name__ == '__main__':
    main()
