# -*- coding: utf-8 -*-
#!/usr/bin/env python
"""
v6.4 region Vs30: California Vs30 package builder.

Source: Yong, A., Thompson, E.M., Wald, D.J., and Worden, C.B. (2014),
  "A VS30 Map for California with Geologic and Topographic Constraints",
  BSSA 104(5), 2313-2321, DOI 10.1785/0120130312.
  Grid fetched from the USGS global-vs30 assembly repo
  (github.com/usgs/earthquake-global_vs30, California/California_Vs30_7p5c.grd,
  public domain / USGS). Data release: sciencebase 5a5fa029e4b06e28e9bfc43a.
  Fetch first:  node tools/fetch-region-vs30.js   (writes .cache/California_Vs30_7p5c.grd)

Input format (fixed, asserted): GMT netCDF-4/HDF5 — datasets z(ny,nx) float32
  with dimension scales lat/lon (ascending), _FillValue NaN, WGS84. Water is
  coded 0 (verified: modal value 0 = 13.4M cells offshore); land 150-1636 m/s.

Output: public/geojson/region-vs30-california.json
  schema quake-sim-region-vs30-v1 {origin,res,nx,ny,nodata,data,provenance}
  resampled to 0.025 deg — the same pack resolution as landuse-manning.json.
  Each pack cell takes the mean of VALID (>0) 12x12 source pixels; a cell with
  no valid pixels keeps 0 (= nodata; the app-side sampler falls back to the
  500 m/s default-estimate there and the note counts those stations).

Global mode (2026-09-25 regional-tsunami batch: italy + chile packs):
  python tools/build-region-vs30.py --write --global REGION latS,latN,lonW,lonE
  Source: the assembled global hybrid product itself —
    https://apps.usgs.gov/shakemap_geodata/vs30/global_vs30.grd
    (Worden & Heath global-vs30 repo build output; Heath, D., Wald, D.J.,
    Worden, C.B., Thompson, E.M., Smoczyk, G.M. (2020) "A global hybrid VS30
    map with a topographic slope-based default and regional map insets",
    Earthquake Spectra 36(3), 1570-1584, doi 10.1177/8755293020911137 —
    DOI verified via Crossref; grid 30 arc-sec, lat -56..84, water 0).
  Fetch first: node tools/fetch-region-vs30.js --global
  Resample: same block-mean, UPSCALE=3 (30" -> 0.025 deg = exactly 3).

Usage:
  python tools/build-region-vs30.py            # build + stats (no write)
  python tools/build-region-vs30.py --write    # write the california pack
  python tools/build-region-vs30.py --write --global chile -56.0,-17.5,-76.0,-66.0
"""
import json
import os
import sys

import numpy as np
import h5py

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, '.cache', 'California_Vs30_7p5c.grd')
OUT = os.path.join(ROOT, 'public', 'geojson', 'region-vs30-california.json')

RES = 0.025
UPSCALE = 12  # 0.025 / (7.5 arc-sec = 0.0020833333) = exactly 12

# 30 arc-sec global hybrid product (Heath et al. 2020): UPSCALE = 3
GLOBAL_SRC = os.path.join(ROOT, '.cache', 'global_vs30.grd')
GLOBAL_UPSCALE = 3
GLOBAL_STEP = 0.008333333333333
GLOBAL_PROVENANCE = {
    'label': 'USGS Global Vs30 (Heath et al. 2020, 30" -> 0.025°)',
    'source': 'Heath, D.C., Wald, D.J., Worden, C.B., Thompson, E.M., Smoczyk, G.M. (2020) '
              'A global hybrid VS30 map with a topographic slope-based default and regional '
              'map insets, Earthquake Spectra 36(3), 1570-1584',
    'sourceToken': 'usgs-global-heath2020',
    'doi': '10.1177/8755293020911137',
    'publisher': 'U.S. Geological Survey (global Vs30 product, apps.usgs.gov/shakemap_geodata/vs30/global_vs30.grd)',
    'license': 'USGS public domain; assembly repo CC0 1.0 '
               '(github.com/usgs/earthquake-global_vs30 LICENSE.md)',
    'url': 'https://earthquake.usgs.gov/data/vs30/',
    'nativeResolution': '30 arc-sec (~0.008333 deg), water coded 0; slope-based default '
                        'with regional map insets (Italy incl.)',
    'downsample': 'mean of valid (>0) 3x3 source pixels per 0.025 deg cell; '
                  'no valid pixel -> 0 (nodata, app falls back to the 500 m/s estimate)',
    'note': 'the assembled product paints far-field ocean with a constant fill '
            '(600.0 m/s exact); only exact-fill cells confirmed as water by a '
            'GEBCO 2025 water-mean mask are zeroed to nodata — near-shore '
            'slope-derived product values stay so coastal stations keep real '
            'reads (fill masking verified per-station 2026-09-25)',
    'builder': 'tools/build-region-vs30.py --global',
}

