#!/usr/bin/env node
'use strict';
// =====================================================================
//  CS shape-gate DIAGNOSIS — executes the two diagnosis lines registered
//  in HANDOVER after the cs-pipeline gates froze FAIL (v2 anchors,
//  2026-09-04):
//
//  A. short-period (0.1-0.5 s) overshoot, three-cause decomposition:
//     A1 pure-HF shape bias — hybrid re-synthesised with the LF side off
//        (lfMaxHz -> 0) is essentially the frozen Boore HF model alone
//        (the LP-filtered DW tail is ~0 above 2 Hz); its realized PSA
//        ratio bias at 0.1-0.5 s vs the MS-CS target IS the HF-model share
//     A2 kappa sensitivity — the frozen kappa0=0.02 vs the hybrid default
//        0.04, HF-only arm: how much of A1 is the frozen kappa choice
//        (DIAGNOSTIC, not a retuning)
//     A3 target reachability — the MS-CS mixture ratio at 0.1 s vs the
//        envelope of per-bin zhao median mu(T)/mu(1s) ratios from the
//        same deaggregation: if the target ratio sits BELOW every bin
//        ratio, no single-event physics can reach it (structural)
//  B. 2-5 s deficit at the JIVSM-column sites (kochi worst, osaka second):
//     B1 velocity model — hybrid re-synthesised on a homogeneous
//        half-space stack (identical seed/source/HF path; the DIFFERENCE
//        between runs is purely the DW velocity model)
//     B2 Q sensitivity — qShear 50 (frozen default) vs 100, same setup
//        (DIAGNOSTIC)
//     B3 anchor-shape mismatch — per case, the log10 scale each period
//        would need vs the single Sa(1s) anchor scale actually applied
//        (period-resolved deficit of the DW side, anchor-free)
//
//  Everything reuses the frozen cs-pipeline case construction (same
//  pre-registered sites/RPs/anchor/wide grid/deagg sampling). This report
//  is a measurement; no parameter is retuned from it.
// =====================================================================
const fs = require('fs');
const path = require('path');
const hybrid = require('./hybrid.js');
const Physics = require('../../public/physics.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'tools', 'data', 'cs-diagnosis-report.json');
const PRE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'cs-pipeline-report.json'), 'utf8')).preRegistered;
const CAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'data', 'broadband-hybrid-calibration.json'), 'utf8'));
const DIP_PRIOR = { crustal: 60, interplate: 15, intraslab: 55 };
const ZHAO_KEY = { 0.1: '0.10', 0.2: '0.20', 0.5: '0.50', 1.0: '1.00', 2.0: '2.00', 3.0: '3.00', 4.0: '4.00', 5.0: '5.00' };
const N_RZ_BAND = 10;    // realizations per case for the band arms
const N_RZ_STRUCT = 3;   // realizations per structural arm (velocity/Q)
const SHORT = [0, 1, 2, 3, 4, 5];      // periodsSec indices 0.1..0.5 s
const LP = [10, 11, 12];               // 2, 3, 4 s (the failing long band)
const A_IDX = PRE.periodsSec.indexOf(PRE.anchorPeriodSec);

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function hashSeed(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function median(a) { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

function ratioBias(psas, targetMean) {
  // anchor-free shape bias per period: log10[psa(T)/psa(1s)] - log10[target(T)/target(1s)]
  const a = psas[A_IDX];
  return psas.map((v, i) => Math.log10((v / a) / (targetMean[i] / targetMean[A_IDX])));
}

function main() {
  const write = process.argv.includes('--write');
  const model = loadJson(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'));
  const rhoDoc = loadJson(path.join(ROOT, 'public', 'geojson', 'jayaram2011-rho.json'));
  const jivsmCols = loadJson(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'));
  const vs30Grid = loadJson(path.join(ROOT, 'public', 'geojson', 'vs30.json'));
  Physics.setJivsmColumns(jivsmCols);
  Physics.setJayaram2011Rho(rhoDoc);
  const stressMPa = CAL.chosenStressMPa, kappaSec = CAL.chosenKappaSec;

  const periods = PRE.periodsSec;
  const anchorKey = ZHAO_KEY[PRE.anchorPeriodSec];
  const wideLevels = [];
  for (let i = 0; i < PRE.imLevels.n; i++) wideLevels.push(+(PRE.imLevels.lo * Math.pow(PRE.imLevels.hi / PRE.imLevels.lo, i / (PRE.imLevels.n - 1))).toPrecision(4));

  const cases = [];
  const t0 = Date.now();
  for (const siteDef of PRE.sites) {
    const site = { lat: siteDef.lat, lng: siteDef.lng };
    site.vs30 = Physics.lookupResearchGrid(vs30Grid, site.lat, site.lng) || 600;
    const col = Physics.jivsmColumnAt(site.lat, site.lng);
    if (!col) continue; // sendai: frozen skip
    const stack = hybrid.buildJivsmIaspStack(col);

    for (const rp of PRE.returnPeriods) {
      const anchorCurve = Physics.hazardCurve(model, site, 'sa:' + anchorKey, { imLevels: wideLevels, vs30: site.vs30 });
      const imTarget = Physics._pshaInvertCurve(anchorCurve.imLevels, anchorCurve.meanRate, 1 / rp);
      if (!(imTarget > 0)) continue;
      const deagg = Physics.deaggregate(model, site, 'sa:' + anchorKey, { imTarget, vs30: site.vs30 });
      if (!deagg) continue;
      const frozenCase = loadJson(path.join(ROOT, 'tools', 'data', 'cs-pipeline-report.json')).cases.find((c) => c.site.id === siteDef.id && c.rp === rp);
      const targetMean = frozenCase.mscs.meanGal;

      // ---- A3 target reachability: per-bin zhao median ratio envelope ----
      // evaluated at BOTH ends of the failing structure: 0.1 s (HF band) and
      // 3 s (DW band) — a target ratio outside the per-bin envelope means no
      // single-event median shape can reach it (mixture-CS structural effect)
      const binRatios = { '0.1': [], '3': [] };
      for (const b of deagg.bins) {
        if (b.prob / (deagg.bins.reduce((x, y) => x + y.prob, 0) || 1) < 0.005) continue; // mass-weighted envelope over real contributors
        const mAnch = Physics._pshaBranchMotion('zhao2006', 'sa:' + anchorKey, b.srcType, b.repr.mw, b.meanRrupKm, b.repr.depthKm, site.vs30, Physics.PSHA_CLASS_RAKE[b.srcType] || 0);
        for (const T of [0.1, 3]) {
          const mT = Physics._pshaBranchMotion('zhao2006', 'sa:' + ZHAO_KEY[T], b.srcType, b.repr.mw, b.meanRrupKm, b.repr.depthKm, site.vs30, Physics.PSHA_CLASS_RAKE[b.srcType] || 0);
          if (mT && mAnch && mT.median > 0 && mAnch.median > 0) binRatios[String(T)].push(Math.log10(mT.median / mAnch.median));
        }
      }
      const targetRatio01 = Math.log10(targetMean[0] / targetMean[A_IDX]);
      const i3s = periods.indexOf(3.0);
      const targetRatio3s = Math.log10(targetMean[i3s] / targetMean[A_IDX]);
      const lpEnvelope = binRatios['3'];
      const targetAboveAllBins3s = lpEnvelope.length ? targetRatio3s > Math.max(...lpEnvelope) : null;

      // ---- sampling pool (identical to the pipeline) ----
      const pool = deagg.bins.filter((b) => b.meanRrupKm >= PRE.minRrupKmForSampling);
      const poolMass = pool.reduce((a, b) => a + b.prob, 0);
      const cum = []; let acc = 0;
      for (const b of pool) { acc += b.prob / poolMass; cum.push(acc); }

      const synthBias = (opts) => {
        const biases = [];
        for (let i = 0; i < N_RZ_BAND; i++) {
          const rng = Physics.seededRng(hashSeed(siteDef.id + ':' + rp + ':diag:' + i));
          const u = rng(); let bi = 0;
          while (bi < cum.length - 1 && u > cum[bi]) bi++;
          const bin = pool[bi] || pool[pool.length - 1];
          const strike = +(rng() * 360).toFixed(2);
          const out = hybrid.hybridSynthesis(Object.assign({
            sourceLat: bin.repr.lat, sourceLng: bin.repr.lng, sourceDepthKm: bin.repr.depthKm,
            mw: bin.repr.mw, strike, dip: DIP_PRIOR[bin.srcType] || 45, rake: Physics.PSHA_CLASS_RAKE[bin.srcType] || 0,
            receiverLat: site.lat, receiverLng: site.lng, vs30: site.vs30, stack,
            stressMPa, kappaSec, sampleRateHz: 50,
            seed: hashSeed(siteDef.id + ':' + rp + ':diag:' + i + ':synth')
          }, opts));
          const gal = out.transverse.map((a) => a * 100);
          const psa = Physics.sdofResponseSpectrum(gal, out.sampleRateHz, periods, 0.05).map((r) => r.psaGal);
          if (psa[A_IDX] > 0) biases.push(ratioBias(psa, targetMean));
        }
        return periods.map((_, pi) => +median(biases.map((b) => b[pi])).toFixed(3));
      };

      // A1: LF off -> pure frozen Boore HF shape bias
      const hfOnly = synthBias({ lfMaxHz: 0.001 });
      // A2: kappa 0.04 (hybrid default), HF-only — sensitivity of A1 to the frozen kappa
      const hfKappa04 = synthBias({ lfMaxHz: 0.001, kappaSec: 0.04 });
      // reference: the shipped hybrid (sanity vs the frozen perCase bias)
      const shipped = synthBias({});

      // ---- B3 period-resolved deficit (shipped hybrid, before any scaling) ----
      const periodScaleNeeded = [];
      {
        const biases = [];
        for (let i = 0; i < N_RZ_BAND; i++) {
          const rng = Physics.seededRng(hashSeed(siteDef.id + ':' + rp + ':diag:' + i));
          const u = rng(); let bi = 0;
          while (bi < cum.length - 1 && u > cum[bi]) bi++;
          const bin = pool[bi] || pool[pool.length - 1];
          const strike = +(rng() * 360).toFixed(2);
          const out = hybrid.hybridSynthesis({
            sourceLat: bin.repr.lat, sourceLng: bin.repr.lng, sourceDepthKm: bin.repr.depthKm,
            mw: bin.repr.mw, strike, dip: DIP_PRIOR[bin.srcType] || 45, rake: Physics.PSHA_CLASS_RAKE[bin.srcType] || 0,
            receiverLat: site.lat, receiverLng: site.lng, vs30: site.vs30, stack,
            stressMPa, kappaSec, sampleRateHz: 50, seed: hashSeed(siteDef.id + ':' + rp + ':diag:' + i + ':synth')
          });
          const gal = out.transverse.map((a) => a * 100);
          const psa = Physics.sdofResponseSpectrum(gal, out.sampleRateHz, periods, 0.05).map((r) => r.psaGal);
          if (psa[A_IDX] > 0) biases.push(psa.map((v) => v * (imTarget / psa[A_IDX])));
        }
        // anchored ensembles: log10 bias per period vs target (the period-resolved shape of the shipped arm)
        const ens = periods.map((_, pi) => +median(biases.map((p) => p[pi])).toFixed(1));
        for (let pi = 0; pi < periods.length; pi++) {
          periodScaleNeeded.push(+(Math.log10(ens[pi] / targetMean[pi])).toFixed(3));
        }
      }

      // ---- B1/B2 velocity-model + Q attribution (kochi/osaka only) ----
      let structural = null;
      if (siteDef.id === 'kochi' || siteDef.id === 'osaka') {
        const runArm = (stackOverride, qShear) => {
          const res = { psaMedian: periods.map(() => []), hfScaleRaw: [] };
          for (let i = 0; i < N_RZ_STRUCT; i++) {
            const rng = Physics.seededRng(hashSeed(siteDef.id + ':' + rp + ':struct:' + i));
            const u = rng(); let bi = 0;
            while (bi < cum.length - 1 && u > cum[bi]) bi++;
            const bin = pool[bi] || pool[pool.length - 1];
            const strike = +(rng() * 360).toFixed(2);
            const out = hybrid.hybridSynthesis({
              sourceLat: bin.repr.lat, sourceLng: bin.repr.lng, sourceDepthKm: bin.repr.depthKm,
              mw: bin.repr.mw, strike, dip: DIP_PRIOR[bin.srcType] || 45, rake: Physics.PSHA_CLASS_RAKE[bin.srcType] || 0,
              receiverLat: site.lat, receiverLng: site.lng, vs30: site.vs30,
              stack: stackOverride || stack, qShear: qShear || 50,
              stressMPa, kappaSec, sampleRateHz: 50, seed: hashSeed(siteDef.id + ':' + rp + ':struct:' + i + ':synth')
            });
            const gal = out.transverse.map((a) => a * 100);
            const psa = Physics.sdofResponseSpectrum(gal, out.sampleRateHz, periods, 0.05).map((r) => r.psaGal);
            for (let pi = 0; pi < periods.length; pi++) res.psaMedian[pi].push(psa[pi]);
            res.hfScaleRaw.push(+out.meta.hfScaleRaw.toFixed(3));
          }
          return { psaMedian: periods.map((_, pi) => +median(res.psaMedian[pi]).toFixed(1)), hfScaleRaw: +median(res.hfScaleRaw).toFixed(3) };
        };
        const halfStack = [{ topKm: 0, bottomKm: null, vsKmS: 3.5, rhoGcm3: 2.7 }];
        const asShipped = runArm(null, null);
        const halfspace = runArm(halfStack, null);
        const q100 = runArm(null, 100);
        structural = {
          halfspaceVsJivsm: periods.map((_, pi) => +(Math.log10(halfspace.psaMedian[pi] / asShipped.psaMedian[pi])).toFixed(3)),
          q100VsQ50: periods.map((_, pi) => +(Math.log10(q100.psaMedian[pi] / asShipped.psaMedian[pi])).toFixed(3)),
          asShipped, halfspace, q100
        };
      }

      cases.push({
        site: siteDef, rp, imTarget: +imTarget.toFixed(1),
        shortBand: {
          hfOnlyBias: hfOnly.filter((_, i) => SHORT.includes(i)),
          hfKappa04Bias: hfKappa04.filter((_, i) => SHORT.includes(i)),
          shippedBias: shipped.filter((_, i) => SHORT.includes(i)),
          periodsSec: periods.filter((_, i) => SHORT.includes(i))
        },
        targetReachability: {
          targetRatio01, binRatioMin: binRatios['0.1'].length ? +Math.min(...binRatios['0.1']).toFixed(3) : null,
          binRatioMax: binRatios['0.1'].length ? +Math.max(...binRatios['0.1']).toFixed(3) : null,
          nBins: binRatios['0.1'].length,
          targetBelowAllBins: binRatios['0.1'].length ? targetRatio01 < Math.min(...binRatios['0.1']) : null,
          targetRatio3s, lpBinRatioMax: lpEnvelope.length ? +Math.max(...lpEnvelope).toFixed(3) : null,
          targetAboveAllBins3s
        },
        periodBiasLog10: periodScaleNeeded,
        structural
      });
      console.log(siteDef.id + ' RP' + rp + ': shipped@0.1s ' + shipped[0] + ' hfOnly ' + hfOnly[0] +
        ' kappa04 ' + hfKappa04[0] + ' | target ratio ' + targetRatio01.toFixed(2) +
        ' bin envelope [' + (binRatios['0.1'].length ? Math.min(...binRatios['0.1']).toFixed(2) : 'n/a') + '..' + (binRatios['0.1'].length ? Math.max(...binRatios['0.1']).toFixed(2) : 'n/a') + ']' +
        ' belowAll=' + (binRatios['0.1'].length ? targetRatio01 < Math.min(...binRatios['0.1']) : 'n/a') +
        ' | 2-4s bias ' + periodScaleNeeded.slice(10, 13).join('/') +
        ' | 3s target ' + targetRatio3s.toFixed(2) + ' lpEnvelopeMax ' + (lpEnvelope.length ? Math.max(...lpEnvelope).toFixed(2) : 'n/a') +
        ' aboveAll=' + targetAboveAllBins3s);
    }
  }

  // aggregate the decomposition across cases
  const allCases = cases;
  const agg = {
    hfOnly01Median: +median(allCases.map((c) => c.shortBand.hfOnlyBias[0])).toFixed(3),
    shipped01Median: +median(allCases.map((c) => c.shortBand.shippedBias[0])).toFixed(3),
    kappa04Delta01Median: +median(allCases.map((c) => c.shortBand.hfKappa04Bias[0] - c.shortBand.hfOnlyBias[0])).toFixed(3),
    targetBelowAllBins01s: allCases.every((c) => c.targetReachability.targetBelowAllBins === true),
    nCasesTargetBelowAll01s: allCases.filter((c) => c.targetReachability.targetBelowAllBins === true).length,
    nCasesTargetAboveAll3s: allCases.filter((c) => c.targetReachability.targetAboveAllBins3s === true).length,
    kochi24sBias: allCases.filter((c) => c.site.id === 'kochi').map((c) => c.periodBiasLog10.slice(10, 13)),
    halfspaceEffect24sKochi: (() => {
      const k = allCases.filter((c) => c.site.id === 'kochi' && c.structural);
      return k.length ? k.map((c) => c.structural.halfspaceVsJivsm.slice(10, 13)) : null;
    })()
  };

  const report = {
    schema: 'quake-sim-cs-diagnosis-v1',
    generatedAt: new Date().toISOString(),
    basis: {
      sourceModel: model.schema,
      pipeline: 'tools/data/cs-pipeline-report.json (v2 anchors, gates frozen FAIL 2026-09-04)',
      arms: 'A1 hfOnly (lfMaxHz->0) / A2 kappa 0.04 sensitivity / A3 per-bin zhao ratio envelope; B1 homogeneous half-space stack / B2 qShear 100 / B3 period-resolved bias',
      note: 'DIAGNOSIS ONLY — sensitivity arms are measurements, not retuning; no parameter was changed from this report'
    },
    aggregate: agg,
    cases
  };
  if (write) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log('\n=== DIAGNOSIS ===');
  console.log('shipped 0.1s bias median ' + agg.shipped01Median + ' | hfOnly ' + agg.hfOnly01Median +
    ' | kappa04 delta ' + agg.kappa04Delta01Median + ' | target below ALL bins (0.1s): ' + agg.nCasesTargetBelowAll01s + '/' + allCases.length +
    ' | target above ALL bins (3s): ' + agg.nCasesTargetAboveAll3s + '/' + allCases.length);
  console.log('kochi 2/3/4s bias: ' + JSON.stringify(agg.kochi24sBias) + ' | halfspace-vs-jivsm: ' + JSON.stringify(agg.halfspaceEffect24sKochi));
  console.log('elapsed ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
  console.log(write ? 'wrote ' + OUT : '(dry run — pass --write to freeze)');
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
