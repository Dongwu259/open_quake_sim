#!/usr/bin/python
"""Build the trans-Pacific 0.25 deg terrain grid used by the v5.8 R5-2
dispersion validation (1960 Chile -> Japan trans-oceanic case).

Output: tools/data/grids/pacific-1960.json (quake-sim-terrain-grid-v1).

Window: lng 150..290 (i.e. 150 E eastward across the dateline to 70 W),
lat -50..45. The longitude axis stays LINEAR in the wrapped frame
(lng values > 180 represent lng-360); the solver, Okada accumulation and
probes all use linear lng arithmetic, so the frame is internally consistent.
The grid is an OFFLINE validation asset (tools/data), never bundled under
public/ — the production app keeps the Japan-region 0.15 deg grid.

Each target cell is the mean of 3x3 point samples (stride 20 source cells =
5 arcmin) from the GEBCO 2025 15 arc-second grid via the CEDA OPeNDAP
service, mirroring tools/build-bathymetry-gebco.py.

Usage: python tools/build-bathymetry-pacific.py [output-path]
"""
import json
import struct
import sys
import time
import urllib.request

BASE = ('https://dap.ceda.ac.uk/thredds/dodsC/bodc/gebco/global/gebco_2025/'
        'ice_surface_elevation/netcdf/GEBCO_2025.nc')
ORIGIN_LON, ORIGIN_LAT = 135.0, -50.0
RES = 0.25
NX, NY = 630, 380          # 135..292.5 E wrapped (i.e. to 67.5 W), -50..45 N
SRC_PER_DEG = 240          # 15 arc-second source grid
BLOCK = int(RES * SRC_PER_DEG)   # 60 source cells per target axis
STRIDE = 20                # subsample stride inside the block (5 arcmin)
SUB = BLOCK // STRIDE      # 3 samples per axis
ATTRIBUTION = ('GEBCO Compilation Group (2025) GEBCO 2025 Grid '
               '(doi:10.5285/37c52e96-24ea-67ce-e063-7086abc05f29)')


def source_index(deg, offset_deg):
    return int(round((deg + offset_deg) * SRC_PER_DEG - 0.5))


# The window crosses the dateline, so the source longitude range splits into
# two contiguous segments: 150..180 E and -180..-70 (the wrapped 180..290).
def lon_segments():
    segs = []
    # segment A: target x 0..179 -> source lng 135..180
    start_a = source_index(ORIGIN_LON, 180.0) + 10
    end_a = source_index(179.75, 180.0) + 10
    segs.append((start_a, 180 * SUB))
    # segment B: target x 180..629 -> source lng -180..-67.75
    start_b = source_index(-180.0, 180.0) + 10
    end_b = source_index(-67.75, 180.0) + 10
    segs.append((start_b, 450 * SUB))
    return segs


def fetch_rows():
    # First sample of each 60-cell block at +10 source cells so the 3-sample
    # stride covers the block symmetrically (offsets 10,30,50).
    la0 = source_index(ORIGIN_LAT, 90.0) + 10
    rows = NY * SUB
    segs = lon_segments()
    data = [None] * (rows * NX * SUB)
    strip = 60
    row = 0
    while row < rows:
        hi = min(row + strip, rows) - 1
        row_vals = []
        for seg_start, seg_cols in segs:
            url = ('%s.dods?elevation[%d:%d:%d][%d:%d:%d]'
                   % (BASE, la0 + row * STRIDE, STRIDE, la0 + hi * STRIDE,
                      seg_start, STRIDE, seg_start + (seg_cols - 1) * STRIDE))
            last_err = None
            for attempt in range(5):
                try:
                    print('GET rows %d-%d seg@%d (attempt %d)' % (row, hi, seg_start, attempt + 1), flush=True)
                    req = urllib.request.Request(url, headers={'User-Agent': 'quake-sim-grid-build/1.0'})
                    with urllib.request.urlopen(req, timeout=300) as resp:
                        raw = resp.read()
                    count = (hi - row + 1) * seg_cols
                    # dods XDR payload: two 4-byte length words, then the
                    # elevation values as big-endian int32 (mirrors
                    # tools/build-bathymetry-regions.py — an int16 parse
                    # silently misaligns the whole field)
                    marker = b'\nData:\n'
                    pos = raw.find(marker)
                    if pos < 0:
                        raise RuntimeError('not a DODS response: %r' % raw[:120])
                    body = raw[pos + len(marker):]
                    count1, count2 = struct.unpack('>2i', body[:8])
                    if count1 != count or count2 != count:
                        raise RuntimeError('unexpected array counts %r (want %d)' % ((count1, count2), count))
                    vals = struct.unpack('>%di' % count, body[8:8 + 4 * count])
                    row_vals.append((vals, seg_cols))
                    last_err = None
                    break
                except Exception as exc:  # noqa: BLE001 - retry any transport error
                    last_err = exc
                    time.sleep(5 * (attempt + 1))
            if last_err is not None:
                raise SystemExit('fetch failed at row %d seg %d: %s' % (row, seg_start, last_err))
        # interleave the two longitude segments back into target column order
        cols = NX * SUB
        base_dst = row * cols
        (seg_a, cols_a), (seg_b, cols_b) = row_vals
        for r in range(hi - row + 1):
            dst = base_dst + r * cols
            src_a = r * cols_a
            src_b = r * cols_b
            for i in range(cols_a):
                data[dst + i] = seg_a[src_a + i]
            for i in range(cols_b):
                data[dst + cols_a + i] = seg_b[src_b + i]
        row = hi + 1
    return data


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else 'tools/data/grids/pacific-1960.json'
    data = fetch_rows()
    cols = NX * SUB
    grid = []
    for y in range(NY):
        for x in range(NX):
            total = 0
            for sy in range(SUB):
                base = (y * SUB + sy) * cols + x * SUB
                for sx in range(SUB):
                    total += data[base + sx]
            grid.append(round(total / (SUB * SUB), 2))
    doc = {
        'schema': 'quake-sim-terrain-grid-v1',
        'origin': [ORIGIN_LON, ORIGIN_LAT],
        'res': RES,
        'nx': NX,
        'ny': NY,
        'data': grid,
        'meta': {
            'schema': 'quake-sim-terrain-grid-v1',
            'dataset': ('GEBCO 2025 Grid (trans-Pacific window for the 1960 Chile '
                        'trans-oceanic dispersion case, 0.25 deg 3x3 subsample mean)'),
            'region': 'pacific-1960',
            'source': ATTRIBUTION + ' — subset via CEDA OPeNDAP, 3x3 subsample per cell',
            'cellConvention': 'centre at origin + i*res; lng axis linear in the wrapped frame (lng>180 means lng-360)',
            'quality': 'research',
            'builtBy': 'tools/build-bathymetry-pacific.py',
            'builtAt': time.strftime('%Y-%m-%d'),
        },
    }
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, separators=(',', ':'))
    print('wrote %s (%d cells)' % (out_path, len(grid)))


if __name__ == '__main__':
    main()
