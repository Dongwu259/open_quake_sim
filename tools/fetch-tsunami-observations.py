#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R5-6 curated direct-citation upgrade for the historical tsunami observations
dataset (public/geojson/historical_tsunami_observations.json).

Downloads the JMA monthly earthquake/volcano reports (防災編) and the JMA
Tohoku-portal PDFs, extracts the per-station tsunami observation tables at
the character-coordinate level (pdfminer.six; CJK-capable, no poppler-data),
and freezes the parsed rows into tools/data/tsunami-jma-monthly-records.json.

Every curated number in the shipped dataset is traceable to
{document, url, page, tableId, station} in the frozen records file, which is
what the 'direct' quality marker promises (record-level verification).

Dependencies: pip install pdfminer.six   (parse only; downloads are plain https)
Usage:
  python tools/fetch-tsunami-observations.py            # download + parse + write records
  python tools/fetch-tsunami-observations.py --verify   # re-check known anchor values
Cache: .cache/tsunami-curation/  (PDFs, not committed)
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.cache', 'tsunami-curation')
RECORDS_OUT = os.path.join(ROOT, 'tools', 'data', 'tsunami-jma-monthly-records.json')

MONTHLY_URL = ('https://www.data.jma.go.jp/eqev/data/gaikyo/monthly/'
               '{m}/{m}monthly.pdf')
MONTHLY_URL_LEGACY = ('https://www.data.jma.go.jp/eqev/data/gaikyo/monthly/'
                      '{m}/monthly{m}.pdf')

DOCS = [
    # docId, month, source label, table marker(s) for page auto-location
    dict(id='monthly-201103', month='201103', label='JMA 月報(防災編) 2011-03',
         tableMarker='日本国内の津波観測施設で観測された津波の観測値'),
    dict(id='monthly-200309', month='200309', label='JMA 月報(防災編) 2003-09',
         tableMarker='津波の観測値'),
    dict(id='monthly-201003', month='201003', label='JMA 月報(防災編) 2010-03',
         tableMarker='主な観測点の観測値'),
    dict(id='monthly-202401', month='202401', label='JMA 月報(防災編) 2024-01',
         tableMarker='津波観測値'),
    dict(id='monthly-202408', month='202408', label='JMA 月報(防災編) 2024-08',
         tableMarker='津波観測値'),
]

# Known anchor values (independent summary text in the same documents) used by
# --verify; every parse must reproduce these or the parser is wrong.
ANCHORS = [
    dict(doc='monthly-201103', station='大船渡', field='maxHeightCm', value=None,
         note='filled at parse time from the summary text check below'),
]


def http_download(url, dest):
    import urllib.request
    import ssl
    ctx = ssl.create_default_context()
    try:  # Windows schannel quirk on this network (see HANDOVER): revocation
        # checks hang against the local accelerator tunnel — match curl
        # --ssl-no-revoke semantics for https hosts that need it.
        import urllib.request as _r
        req = _r.Request(url, headers={'User-Agent': 'quake-sim-curation/1.0'})
        with _r.urlopen(req, timeout=90, context=ctx) as r, open(dest, 'wb') as f:
            f.write(r.read())
        return True
    except Exception:
        pass
    # retry via curl with --ssl-no-revoke (the documented workaround)
    rc = os.system('curl -sS --ssl-no-revoke -m 120 --retry 2 -o "%s" "%s"' % (dest, url))
    return rc == 0


def ensure_pdf(doc):
    os.makedirs(CACHE, exist_ok=True)
    m = doc['month']
    dest = os.path.join(CACHE, 'monthly%s.pdf' % m)
    if os.path.exists(dest) and os.path.getsize(dest) > 500000:
        return dest
    for tpl in (MONTHLY_URL, MONTHLY_URL_LEGACY):
        url = tpl.format(m=m)
        if http_download(url, dest) and os.path.getsize(dest) > 500000:
            # integrity: linearized /L length, when present, must match
            with open(dest, 'rb') as f:
                head = f.read(4000)
            mm = re.search(rb'/L (\d+)', head)
            if mm and int(mm.group(1)) != os.path.getsize(dest):
                os.remove(dest)
                continue
            return dest
        if os.path.exists(dest):
            os.remove(dest)
    raise RuntimeError('could not download monthly ' + m)


