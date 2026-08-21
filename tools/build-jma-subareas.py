#!/usr/bin/env python3
"""
Build public/geojson/jma_subareas.json from the JMA "地震情報／細分区域" GIS
shapefile (https://www.data.jma.go.jp/developer/gis.html).

Steps: unzip -> inspect DBF fields -> mapshaper simplify -> slim properties.
Usage:
  python tools/build-jma-subareas.py /tmp/jma_subareas.zip [--inspect-only]
Build deps (mapshaper) are installed into .browser-test/build-deps (gitignored).
"""
import io
import json
import os
import subprocess
import sys
import zipfile

sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, '.browser-test', 'jma_gis')
DEPS = os.path.join(ROOT, '.browser-test', 'build-deps')
OUT = os.path.join(ROOT, 'public', 'geojson', 'jma_subareas.json')
MAPSHAPER = os.path.join(DEPS, 'node_modules', 'mapshaper', 'bin', 'mapshaper')


def main():
    zip_path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/jma_subareas.zip'
    inspect_only = '--inspect-only' in sys.argv

    os.makedirs(WORK, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(WORK)
    shp = None
    for root, _dirs, files in os.walk(WORK):
        for f in files:
            if f.lower().endswith('.shp'):
                shp = os.path.join(root, f)
                break
    assert shp, 'no .shp in the zip'
    # The JMA filename is Japanese — subprocess argv on Windows mangles it, so
    # rename the whole shapefile set (shp/shx/dbf/...) to ASCII first
    base = os.path.splitext(shp)[0]
    asciibase = os.path.join(os.path.dirname(shp), 'subareas')
    for f in os.listdir(os.path.dirname(shp)):
        if f.startswith(os.path.basename(base) + '.'):
            ext = os.path.splitext(f)[1]
            os.replace(os.path.join(os.path.dirname(shp), f), asciibase + ext)
    shp = asciibase + '.shp'
    print('shapefile:', shp)

    import shapefile  # pyshp
    r = shapefile.Reader(shp, encoding='utf-8', encodingErrors='replace')
    fields = [f[0] for f in r.fields[1:]]
    print('fields:', fields)
    print('records:', len(r))
    for sr in r.iterShapeRecords():
        print('sample record:', sr.record.as_dict())
        break

    if inspect_only:
        return

    # pick the name/code fields (JMA 細分区域 DBF)
    name_field = None
    code_field = None
    for f in fields:
        lf = f.lower()
        if name_field is None and ('name' in lf or '名称' in f):
            name_field = f
        if code_field is None and 'code' in lf:
            code_field = f
    assert name_field, 'no name-like field in ' + repr(fields)
    print('name field:', name_field, '| code field:', code_field)

    # simplify via mapshaper (installs into the gitignored build-deps dir)
    if not os.path.exists(MAPSHAPER):
        print('installing mapshaper into .browser-test/build-deps ...')
        subprocess.check_call(['npm', 'install', '--no-save', '--prefix', DEPS, 'mapshaper'],
                              shell=(os.name == 'nt'))
    simplified = os.path.join(WORK, 'simplified.json')
    subprocess.check_call([
        'node', MAPSHAPER, shp,
        '-simplify', 'weighted', '2%', 'keep-shapes',
        '-o', 'format=geojson', 'precision=0.001', simplified
    ], shell=(os.name == 'nt'))

    with io.open(simplified, encoding='utf-8') as f:
        geo = json.load(f)
    feats = geo.get('features') or []

    # Tiny islet polygons collapse to null under 0.001° precision — synthesize
    # a ~400 m diamond from the SOURCE shapefile bbox so every named area
    # stays visible and fillable (e.g. 津倉瀬(宇治群島北東方）)
    null_names = set()
    for ft in feats:
        props = ft.get('properties') or {}
        g = ft.get('geometry')
        if not g or not g.get('coordinates'):
            nm = (props.get(name_field) or '').strip()
            if nm:
                null_names.add(nm)
    fixups = {}
    if null_names:
        r2 = shapefile.Reader(shp, encoding='utf-8')
        for sr in r2.iterShapeRecords():
            nm = (sr.record.as_dict().get(name_field) or '').strip()
            if nm in null_names and sr.shape.points:
                bb = sr.shape.bbox
                cx = (bb.xmin + bb.xmax) / 2
                cy = (bb.ymin + bb.ymax) / 2
                r_deg = 0.002  # ~200 m half-diagonal
                fixups[nm] = {
                    'type': 'Polygon',
                    'coordinates': [[
                        [cx, cy + r_deg], [cx + r_deg, cy], [cx, cy - r_deg],
                        [cx - r_deg, cy], [cx, cy + r_deg]
                    ]]
                }
        print('null-geometry fixups:', sorted(fixups.keys()))

    slim = []
    names = []
    for ft in feats:
        props = ft.get('properties') or {}
        name = (props.get(name_field) or '').strip()
        if not name:
            continue
        p = {'name': name}
        if code_field and props.get(code_field) is not None:
            p['code'] = str(props.get(code_field))
        geom = ft.get('geometry')
        if (not geom or not geom.get('coordinates')) and name in fixups:
            geom = fixups[name]
        if not geom:
            continue
        slim.append({'type': 'Feature', 'properties': p, 'geometry': geom})
        names.append(name)
    out = {
        'type': 'FeatureCollection',
        'source': 'JMA 地震情報／細分区域 GIS data (2024-05-20 revision, simplified 2%)',
        'features': slim
    }
    with io.open(OUT, 'w', encoding='utf-8', newline='') as f:
        f.write(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    kb = os.path.getsize(OUT) / 1024
    print('features:', len(slim), '| size: %.0f KB' % kb)
    print('names:')
    for n in sorted(names):
        print(' ', n)


if __name__ == '__main__':
    main()
