"""UCERF3-TD staging: parse UCERF3_OpenIntervals_ver11.xls -> .cache/ucerf3-td-staging.json.

Called by tools/build-ucerf3-td.js (node stays the build orchestrator; python+xlrd is the
xls reader, per the build-bathymetry-regions.py precedent of python builders).
Columns per OpenSHA LastEventData.java: 0=name 1=parentID 3=offset(m, may be empty)
4=openIntervalYears (basis 2013-01-01) 6..9=start/end lat/lng. Sheets 0/1/2 only.
"""
import json
import sys

import xlrd

XLS = r'.cache/UCERF3_OpenIntervals_ver11.xls'
OUT = r'.cache/ucerf3-td-staging.json'


def main():
    wb = xlrd.open_workbook(XLS)
    sheets = ['Well resolved historical', 'Paleo-well resolved', 'Unique to FM3.2']
    rows = []
    for si, name in enumerate(sheets):
        sh = wb.sheet_by_index(si)
        assert sh.name == name, 'sheet %d name %r != %r' % (si, sh.name, name)
        n = 0
        for r in range(sh.nrows):
            c4 = sh.cell(r, 4)
            if c4.ctype != 2 or not isinstance(c4.value, float):
                continue
            start_lat, start_lng = sh.cell(r, 6).value, sh.cell(r, 7).value
            end_lat, end_lng = sh.cell(r, 8).value, sh.cell(r, 9).value
            if not isinstance(start_lat, float):
                continue  # LastEventData skips rows without numeric location
            offset = sh.cell(r, 3).value
            rows.append({
                'sheet': si,
                'name': str(sh.cell(r, 0).value),
                'parentId': int(sh.cell(r, 1).value),
                'openInterval': c4.value,
                'offsetM': offset if isinstance(offset, float) else None,
                'span': [start_lat, start_lng, end_lat, end_lng],
            })
            n += 1
        print('sheet%d %s: %d rows' % (si, name, n), file=sys.stderr)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({'rows': rows}, f, separators=(',', ':'))
    print('total %d -> %s' % (len(rows), OUT), file=sys.stderr)


if __name__ == '__main__':
    main()
