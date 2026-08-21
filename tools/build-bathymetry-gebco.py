#!/usr/bin/env python3
"""Build public/geojson/bathymetry.json from the GEBCO 2025 Grid (public domain,
attribution requested) via the CEDA OPeNDAP service.

The output keeps the existing quake-sim-terrain-grid-v1 schema: origin [120,20],
res 0.15 deg, 200x200 cells covering 120-150E / 20-50N. Each target cell is the
mean of 36 point samples taken on a 0.025 deg stride subgrid (6x6 per cell) from
the 15 arc-second source grid. The 15" cells tile the 0.15 deg cells exactly
(36 per axis), so the subsample is symmetric within each target cell.

Usage: python tools/build-bathymetry-gebco.py [output-path]
"""
import json
import struct
import sys
import time
import urllib.request

BASE = ('https://dap.ceda.ac.uk/thredds/dodsC/bodc/gebco/global/gebco_2025/'
        'ice_surface_elevation/netcdf/GEBCO_2025.nc')
ORIGIN_LON, ORIGIN_LAT = 120.0, 20.0
RES = 0.15
NX = NY = 200
SRC_PER_DEG = 240          # 15 arc-second source grid
BLOCK = 36                 # source cells per target cell axis (0.15 * 240)
STRIDE = 6                 # subsample stride inside the block
SUB = BLOCK // STRIDE      # 6x6 samples per target cell
ATTRIBUTION = ('GEBCO Compilation Group (2025) GEBCO 2025 Grid '
               '(doi:10.5285/37c52e96-24ea-67ce-e063-7086abc05f29)')


def source_index(deg, offset_deg):
    # Source cell centres sit at -180/-90 + (i + 0.5) / 240.
    return int(round((deg + offset_deg) * SRC_PER_DEG - 0.5))


def fetch_subset():
    # First sample of each 36-cell block at +3 source cells so the 6-sample
    # stride covers the block symmetrically (offsets 3,9,15,21,27,33).
    lo0 = source_index(ORIGIN_LON, 180.0) + 3
    la0 = source_index(ORIGIN_LAT, 90.0) + 3
    span = NX * BLOCK  # 7200 source cells
    lo1 = lo0 + span - STRIDE
    rows = span // STRIDE  # 1200 subsampled rows/cols
    # CEDA dodsC stalls on multi-MB single slices; fetch in latitude strips.
    strip = 150
    data = []
    row = 0
    while row < rows:
        hi = min(row + strip, rows) - 1
        url = ('%s.dods?elevation[%d:%d:%d][%d:%d:%d]'
               % (BASE, la0 + row * STRIDE, STRIDE, la0 + hi * STRIDE, lo0, STRIDE, lo1))
        want = (hi - row + 1) * rows
        last_err = None
        raw = None
        for attempt in range(4):
            try:
                print('GET rows %d-%d (attempt %d)' % (row, hi, attempt + 1), flush=True)
                req = urllib.request.Request(url, headers={'User-Agent': 'quake-sim-grid-build/1.0'})
                with urllib.request.urlopen(req, timeout=240) as resp:
                    raw = resp.read()
                break
            except Exception as err:  # noqa: BLE001 - retry any transient network failure
                last_err = err
                print('  failed: %s' % err, flush=True)
                time.sleep(5 * (attempt + 1))
        if raw is None:
            raise SystemExit('download failed: %s' % last_err)
        marker = b'\nData:\n'
        pos = raw.find(marker)
        if pos < 0:
            raise SystemExit('not a DODS response: %r' % raw[:200])
        body = raw[pos + len(marker):]
        count1, count2 = struct.unpack('>2i', body[:8])
        if count1 != want or count2 != want:
            raise SystemExit('unexpected array counts %r (want %d)' % ((count1, count2), want))
        data.extend(struct.unpack('>%di' % want, body[8:8 + 4 * want]))
        row = hi + 1
    print('fetched %d samples' % len(data), flush=True)
    return data


def build_grid(samples):
    # Mixed coastal cells are averaged over their WATER samples only. A plain
    # mean lets land elevations dominate 16.7 km cells and closes narrow ria
    # bays (Onagawa/Sanriku), which kills modelled run-up; water-mean keeps
    # genuine waterways open without flooding solidly-land blocks.
    side = NX * SUB  # 1200 x 1200 subsampled grid
    out = []
    for ty in range(NY):
        for tx in range(NX):
            total = 0.0
            water_total = 0.0
            water_n = 0
            for sy in range(SUB):
                row = (ty * SUB + sy) * side
                for sx in range(SUB):
                    v = samples[row + tx * SUB + sx]
                    total += v
                    if v < 0:
                        water_total += v
                        water_n += 1
            out.append(round(water_total / water_n if water_n else total / (SUB * SUB), 1))
    return out


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else 'public/geojson/bathymetry.json'
    data = build_grid(fetch_subset())
    land = sum(1 for v in data if v >= 0)
    water = len(data) - land
    grid = {
        'origin': [ORIGIN_LON, ORIGIN_LAT],
        'res': RES,
        'nx': NX,
        'ny': NY,
        'minDepth': min(data),
        'maxDepth': max(data),
        'data': data,
        'meta': {
            'schema': 'quake-sim-terrain-grid-v1',
            'dataset': 'GEBCO 2025 Grid (Japan region, 0.15° block-mean resample)',
            'source': ATTRIBUTION + ' — subset 120-150E/20-50N via CEDA OPeNDAP, '
                     '6x6 point-sample mean per 0.15° cell',
            'license': 'Public domain (attribution requested): ' + ATTRIBUTION,
            'verticalDatum': 'Approximate mean sea level',
            'horizontalDatum': 'WGS84',
            'resolutionDegrees': RES,
            'quality': 'research',
            'suitableFor': ['regional propagation demonstration', 'software verification'],
            'notSuitableFor': ['operational warning', 'site-specific run-up', 'engineering inundation'],
            'generated': time.strftime('%Y-%m-%d', time.gmtime()),
            'landCells': land,
            'waterCells': water,
        },
    }
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(grid, fh, separators=(',', ':'))
    print('wrote %s: land=%d water=%d min=%.1f max=%.1f' % (out_path, land, water, min(data), max(data)))


if __name__ == '__main__':
    main()