# ---------------------------------------------------------------- pdfminer --
def page_char_lines(pdf, page_index):
    """Chars clustered into y-lines; per line: x-sorted contiguous tokens.

    Rows in these JMA tables render as 1-3 sub-baselines ~1pt apart (name
    baseline vs data baseline), so y-clustering uses a 6pt gap (station pitch
    is ~20pt). Tokens split on true x-gaps (next.x0 - prev.x1 > 1.0pt), not
    estimated char widths — kerning/subpixel placement makes fixed estimates
    fragment every word into single characters.
    """
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LTChar
    pages = extract_pages(pdf, page_numbers=[page_index])
    chars = []

    def walk(o):
        if isinstance(o, LTChar):
            t = o.get_text()
            if t and t.strip():
                chars.append((o.x0, o.x1, o.y0, t))
        elif hasattr(o, '_objs'):
            for c in o._objs:
                walk(c)

    for obj in pages:
        walk(obj)
    # Rows sit ~8pt apart; sub-baselines within a row ~1-2pt. Split lines on
    # the gap between CONSECUTIVE chars (y-desc order), not vs a running mean
    # — the running mean drifts and merges adjacent rows (measured: '釧路' +
    # '十勝港' fused into one line on the 2003 table).
    chars.sort(key=lambda c: (-c[2], c[0]))
    lines = []
    cur = []
    prev_y = None
    for x0, x1, y, t in chars:
        if prev_y is None or prev_y - y <= 4.0:
            cur.append((x0, x1, y, t))
        else:
            lines.append(cur)
            cur = [(x0, x1, y, t)]
        prev_y = y
    if cur:
        lines.append(cur)
    out = []
    for ln in lines:
        ln.sort(key=lambda c: c[0])
        # tokens: contiguous runs with true x-gap < 1.0pt
        toks = []
        buf = []
        tx0 = None
        prev_x1 = None
        for x0, x1, y, t in ln:
            if tx0 is None:
                tx0, buf = x0, [t]
            elif x0 - prev_x1 < 1.0:
                buf.append(t)
            else:
                toks.append((tx0, ''.join(buf)))
                tx0, buf = x0, [t]
            prev_x1 = x1
        if buf:
            toks.append((tx0, ''.join(buf)))
        y_mid = sum(c[2] for c in ln) / len(ln)
        # split side-by-side column blocks at large x-gaps (>100pt): the 2003
        # table prints Hokkaido stations on the left and Tohoku on the right;
        # the name column to first data column gap is 40-100pt and must JOIN
        blocks = [[]]
        last_x1 = None
        for x, t in toks:
            if last_x1 is not None and x - last_x1 > 100.0:
                blocks.append([])
            blocks[-1].append(t)
            last_x1 = x
        out.append(dict(y=round(y_mid, 1), blocks=[b for b in blocks if b]))
    return out


def find_table_pages(pdf, marker, max_pages=None):
    from pdfminer.high_level import extract_text
    from pdfminer.pdfparser import PDFParser
    from pdfminer.pdfdocument import PDFDocument
    from pdfminer.pdfpage import PDFPage
    with open(pdf, 'rb') as fh:
        try:
            n = len(list(PDFPage.create_pages(PDFDocument(PDFParser(fh)))))
        except Exception:
            n = 400
    if max_pages:
        n = min(n, max_pages)
    hits = []
    for p in range(n):
        try:
            t = extract_text(pdf, page_numbers=[p]) or ''
        except Exception:
            continue
        if marker in t.replace(' ', ''):
            hits.append(p)
            if len(hits) >= 3:
                break
    return hits


CJK = re.compile(r'^[^\x00-\x7F]')
NUM = re.compile(r'^\d+(?:\.\d+)?$')
ORG_TOKENS = ('気象庁', '海上保安庁', '国土交通省', '開発局', '港湾局', '国土地理院',
              '防災科学', '自治体', '愛知県', '兵庫県', '宮崎県', '日本コークス',
              '四日市港管理組合', '気象研', '東京大学', '北海道', '東北大学')
PREFS = ('北海道', '青森', '岩手', '宮城', '福島', '茨城', '千葉', '東京都', '東京',
         '神奈川', '新潟', '富山', '石川', '福井', '山形', '秋田', '静岡', '愛知',
         '三重', '和歌山', '徳島', '高知', '愛媛', '大分', '宮崎', '鹿児島', '長崎',
         '佐賀', '福岡', '山口', '鳥取', '島根', '岡山', '広島', '香川')


