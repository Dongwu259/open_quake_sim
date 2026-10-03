#!/usr/bin/env python3
"""
Build public/geojson/world-land-10m.json — global land FILL polygons for the
global-mode offline vector basemap.

Source: public/geojson/_land10m/ne_10m_land.shp (Natural Earth 10m land,
public domain, https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/).

Why a new file: the vector basemap (app.js _globalVectorBuild) stroked only
world-coastline-10m.json LineStrings, leaving land transparent. Strokes cannot
be filled — this emits real Polygon/MultiPolygon rings. Quantized to 2 decimals
(~1.1 km), matching world-coastline-10m.json so fill edges step with the
stroke lattice.

Handling notes:
  - 'Null island' (0,0 joke feature) is dropped.
  - ESRI ring orientation (exterior=CW signed-area<0) is used to group holes
    with their exterior (smallest containing exterior, ray-cast), so the output
    is a valid RFC7946-style MultiPolygon usable by other consumers. The app's
    canvas fill uses 'evenodd', which is orientation-agnostic.
  - The source is already cut at the antimeridian (NE convention); we assert
    no consecutive ring points jump |dlng| > 180 so no runtime unwrap is needed.

Usage: python tools/build-world-land.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'public', 'geojson', '_land10m', 'ne_10m_land.shp')
OUT = os.path.join(ROOT, 'public', 'geojson', 'world-land-10m.json')
Q = 2  # decimals, matches world-coastline-10m.json


def signed_area(ring):
    a = 0.0
    for i in range(len(ring) - 1):
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return a / 2.0


def point_in_ring(pt, ring):
    x, y = pt
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def quantize_ring(pts):
    out = []
    for x, y in pts:
        qx, qy = round(x, Q), round(y, Q)
        if not out or out[-1] != [qx, qy]:
            out.append([qx, qy])
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()  # closure re-added below after validity check
    if len(out) < 3:
        return None
    if abs(signed_area(out + [out[0]])) < 1e-10:
        return None
    out.append(out[0])
    return out


def main():
    import shapefile  # pyshp
    r = shapefile.Reader(SRC)
    exteriors = []  # {ring, bbox, holes: []}
    holes = []
    n_skip = 0
    for sr in r.iterShapeRecords():
        rec = sr.record.as_dict()
        if rec.get('featurecla') == 'Null island':
            n_skip += 1
            continue
        s = sr.shape
        parts = list(s.parts) + [len(s.points)]
        for i in range(len(s.parts)):
            ring = quantize_ring(s.points[parts[i]:parts[i + 1]])
            if ring is None:
                continue
            for j in range(1, len(ring)):
                assert abs(ring[j][0] - ring[j - 1][0]) <= 180, \
                    'antimeridian jump in ring — runtime unwrap required, fix builder'
            xs = [p[0] for p in ring]
            ys = [p[1] for p in ring]
            bb = (min(xs), min(ys), max(xs), max(ys))
            if signed_area(ring) < 0:  # ESRI exterior = clockwise
                exteriors.append({'ring': ring, 'bbox': bb, 'holes': []})
            else:
                holes.append({'ring': ring, 'bbox': bb})

    # Attach each hole to the smallest-area exterior containing its first point.
    n_orphan = 0
    for h in holes:
        hx = h['ring'][0]
        best, best_area = None, None
        for ex in exteriors:
            bb = ex['bbox']
            if not (bb[0] <= hx[0] <= bb[2] and bb[1] <= hx[1] <= bb[3]):
                continue
            if not point_in_ring(hx, ex['ring']):
                continue
            area = (bb[2] - bb[0]) * (bb[3] - bb[1])
            if best_area is None or area < best_area:
                best, best_area = ex, area
        if best is None:
            n_orphan += 1  # hole with no containing exterior: render standalone
            exteriors.append({'ring': h['ring'], 'bbox': h['bbox'], 'holes': []})
        else:
            best['holes'].append(h['ring'])

    polys = [[ex['ring']] + ex['holes'] for ex in exteriors]
    n_pts = sum(len(r) for p in polys for r in p)
    doc = {
        'type': 'FeatureCollection',
        'name': 'world-land-10m',
        'provenance': {
            'source': 'Natural Earth 10m land (public domain)',
            'sourceUrl': 'https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/',
            'builder': 'tools/build-world-land.py',
            'quantization': '%d decimals (~1.1 km), matches world-coastline-10m.json' % Q,
            'built': '2026-09-26',
        },
        'features': [{
            'type': 'Feature',
            'properties': {},
            'geometry': {'type': 'MultiPolygon', 'coordinates': polys},
        }],
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(doc, f, separators=(',', ':'))
    size_mb = os.path.getsize(OUT) / 1e6
    print('features(polygons): %d, holes: %d (orphan %d), null-island dropped: %d'
          % (len(polys), len(holes), n_orphan, n_skip))
    print('rings total: %d, points: %d -> %s (%.2f MB)'
          % (sum(len(p) for p in polys), n_pts, OUT, size_mb))


if __name__ == '__main__':
    main()
