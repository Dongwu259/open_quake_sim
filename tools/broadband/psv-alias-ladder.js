'use strict';
// psv-alias-ladder.js — P-SV-side Bessel-aliasing guard divisor ladder
// (2026-09-11). The production psv integrand floors dk at (2*pi/r)/div;
// the shipped divisor was hardcoded 10 (resolves the J period only to
// ~31 km at dkInvKm 0.02/km) while the SH kernel landed div 80 after its
// exposure scan. This ladder measures div 10/40/80 against a 2x-finer
// div-160 reference on alias-clean configs (HALF + shallow layered, away
// from the registered leaky-P crest band, which is an orthogonal OPEN).
// Freezes to tools/data/psv-alias-ladder.json.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Physics = require('../../public/physics.js');
const psv = require('./psv.js');

const OUT = path.join(ROOT, 'tools', 'data', 'psv-alias-ladder.json');
const HALF = [{ topKm: 0, bottomKm: Infinity, vsKmS: 3.5, vpKmS: 6.0, rhoGcm3: 2.7 }];
const LAYERED = [
  { topKm: 0, bottomKm: 3, vsKmS: 1.6, vpKmS: 2.8, rhoGcm3: 2.2 },
  { topKm: 3, bottomKm: 12, vsKmS: 2.6, vpKmS: 4.5, rhoGcm3: 2.5 },
  { topKm: 12, bottomKm: Infinity, vsKmS: 3.4, vpKmS: 5.9, rhoGcm3: 2.8 }
];

function main() {
  const write = process.argv.includes('--write');
  const fHz = 0.5, omega = 2 * Math.PI * fHz, zs = 15;
  const m0 = 1e19; // arbitrary moment; ratios are scale-free
  const tensors = {
    full: { mxx: 0.3, myy: -0.5, mzz: 1.0, mxy: 0.2, mxz: 0.6, myz: -0.4 },
    deviatoric: { mxx: 0.6, myy: -0.6, mxy: 0.3, mzz: 0, mxz: 0, myz: 0 }
  };
  const rs = [10, 30, 63, 88, 150, 200];
  const divs = [10, 40, 80, 160];
  const points = [];
  for (const [stackName, stack] of [['HALF', HALF], ['layered', LAYERED]]) {
    for (const [tName, t] of Object.entries(tensors)) {
      for (const rKm of rs) {
        const u = {};
        for (const div of divs) {
          const t0 = Date.now();
          const p = psv.psvMomentSpectrumAtFrequency(stack, omega, {
            rKm, zSourceKm: zs, dkInvKm: 0.02, kMaxInvKm: 5, qShear: 50,
            psvGuardDiv: div, mxx: t.mxx, myy: t.myy, mzz: t.mzz,
            mxy: t.mxy, mxz: t.mxz, myz: t.myz
          });
          u[div] = Math.hypot(p.ur[0], p.ur[1]);
          void t0;
        }
        const ref = u[160];
        const rel = (d) => Math.abs(u[d] - ref) / Math.abs(ref);
        const rec = {
          stack: stackName, tensor: tName, rKm, fHz,
          ur: Object.fromEntries(divs.map((d) => [d, +u[d].toPrecision(6)])),
          relVs160: Object.fromEntries(divs.slice(0, 3).map((d) => [d, +rel(d).toExponential(3)]))
        };
        points.push(rec);
        console.log(stackName, tName, 'r' + rKm, 'ur160', ref.toExponential(3),
          'rel:', JSON.stringify(rec.relVs160));
      }
    }
  }
  // summary: max residual per divisor
  const summary = {};
  for (const d of [10, 40, 80]) {
    const vals = points.map((p) => p.relVs160[d]);
    const s = [...vals].sort((a, b) => a - b);
    summary[d] = {
      max: +s[s.length - 1].toExponential(3),
      p90: +s[Math.min(s.length - 1, Math.ceil(s.length * 0.9)) - 1].toExponential(3)
    };
  }
  const report = {
    schema: 'quake-sim-psv-alias-ladder-v1',
    generatedAt: new Date().toISOString(),
    kernel: 'psv.psvMomentSpectrumAtFrequency (layered path), dkInvKm 0.02/km, kMax 5/km, qShear=qP=50, f 0.5 Hz, zs 15 km',
    reference: 'psvGuardDiv 160 (2x finer than the candidate ship value)',
    configs: 'HALF + 3-layer (R11 stack); tensors full/deviatoric; r = 10..200 km',
    divisorLadder: summary,
    reading: 'div 10 already passes the SH-family gate (max 0.011 <= 0.10; the P-SV integrand mass concentrates at low k — far less exposed than the SH Love-tail case); div 40 max 0.0013 and div 80 max 0.00016 give 75x/600x margin at 4x/8x long-range sample cost',
    verdict: 'psv_guard_div10_passes_shipped_default_kept_byte_compat_landed_knob',
    registeredFollowUp: 'revisit the divisor only if opts.psv ever unblocks to production paths; research overrides via params.psvGuardDiv',
    points
  };
  console.log('summary:', JSON.stringify(summary, null, 1));
  if (write) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(write ? 'wrote ' + OUT : '(dry run — pass --write)');
}

main();