PROVENANCE = {
    'label': 'USGS CA Vs30 (Yong et al. 2014, 7.5" → 0.025°)',
    'source': 'Yong, A., Thompson, E.M., Wald, D.J., Worden, C.B. (2014) '
              'A VS30 Map for California with Geologic and Topographic Constraints, BSSA 104(5)',
    'sourceToken': 'usgs-ca-yong2014',
    'doi': '10.1785/0120130312',
    'publisher': 'U.S. Geological Survey (global-vs30 assembly repo California/California_Vs30_7p5c.grd)',
    'license': 'USGS public domain (data release sciencebase 5a5fa029e4b06e28e9bfc43a)',
    'url': 'https://github.com/usgs/earthquake-global_vs30',
    'nativeResolution': '7.5 arc-sec (~0.002083 deg), water coded 0',
    'downsample': 'mean of valid (>0) 12x12 source pixels per 0.025 deg cell; '
                  'no valid pixel -> 0 (nodata, app falls back to the 500 m/s estimate)',
    'builder': 'tools/build-region-vs30.py',
}


def build():
    with h5py.File(SRC, 'r') as f:
        lat = f['lat'][:]
        lon = f['lon'][:]
        z = f['z'][:, :]
    assert z.dtype == np.float32, z.dtype
    assert lat.shape[0] == z.shape[0] and lon.shape[0] == z.shape[1]
    lat_asc = lat[1] > lat[0]
    lon_asc = lon[1] > lon[0]
    assert lat_asc and lon_asc, (lat[:2], lon[:2])
    lat_step = float(lat[1] - lat[0])
    lon_step = float(lon[1] - lon[0])
    assert abs(lat_step - 0.002083333333040116) < 1e-9, lat_step
    assert abs(lon_step - 0.0020833333330614323) < 1e-9, lon_step

    ny_src, nx_src = z.shape
    ny_blocks = ny_src // UPSCALE
    nx_blocks = nx_src // UPSCALE
    z = z[:ny_blocks * UPSCALE, :nx_blocks * UPSCALE]
    valid = (z > 0) & np.isfinite(z)
    vals = np.where(valid, z, 0.0).astype(np.float64)

    v = vals.reshape(ny_blocks, UPSCALE, nx_blocks, UPSCALE)
    n = valid.reshape(ny_blocks, UPSCALE, nx_blocks, UPSCALE).astype(np.float64)
    s = v.sum(axis=(1, 3))
    c = n.sum(axis=(1, 3))
    mean = np.where(c > 0, s / np.maximum(c, 1), 0.0)
    # one decimal is well below the source's own map precision; halves JSON size
    data = [round(float(x), 1) if c_ > 0 else 0 for x, c_ in zip(mean.ravel(), c.ravel())]

    # pack cell centers match the landuse pack convention: origin + i*res,
    # with the origin at the first (south-west) CENTER
    origin = [round(float(lon[0]), 7), round(float(lat[0]), 7)]
    stats = {
        'cells': len(data),
        'valid': sum(1 for x in data if x > 0),
        'vmin': min(x for x in data if x > 0),
        'vmax': max(data),
        'lat': [origin[1], round(origin[1] + (ny_blocks - 1) * RES, 6)],
        'lng': [origin[0], round(origin[0] + (nx_blocks - 1) * RES, 6)],
    }
    pack = {
        '_schema': 'quake-sim-region-vs30-v1',
        'region': 'california',
        'origin': origin,
        'res': RES,
        'nx': nx_blocks,
        'ny': ny_blocks,
        'nodata': 0,
        'data': data,
        'provenance': PROVENANCE,
    }
    return pack, stats


