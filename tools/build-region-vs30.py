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

Usage:
  python tools/build-region-vs30.py            # build + stats (no write)
  python tools/build-region-vs30.py --write    # write the pack JSON
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


def main():
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
