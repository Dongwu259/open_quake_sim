# -*- coding: utf-8 -*-
"""Regional high-resolution coastal bathymetry from the GEBCO 2025 Grid via
CEDA OPeNDAP. One union fetch (132-144.5E / 30-40.5N) at 0.0083° subsample,
then 3x3 water-mean aggregation into 0.025° regional grids:

  jp-sanriku  140.5-144.5E / 35.0-40.5N  (Tohoku Pacific ria coast)
  jp-nankai   132.0-139.0E / 30.0-35.0N  (Nankai trough: Kii -> Hyuga)
  jp-sagami   138.5-141.5E / 33.5-36.0N  (Sagami bay / Tokyo bay / Boso)

Water-mean aggregation (mixed cells average water samples only) keeps ria
bays open, matching the main-grid policy in build-bathymetry-gebco.py.
Output schema is quake-sim-terrain-grid-v1, loadable by Physics.validateResearchGrid.

Usage: python tools/build-bathymetry-regions.py [outdir]
       python tools/build-bathymetry-regions.py --one ID=lonW,latS,lonE,latN,RES
              [--label "description"] [outdir]

--one builds a single region grid outside the Japan union fetch (e.g. the
2026-09-25 regional-tsunami batch: cl-megathrust at 0.05°, it-messina at
0.025°). The 3x3 water-mean aggregation is identical; source offsets stay
cell-centered for any RES whose 240*RES source cells per axis are divisible
by the 3x3 fetch stride.
"""
import argparse
import json
import struct
import sys
import time
import urllib.request

BASE = ('https://dap.ceda.ac.uk/thredds/dodsC/bodc/gebco/global/gebco_2025/'
        'ice_surface_elevation/netcdf/GEBCO_2025.nc')
UNION = (132.0, 30.0, 144.5, 43.5)   # lonW, latS, lonE, latN
RES = 0.025
SRC_PER_DEG = 240
BLOCK = 6                            # 15" cells per 0.025° cell axis
STRIDE = 2                           # subsample: 3x3 per target cell
SUB = BLOCK // STRIDE
ATTRIBUTION = ('GEBCO Compilation Group (2025) GEBCO 2025 Grid '
               '(doi:10.5285/37c52e96-24ea-67ce-e063-7086abc05f29)')

REGIONS = [
    ('jp-sanriku', 140.5, 35.0, 144.5, 40.5, 'Sanriku / Tohoku Pacific coast'),
    ('jp-nankai',  132.0, 30.0, 139.0, 35.0, 'Nankai trough (Kii to Hyuga-nada)'),
    ('jp-sagami',  138.5, 33.5, 141.5, 36.0, 'Sagami bay / Tokyo bay / Boso'),
    ('jp-noto',    135.5, 35.5, 139.5, 38.5, 'Noto peninsula / Toyama bay'),
    ('jp-hokkaido-sw', 137.5, 40.5, 141.5, 43.5, 'SW Hokkaido / Okushiri (Japan Sea)'),
]


def source_index(deg, offset_deg):
    return int(round((deg + offset_deg) * SRC_PER_DEG - 0.5))


def fetch_union():
    lonW, latS, lonE, latN = UNION
    # Subsample offsets 1,3,5 within each 6-cell block keep samples centered.
    lo0 = source_index(lonW, 180.0) + 1
    la0 = source_index(latS, 90.0) + 1
    cols = int(round((lonE - lonW) * SRC_PER_DEG / STRIDE))  # 1500
    rows = int(round((latN - latS) * SRC_PER_DEG / STRIDE))  # 1260
    lo1 = lo0 + (cols - 1) * STRIDE
    data = []
    strip = 150
    row = 0
    while row < rows:
        hi = min(row + strip, rows) - 1
        url = ('%s.dods?elevation[%d:%d:%d][%d:%d:%d]'
               % (BASE, la0 + row * STRIDE, STRIDE, la0 + hi * STRIDE, lo0, STRIDE, lo1))
        want = (hi - row + 1) * cols
        raw = None
        last_err = None
        for attempt in range(4):
            try:
                print('GET rows %d-%d (attempt %d)' % (row, hi, attempt + 1), flush=True)
                req = urllib.request.Request(url, headers={'User-Agent': 'quake-sim-grid-build/1.0'})
                with urllib.request.urlopen(req, timeout=240) as resp:
                    raw = resp.read()
                break
            except Exception as err:  # noqa: BLE001
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
    return data, cols, rows


