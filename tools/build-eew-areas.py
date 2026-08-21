#!/usr/bin/env python3
"""
Build public/geojson/jma_eew_areas.json — polygons for the 188 areas JMA calls
「緊急地震速報や震度情報で用いる区域名」. These are the names the Wolfx jma_eew
feed puts into WarnArea[].Chiiki (e.g. 宮城県北部, 和歌山県南部, 東京都２３区).

DATA-SOURCE NOTE (read before rerunning):
  JMA's 「緊急地震速報／府県予報区」 GIS
  (https://www.data.jma.go.jp/developer/gis/20190125_AreaForecastLocalEEW_GIS.zip)
  contains only the 56 COARSE 府県予報区 (北海道道央, 青森, 宮城, 東京,
  伊豆諸島, 小笠原, ...) — NOT the 188 fine areas the Wolfx Chiiki strings use.
  JMA publishes the fine-area polygons as 「地震情報／細分区域」 GIS
  (AreaForecastLocalE, 2024-05-20 revision): 194 records = the 188 EEW area
  names + 6 extra islet / Northern-Territory polygons (国後島, 択捉島, 色丹島,
  津倉瀬(宇治群島北東方）, 鷹島(甑島南方), うるま市・金武町境界部地先の埋立地).
  So this script runs the same pipeline as tools/build-jma-subareas.py on the
  細分区域 shapefile and then filters to the official 188-name EEW list
  (https://www.jma.go.jp/jma/kishou/know/jishin/joho/shindo-name.html).

Steps: unzip -> inspect DBF fields (UTF-8, NOT Shift_JIS) -> mapshaper simplify
-> null-geometry fixups -> filter to EEW188 -> slim properties (name + code).

Usage:
  python tools/build-eew-areas.py tools/data/20240520_AreaForecastLocalE_GIS.zip
  python tools/build-eew-areas.py .browser-test/jma_gis/subareas.shp  # reuse an extracted shapefile
  python tools/build-eew-areas.py <zip-or-shp> --inspect-only
Build deps (mapshaper) live in .browser-test/build-deps (gitignored).
"""
import io
import json
import os
import subprocess
import sys
import zipfile

sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, '.browser-test', 'eew_areas_gis')
DEPS = os.path.join(ROOT, '.browser-test', 'build-deps')
OUT = os.path.join(ROOT, 'public', 'geojson', 'jma_eew_areas.json')
MAPSHAPER = os.path.join(DEPS, 'node_modules', 'mapshaper', 'bin', 'mapshaper')

# Official JMA 「緊急地震速報や震度情報で用いる区域名」 list (188 areas).
EEW188 = frozenset("""
石狩地方北部 石狩地方中部 石狩地方南部 後志地方北部 後志地方東部 後志地方西部
空知地方北部 空知地方中部 空知地方南部
渡島地方北部 渡島地方東部 渡島地方西部 檜山地方 北海道奥尻島
胆振地方西部 胆振地方中東部 日高地方西部 日高地方中部 日高地方東部
上川地方北部 上川地方中部 上川地方南部 留萌地方中北部 留萌地方南部
宗谷地方北部 宗谷地方南部 北海道利尻礼文
網走地方 北見地方 紋別地方 十勝地方北部 十勝地方中部 十勝地方南部
釧路地方北部 釧路地方中南部 根室地方北部 根室地方中部 根室地方南部
青森県津軽北部 青森県津軽南部 青森県三八上北 青森県下北
岩手県沿岸北部 岩手県沿岸南部 岩手県内陸北部 岩手県内陸南部
宮城県北部 宮城県中部 宮城県南部
秋田県沿岸北部 秋田県沿岸南部 秋田県内陸北部 秋田県内陸南部
山形県庄内 山形県最上 山形県村山 山形県置賜
福島県中通り 福島県浜通り 福島県会津
茨城県北部 茨城県南部 栃木県北部 栃木県南部 群馬県北部 群馬県南部
埼玉県北部 埼玉県南部 埼玉県秩父
千葉県北東部 千葉県北西部 千葉県南部
東京都２３区 東京都多摩東部 東京都多摩西部 伊豆大島 新島 神津島 三宅島 八丈島 小笠原
神奈川県東部 神奈川県西部
新潟県上越 新潟県中越 新潟県下越 新潟県佐渡 富山県東部 富山県西部
石川県能登 石川県加賀 福井県嶺北 福井県嶺南
山梨県東部・富士五湖 山梨県中・西部
長野県北部 長野県中部 長野県南部
岐阜県飛騨 岐阜県美濃東部 岐阜県美濃中西部
静岡県伊豆 静岡県東部 静岡県中部 静岡県西部
愛知県東部 愛知県西部
三重県北部 三重県中部 三重県南部 滋賀県北部 滋賀県南部
京都府北部 京都府南部 大阪府北部 大阪府南部
兵庫県北部 兵庫県南東部 兵庫県南西部 兵庫県淡路島 奈良県 和歌山県北部 和歌山県南部
鳥取県東部 鳥取県中部 鳥取県西部 島根県東部 島根県西部 島根県隠岐
岡山県北部 岡山県南部 広島県北部 広島県南東部 広島県南西部
山口県北部 山口県東部 山口県中部 山口県西部
徳島県北部 徳島県南部 香川県東部 香川県西部
愛媛県東予 愛媛県中予 愛媛県南予 高知県東部 高知県中部 高知県西部
福岡県福岡 福岡県北九州 福岡県筑豊 福岡県筑後 佐賀県北部 佐賀県南部
長崎県北部 長崎県南西部 長崎県島原半島 長崎県対馬 長崎県壱岐 長崎県五島
熊本県阿蘇 熊本県熊本 熊本県球磨 熊本県天草・芦北
大分県北部 大分県中部 大分県南部 大分県西部
宮崎県北部平野部 宮崎県北部山沿い 宮崎県南部平野部 宮崎県南部山沿い
鹿児島県薩摩 鹿児島県大隅 鹿児島県十島村 鹿児島県甑島 鹿児島県種子島 鹿児島県屋久島
鹿児島県奄美北部 鹿児島県奄美南部
沖縄県本島北部 沖縄県本島中南部 沖縄県久米島 沖縄県大東島
沖縄県宮古島 沖縄県石垣島 沖縄県与那国島 沖縄県西表島
""".split())
assert len(EEW188) == 188, len(EEW188)