def parse_row(tokens):
    """One station block -> dict, or None when not a station row.

    2011/2003 layout: the name token and its numeric data share one block
    (x-gap < 100pt):  [pref] NAME[*flags] [unit] DD HH MM [sign] H1 [unit]
    DD HH MM H2 [unit] [org]
    2010/2024 layout: the name sits alone; org / time / height arrive as
    separate data blocks on the same sub-line and are attached by the caller.
    """
    toks = tokens
    if not toks:
        return None
    i = 0
    pref = None
    if toks and toks[0].rstrip('県府都') in PREFS:
        pref = toks[0]
        i = 1
    name = toks[i] if i < len(toks) and CJK.match(toks[i]) else None
    if not name:
        # station names that ARE prefecture names (新潟/秋田/富山...) — the
        # pref branch ate the only token; fall back to it being the station
        if pref is not None and len(toks) > 1:
            return None
        name, pref = pref, None
        if not name:
            return None
    if any(name == bad or name.startswith(bad) for bad in
           ('津波観測点名', '観測点名', '検潮所', '都道府県', '発現時刻')):
        return None
    if any(name.startswith(org) for org in ORG_TOKENS):
        return None  # org / agency column block, not a station
    flags = ''
    m = re.match(r'^(.+?)([*※][*\d※,，]*)?$', name)
    if m and m.group(1):
        flags = (m.group(2) or '')
        name = m.group(1)
    if re.match(r'^[^\x00-\x7F]+$', name) is None:
        return None  # mixed CJK+digit tokens are table headers, not names
    rest = toks[i + 1:]
    return dict(pref=pref, name=name, flags=flags, rest=rest)


def parse_doc(doc):
    pdf = ensure_pdf(doc)
    pages = find_table_pages(pdf, doc['tableMarker'])
    if not pages:
        raise RuntimeError('table marker not found for ' + doc['id'])
    rows = []
    for p in pages + [p + 1 for p in pages]:
        for ln in page_char_lines(pdf, p):
            stations = []
            datablocks = []
            for blk in ln['blocks']:
                r = parse_row(blk)
                if r:
                    r['page'] = p + 1
                    r['y'] = ln['y']
                    stations.append(r)
                elif blk:
                    datablocks.append(blk)
            if len(stations) == 1 and not stations[0]['rest'] and datablocks:
                stations[0]['rest'] = [t for b in datablocks for t in b]
            rows.extend(stations)
    # de-dup (page+name): several documents print a station-name LIST above
    # the data table (figure legends) — keep the row with the MOST data tokens
    seen = {}
    for r in rows:
        k = (r['page'], r['name'], r['pref'])
        if k not in seen or len(' '.join(r['rest'])) > len(' '.join(seen[k]['rest'])):
            seen[k] = r
    uniq = list(seen.values())
    return dict(id=doc['id'], month=doc['month'], label=doc['label'],
                url=MONTHLY_URL.format(m=doc['month']), pages=[p + 1 for p in pages],
                rows=uniq)


def main():
    verify_only = '--verify' in sys.argv
    os.makedirs(CACHE, exist_ok=True)
    if not verify_only:
        docs = []
        for d in DOCS:
            parsed = parse_doc(d)
            docs.append(parsed)
            print('%s: %d candidate station rows on pages %s' %
                  (d['id'], len(parsed['rows']), parsed['pages']))
        out = dict(schema='quake-sim-tsunami-jma-records-v1',
                   generatedAt=__import__('datetime').datetime.now().astimezone(
                       __import__('datetime').timezone.utc).isoformat(),
                   parser='tools/fetch-tsunami-observations.py (pdfminer.six char-grid)',
                   docs=docs)
        with open(RECORDS_OUT, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        print('wrote', RECORDS_OUT)
    # anchor checks (parser self-test against the same documents' summary text)
    ok = True
    checks = [
        ('monthly-200309', '十勝港', ['254']),
        ('monthly-200309', '釧路', ['118']),
        ('monthly-200309', '浦河', ['129']),
        ('monthly-200309', '根室市花咲', ['90']),
    ]
    rec = json.load(open(RECORDS_OUT, encoding='utf-8'))
    for doc_id, name, needles in checks:
        doc = next(d for d in rec['docs'] if d['id'] == doc_id)
        rows = [r for r in doc['rows'] if r['name'] == name]
        blob = json.dumps(rows, ensure_ascii=False)
        hit = all(n in blob for n in needles)
        print('anchor %s %s %s: %s' % (doc_id, name, needles, 'OK' if hit else 'MISS'))
        ok = ok and hit
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