def aggregate(samples, cols):
    # Union subgrid -> 0.025° target cells (3x3 water-mean).
    tnx = int(round((UNION[2] - UNION[0]) / RES))  # 500
    tny = int(round((UNION[3] - UNION[1]) / RES))  # 420
    out = []
    for ty in range(tny):
        for tx in range(tnx):
            total = 0.0
            water_total = 0.0
            water_n = 0
            for sy in range(SUB):
                row = (ty * SUB + sy) * cols
                for sx in range(SUB):
                    v = samples[row + tx * SUB + sx]
                    total += v
                    if v < 0:
                        water_total += v
                        water_n += 1
            out.append(round(water_total / water_n if water_n else total / (SUB * SUB), 1))
    return out, tnx, tny


def write_regions(union_data, tnx, outdir):
    for rid, lonW, latS, lonE, latN, label in REGIONS:
        nx = int(round((lonE - lonW) / RES))
        ny = int(round((latN - latS) / RES))
        col0 = int(round((lonW - UNION[0]) / RES))
        row0 = int(round((latS - UNION[1]) / RES))
        data = []
        for y in range(ny):
            base = (row0 + y) * tnx + col0
            data.extend(union_data[base:base + nx])
        land = sum(1 for v in data if v >= 0)
        grid = {
            'origin': [lonW, latS], 'res': RES, 'nx': nx, 'ny': ny,
            'minDepth': min(data), 'maxDepth': max(data), 'data': data,
            'meta': {
                'schema': 'quake-sim-terrain-grid-v1',
                'dataset': 'GEBCO 2025 Grid (%s, 0.025° water-mean resample)' % label,
                'region': rid,
                'source': ATTRIBUTION + ' — subset via CEDA OPeNDAP, 3x3 point-sample water-mean per 0.025° cell',
                'license': 'Public domain (attribution requested): ' + ATTRIBUTION,
                'verticalDatum': 'Approximate mean sea level',
                'horizontalDatum': 'WGS84',
                'resolutionDegrees': RES,
                'quality': 'research',
                'continuousTopoBathy': True,
                'suitableFor': ['regional propagation demonstration', 'software verification'],
                'notSuitableFor': ['operational warning', 'site-specific run-up', 'engineering inundation'],
                'generated': time.strftime('%Y-%m-%d', time.gmtime()),
                'landCells': land,
                'waterCells': len(data) - land,
            },
        }
        path = '%s/%s.json' % (outdir, rid)
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(grid, fh, separators=(',', ':'))
        print('wrote %s: %dx%d land=%d water=%d min=%.1f max=%.1f'
              % (path, nx, ny, land, len(data) - land, min(data), max(data)), flush=True)


def fetch_one(bbox, res, strides_sub=3):
    """Fetch one bbox at 3x3 subsample for a res-degree target grid.

    Generalizes the Japan union fetch: source cells per target axis
    BLOCK = 240*res, fetch stride = BLOCK/SUB with centered offsets
    (2i+1)*BLOCK/(2*SUB) so each target cell samples its own middle.
    """
    lonW, latS, lonE, latN = bbox
    block = int(round(res * SRC_PER_DEG))
    sub = strides_sub
    stride = block // sub
    assert stride * sub == block, ('res not representable at 3x3 subsample', res, block)
    offs = [int(round((2 * i + 1) * block / (2.0 * sub))) for i in range(sub)]
    assert all(offs[i + 1] - offs[i] == stride for i in range(sub - 1)), offs
    lo0 = source_index(lonW, 180.0) + offs[0]
    la0 = source_index(latS, 90.0) + offs[0]
    cols = int(round((lonE - lonW) * SRC_PER_DEG / stride))
    rows = int(round((latN - latS) * SRC_PER_DEG / stride))
    lo1 = lo0 + (cols - 1) * stride
    data = []
    strip = 150
    row = 0
    while row < rows:
        hi = min(row + strip, rows) - 1
        url = ('%s.dods?elevation[%d:%d:%d][%d:%d:%d]'
               % (BASE, la0 + row * stride, stride, la0 + hi * stride, lo0, stride, lo1))
        want = (hi - row + 1) * cols
        raw = None
        last_err = None
        for attempt in range(4):
            try:
                print('GET rows %d-%d (attempt %d)' % (row, hi, attempt + 1), flush=True)
                req = urllib.request.Request(url, headers={'User-Agent': 'quake-sim-grid-build/1.0'})
                with urllib.request.urlopen(req, timeout=240) as resp:
                    raw = resp.read()
                break
            except Exception as err:  # noqa: BLE001
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
    return data, cols


