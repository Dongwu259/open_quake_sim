'use strict';
// psv-alias-ladder.test.js — tripwire for the P-SV-side Bessel-aliasing
// guard divisor ladder (tools/data/psv-alias-ladder.json, 2026-09-11).
// Locks: div 10 passes the SH-family gate on alias-clean configs (the
// shipped default stays byte-compatible with the frozen series chain);
// the ladder residual ordering must not regress.
const assert = require('assert');
const test = require('node:test');
const r = require('../tools/data/psv-alias-ladder.json');

test('psv-alias-ladder — schema + verdict frozen', () => {
  assert.equal(r.schema, 'quake-sim-psv-alias-ladder-v1');
  assert.equal(r.verdict, 'psv_guard_div10_passes_shipped_default_kept_byte_compat_landed_knob');
  assert.ok(r.reading.includes('mass concentrates at low k'), 'the low-k-mass reading must be on record');
  assert.ok(Array.isArray(r.points) && r.points.length >= 24, 'ladder points missing');
});

test('psv-alias-ladder — div 10 passes the family gate, ladder ordering monotone', () => {
  const L = r.divisorLadder;
  assert.ok(L[10].max <= 0.10, 'div 10 must pass the SH-family gate (max ' + L[10].max + ') — re-freeze if the kernel changed');
  assert.ok(L[40].max < L[10].max && L[80].max < L[40].max,
    'divisor ladder must be monotone improving (' + L[10].max + ' -> ' + L[40].max + ' -> ' + L[80].max + ')');
  assert.ok(L[80].max < 0.001, 'div 80 margin must stay on record');
});