def build_global(rid, lat_s, lat_n, lon_w, lon_e, mask_path=None):
    """Block-mean the assembled global hybrid grid into one region pack.

    Slice is snapped to UPSCALE boundaries in source-pixel space so output
    cell centers keep the same origin+ i*res convention as the california
    pack (origin = first source pixel coordinate of the first block).

    mask_path: optional GEBCO water-mean elevation grid (tools/
    build-bathymetry-regions.py --one, same bbox/res/origin corner) — cells
    whose mask elevation is < 0 (water) are zeroed to nodata. The assembled
    product paints ocean with a constant fill (600 m/s observed), which would
    otherwise leak the fill into coastal cells (Antofagasta read 600.0).
    """
    u = GLOBAL_UPSCALE
    with h5py.File(GLOBAL_SRC, 'r') as f:
        lat = f['lat'][:]
        lon = f['lon'][:]
        assert lat.shape[0] > 1 and lon.shape[0] > 1
        assert float(lat[1] - lat[0]) > 0 and float(lon[1] - lon[0]) > 0, 'ascending expected'
        step_lat = float(lat[1] - lat[0])
        step_lon = float(lon[1] - lon[0])
        assert abs(step_lat - GLOBAL_STEP) < 1e-9, step_lat
        assert abs(step_lon - GLOBAL_STEP) < 1e-9, step_lon
        j0 = int(np.searchsorted(lat, lat_s, side='right') - 1)
        j1 = int(np.searchsorted(lat, lat_n, side='left'))
        i0 = int(np.searchsorted(lon, lon_w, side='right') - 1)
        i1 = int(np.searchsorted(lon, lon_e, side='left'))
        # clamp BEFORE block-snapping: a request at/below the grid's own edge
        # (chile latS -56 == the product's southern limit) yields index -1 and
        # python's -1 % 3 == 2 would snap it to a negative row window.
        j0 = max(0, j0 - j0 % u)
        i0 = max(0, i0 - i0 % u)
        j1 = min(lat.shape[0], j1 - (j1 - j0) % u)
        i1 = min(lon.shape[0], i1 - (i1 - i0) % u)
        assert j1 > j0 and i1 > i0, (j0, j1, i0, i1)
        z = f['z'][j0:j1, i0:i1]
        origin = [round(float(lon[i0]), 7), round(float(lat[j0]), 7)]

    assert z.dtype == np.float32, z.dtype
    ny_src, nx_src = z.shape
    ny_blocks = ny_src // u
    nx_blocks = nx_src // u
    z = z[:ny_blocks * u, :nx_blocks * u]
    valid = (z > 0) & np.isfinite(z)
    vals = np.where(valid, z, 0.0).astype(np.float64)

    v = vals.reshape(ny_blocks, u, nx_blocks, u)
    n = valid.reshape(ny_blocks, u, nx_blocks, u).astype(np.float64)
    s = v.sum(axis=(1, 3))
    c = n.sum(axis=(1, 3))
    mean = np.where(c > 0, s / np.maximum(c, 1), 0.0)
    data = [round(float(x), 1) if c_ > 0 else 0 for x, c_ in zip(mean.ravel(), c.ravel())]

    if mask_path:
        # Fill-fingerprint masking: the assembled product paints far-field ocean
        # with a CONSTANT fill (600.0 m/s exact — 95% of GEBCO-water cells; the
        # remaining water cells carry legitimate near-shore slope-derived values
        # that coastal stations read). Zeroing every GEBCO-water cell would
        # strip those real coastal values (Venezia 273.9 / Valparaiso 597.7),
        # so zero ONLY exact-fill cells that the mask confirms as water:
        # Antofagasta (600.0 @ -53 m) drops to nodata, Venezia (273.9 @ -5.5 m)
        # keeps its value. FILL_VALUE verified 2026-09-25 on both regions.
        FILL_VALUE = 600.0
        with open(mask_path, 'r', encoding='utf-8') as f:
            mask = json.load(f)
        assert abs(mask['res'] - RES) < 1e-12, mask['res']
        assert abs(mask['origin'][0] - origin[0]) < 1e-6 and abs(mask['origin'][1] - origin[1]) < 1e-6, \
            ('mask origin mismatch', mask['origin'], origin)
        assert mask['nx'] >= nx_blocks and mask['ny'] >= ny_blocks, (mask['nx'], mask['ny'])
        zeroed = 0
        for j in range(ny_blocks):
            row = j * mask['nx']
            for i in range(nx_blocks):
                idx = j * nx_blocks + i
                if data[idx] == FILL_VALUE and mask['data'][row + i] < 0:
                    data[idx] = 0
                    zeroed += 1
        print('mask %s: zeroed %d exact-fill water cells' % (os.path.basename(mask_path), zeroed))
        assert zeroed > 0, 'fill masking matched nothing — FILL_VALUE stale?'

    stats = {
        'cells': len(data),
        'valid': sum(1 for x in data if x > 0),
        'vmin': min(x for x in data if x > 0),
        'vmax': max(data),
        'lat': [origin[1], round(origin[1] + (ny_blocks - 1) * RES, 6)],
        'lng': [origin[0], round(origin[0] + (nx_blocks - 1) * RES, 6)],
    }
    pack = {
        '_schema': 'quake-sim-region-vs30-v1',
        'region': rid,
        'origin': origin,
        'res': RES,
        'nx': nx_blocks,
        'ny': ny_blocks,
        'nodata': 0,
        'data': data,
        'provenance': dict(GLOBAL_PROVENANCE),
    }
    return pack, stats