def aggregate_one(samples, cols, bbox, res, sub=3):
    lonW, latS, lonE, latN = bbox
    tnx = int(round((lonE - lonW) / res))
    tny = int(round((latN - latS) / res))
    assert cols == tnx * sub, (cols, tnx)
    out = []
    for ty in range(tny):
        for tx in range(tnx):
            total = 0.0
            water_total = 0.0
            water_n = 0
            for sy in range(sub):
                row = (ty * sub + sy) * cols
                for sx in range(sub):
                    v = samples[row + tx * sub + sx]
                    total += v
                    if v < 0:
                        water_total += v
                        water_n += 1
            out.append(round(water_total / water_n if water_n else total / (sub * sub), 1))
    return out, tnx, tny


def write_one(data, origin, nx, ny, rid, res, label, outdir):
    lonW, latS = origin
    land = sum(1 for v in data if v >= 0)
    res_str = '%g' % res
    grid = {
        'origin': [lonW, latS], 'res': res, 'nx': nx, 'ny': ny,
        'minDepth': min(data), 'maxDepth': max(data), 'data': data,
        'meta': {
            'schema': 'quake-sim-terrain-grid-v1',
            'dataset': 'GEBCO 2025 Grid (%s, %s° water-mean resample)' % (label, res_str),
            'region': rid,
            'source': ATTRIBUTION + ' — subset via CEDA OPeNDAP, 3x3 point-sample water-mean per %s° cell' % res_str,
            'license': 'Public domain (attribution requested): ' + ATTRIBUTION,
            'verticalDatum': 'Approximate mean sea level',
            'horizontalDatum': 'WGS84',
            'resolutionDegrees': res,
            'quality': 'research',
            'continuousTopoBathy': True,
            'suitableFor': ['regional propagation demonstration', 'software verification'],
            'notSuitableFor': ['operational warning', 'site-specific run-up', 'engineering inundation'],
            'generated': time.strftime('%Y-%m-%d', time.gmtime()),
            'landCells': land,
            'waterCells': len(data) - land,
        },
    }
    import os
    path = '%s/%s.json' % (outdir, rid)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(grid, fh, separators=(',', ':'))
    print('wrote %s: %dx%d res=%s land=%d water=%d min=%.1f max=%.1f'
          % (path, nx, ny, res_str, land, len(data) - land, min(data), max(data)), flush=True)


def main_one(args):
    import os
    rid, bbox_s = args.one.split('=', 1)
    parts = [float(x) for x in bbox_s.split(',')]
    lonW, latS, lonE, latN, res = parts
    assert lonE > lonW and latN > latS and res > 0, parts
    outdir = args.outdir or 'public/geojson/grids'
    os.makedirs(outdir, exist_ok=True)
    label = args.label or rid
    samples, cols = fetch_one((lonW, latS, lonE, latN), res)
    data, tnx, tny = aggregate_one(samples, cols, (lonW, latS, lonE, latN), res)
    write_one(data, (lonW, latS), tnx, tny, rid, res, label, outdir)


def main():
    parser = argparse.ArgumentParser(description='Regional 0.025/0.05° terrain grids from GEBCO 2025 via CEDA OPeNDAP')
    parser.add_argument('--one', metavar='ID=lonW,latS,lonE,latN,RES', help=None,
                        default=None)
    parser.add_argument('--label', default=None)
    parser.add_argument('--outdir', default=None)
    parser.add_argument('outdir_pos', nargs='?', default=None)
    args = parser.parse_args()
    if args.outdir_pos and not args.outdir:
        args.outdir = args.outdir_pos
    if args.one:
        main_one(args)
        return
    outdir = args.outdir or 'public/geojson/grids'
    import os
    os.makedirs(outdir, exist_ok=True)
    samples, cols, _ = fetch_union()
    union_data, tnx, _ = aggregate(samples, cols)
    write_regions(union_data, tnx, outdir)


if __name__ == '__main__':
    main()
