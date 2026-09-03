'use strict';
// static-pages-i18n.test.js — every data-i18n / data-i18n-aria key referenced
// by the standalone full-window pages (report.html, guide.html) must exist in
// all three i18n dictionaries. These pages render without app.js, so a typo'd
// key would ship raw key text to users — this gate catches it in CI.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('path');

const PAGES = ['report.html', 'guide.html'];
const stub = { getItem: () => null, setItem: () => {} };
const dom = { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} };
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8');
const I18N = new Function('localStorage', 'document', 'window', src + '; return I18N;')(stub, dom, {});

test('standalone pages reference only existing i18n keys in all three languages', () => {
  assert.ok(I18N.zh && I18N.ja && I18N.en, 'dictionaries parsed');
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
    const keys = new Set();
    for (const m of html.matchAll(/data-i18n(?:-aria|-ph|-title)?="([^"]+)"/g)) keys.add(m[1]);
    assert.ok(keys.size > 10, page + ' should reference a real key set');
    for (const k of keys) {
      for (const lang of ['zh', 'ja', 'en']) {
        assert.ok(I18N[lang][k] != null, page + ' key missing in ' + lang + ': ' + k);
      }
    }
    console.log(page + ': ' + keys.size + ' keys covered x3');
  }
});

test('guide legend swatches match the renderer shindo palette anchors', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'guide.html'), 'utf8');
  // the palette in guide.html must carry the same anchors the renderer uses
  for (const anchor of ["'7': '#7c0a02'", "'6+': '#d00000'", "'5-': '#f5a623'", "'0': '#7c7c7c'"]) {
    assert.ok(html.includes(anchor), 'palette anchor missing: ' + anchor);
  }
  // tsunami grade bars mirror rt-tsunami GRADE_COLORS
  for (const c of ['#8b0000', '#e74c3c', '#f1c40f']) {
    assert.ok(html.includes(c), 'tsunami grade color missing: ' + c);
  }
});