def main():
    # --global REGION latS,latN,lonW,lonE : build a region pack from the
    # assembled global hybrid product (see module docstring).
    argv = list(sys.argv[1:])
    write = '--write' in argv
    if '--global' in argv:
        gi = argv.index('--global')
        rid, bbox_s = argv[gi + 1], argv[gi + 2]
        lat_s, lat_n, lon_w, lon_e = (float(x) for x in bbox_s.split(','))
        mask_path = None
        if '--mask' in argv:
            mask_path = argv[argv.index('--mask') + 1]
        pack, stats = build_global(rid, lat_s, lat_n, lon_w, lon_e, mask_path)
        print('region %s: cells %d valid %d (%.1f%%) range %.1f-%.1f m/s' % (
            rid, stats['cells'], stats['valid'], 100.0 * stats['valid'] / stats['cells'],
            stats['vmin'], stats['vmax']))
        print('lat %s lng %s res %s' % (stats['lat'], stats['lng'], RES))
        if write:
            out = os.path.join(ROOT, 'public', 'geojson', 'region-vs30-%s.json' % rid)
            with open(out, 'w', encoding='utf-8') as f:
                json.dump(pack, f, separators=(',', ':'), ensure_ascii=False)
            print('wrote %s (%.1f KB)' % (out, os.path.getsize(out) / 1024.0))
        else:
            print('(dry run — pass --write to emit the pack)')
        return
    pack, stats = build()
    print('cells %d valid %d (%.1f%%) range %.1f-%.1f m/s' % (
        stats['cells'], stats['valid'], 100.0 * stats['valid'] / stats['cells'],
        stats['vmin'], stats['vmax']))
    print('lat %s lng %s res %s' % (stats['lat'], stats['lng'], RES))
    if '--write' in sys.argv:
        with open(OUT, 'w', encoding='utf-8') as f:
            json.dump(pack, f, separators=(',', ':'), ensure_ascii=False)
        print('wrote %s (%.1f KB)' % (OUT, os.path.getsize(OUT) / 1024.0))
    else:
        print('(dry run — pass --write to emit the pack)')


if __name__ == '__main__':
    main()