# Wolfx EEW WarnArea Chiiki strings that must match a `name` exactly
MUST_MATCH = [
    '和歌山県南部', '三重県南部', '奈良県', '大阪府南部',
    '徳島県北部', '香川県東部', '宮城県北部', '石川県能登',
]
# Names to look up verbatim in the output (exact spelling check)
PROBE_NAMES = ['東京都２３区', '東京都23区', '伊豆諸島', '小笠原諸島']


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else 'tools/data/20240520_AreaForecastLocalE_GIS.zip'
    inspect_only = '--inspect-only' in sys.argv

    if src.lower().endswith('.shp'):
        # reuse an already-extracted (ASCII-named) shapefile set
        shp = src
    else:
        os.makedirs(WORK, exist_ok=True)
        with zipfile.ZipFile(src) as z:
            z.extractall(WORK)
        shp = None
        for root, _dirs, files in os.walk(WORK):
            for f in files:
                if f.lower().endswith('.shp'):
                    shp = os.path.join(root, f)
                    break
        assert shp, 'no .shp in the zip'
        # The JMA filename is Japanese — subprocess argv on Windows mangles it,
        # so rename the whole shapefile set (shp/shx/dbf/...) to ASCII first
        base = os.path.splitext(shp)[0]
        asciibase = os.path.join(os.path.dirname(shp), 'eew_areas')
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

    # simplify via mapshaper (pre-installed in .browser-test/build-deps)
    if not os.path.exists(MAPSHAPER):
        print('installing mapshaper into .browser-test/build-deps ...')
        subprocess.check_call(['npm', 'install', '--no-save', '--prefix', DEPS, 'mapshaper'],
                              shell=(os.name == 'nt'))
    os.makedirs(WORK, exist_ok=True)
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
    # stays visible and fillable
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
    dropped = []
    for ft in feats:
        props = ft.get('properties') or {}
        name = (props.get(name_field) or '').strip()
        if not name:
            continue
        if name not in EEW188:
            dropped.append(name)
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
    print('dropped (not EEW areas):', sorted(dropped))

    names = [f['properties']['name'] for f in slim]
    nameset = set(names)
    missing = sorted(EEW188 - nameset)
    assert not missing, 'EEW area names missing from output: ' + repr(missing)
    assert len(names) == len(nameset), 'duplicate names: ' + repr(
        sorted(n for n in nameset if names.count(n) > 1))

    out = {
        'type': 'FeatureCollection',
        'source': 'JMA 緊急地震速報／府県予報区区域名 (188 areas; polygons from the JMA '
                  '地震情報／細分区域 GIS, 2024-05-20 revision, simplified 2%)',
        'features': slim
    }
    with io.open(OUT, 'w', encoding='utf-8', newline='') as f:
        f.write(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    kb = os.path.getsize(OUT) / 1024
    print('features:', len(slim), '| size: %.0f KB' % kb)

    # name-join verification against real Wolfx EEW WarnArea Chiiki strings
    unmatched = [n for n in MUST_MATCH if n not in nameset]
    print('must-match check:', 'ALL OK' if not unmatched else 'MISSING: ' + repr(unmatched))
    for probe in PROBE_NAMES:
        print('probe %-14s: %s' % (probe, 'present' if probe in nameset else 'absent'))
    izu = sorted(n for n in nameset if n in ('伊豆大島', '新島', '神津島', '三宅島', '八丈島', '小笠原'))
    print('izu/ogasawara names present:', izu)
    print('names:')
    for n in sorted(names):
        print(' ', n)


if __name__ == '__main__':
    main()
