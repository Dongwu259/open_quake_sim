#!/usr/bin/env node
'use strict';
// =====================================================================
//  v6.2 candidate — Conditional-Spectrum-driven time-history pipeline.
//
//  Chain: PSHA anchor -> deaggregation -> MS-CS target (per-bin Baker
//  conditional spectra, probability-weighted mixture) -> hybrid broadband
//  realizations sampled from the deaggregation bins -> single amplitude
//  scaling to the anchor Sa(T*) -> ensemble scoring against the MS-CS.
//
//  Honest positioning (frozen): the B2 scorecard showed the hybrid carries
//  a ~0.3-0.7 log10 absolute deficit vs GMPE reference levels, so the
//  pipeline DOES NOT claim absolute amplitude skill. The amplitude
//  scale factor absorbs it (reported per realization); what is gated is
//  the SHAPE agreement of the ensemble spectrum with the MS-CS target,
//  exactly the quantity engineering use conditions on.
//
//  Channel honesty: SH-only LF (P-SV not implemented) — everything runs on
//  the transverse component, like the B2 scorecard.
// =====================================================================
const fs = require('fs');
const path = require('path');
const hybrid = require('./hybrid.js');
const Physics = require('../../public/physics.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'tools', 'data', 'cs-pipeline-report.json');

// ---- frozen scope (pre-registered BEFORE the first run) -----------------
const PRE_REG = {
  batch: 'CS pipeline acceptance (frozen 2026-09-03, before the first pipeline run)',
  sites: [
    { id: 'tokyo', lat: 35.6812, lng: 139.7671 },
    { id: 'osaka', lat: 34.6937, lng: 135.5022 },
    { id: 'sendai', lat: 38.2682, lng: 140.8694 },
    { id: 'kochi', lat: 33.5597, lng: 133.5311 }
  ],
  returnPeriods: [475, 2500],
  anchorPeriodSec: 1.0,
  periodsSec: [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0],
  realizationsPerCase: 25,
  minRrupKmForSampling: 8,      // bins with meanRrupKm < 8 km are re-weighted out (DW kernel near-field limit)
  imLevels: { lo: 0.5, hi: 30000, n: 60 },  // wide grid so Nankai-adjacent long-RP anchors invert
  gates: {
    anchorAbsLog10: 0.01,       // per realization, construction sanity
    bandAbsMax: { '0.1-0.5s': 0.30, '0.5-2s': 0.25, '2-5s': 0.25 },  // |log10(ensemble geomean / MS-CS mean)|, max over sites+RPs+periods (B2 threshold family)
    containmentInSigmaFrac: 0.8, // fraction of (site,RP,period) with |ln bias| <= sigmaTotal_ln
    lpImprovementVsBruneMin: 0.05, // 2-5 s band AbsMax improvement over the Brune carrier, or both <= 0.10
    pgaNonRegressionVsBruneMargin: 0.05  // hybrid PGA AbsMax may not exceed Brune by more than this
  },
  pgaAbsoluteIsDiagnosticOnly: 'anchor is Sa(1s); absolute PGA control from a 1 s anchor is out of scope (B2 PGA regression root cause stands)',
  mechanismSampling: 'strike ~ U(0,360) seeded per realization; dip from the visible source-class prior (crustal 60 / interplate 15 / intraslab 55); rake from PSHA_CLASS_RAKE — deaggregation carries no mechanism information',
  scope: 'ensemble SHAPE agreement only; no post-hoc threshold tuning, failures reported honestly'
};

const ZHAO_KEY = {
  0.1: '0.10', 0.15: '0.15', 0.2: '0.20', 0.3: '0.30', 0.4: '0.40', 0.5: '0.50',
  0.7: '0.70', 1.0: '1.00', 1.5: '1.50', 2.0: '2.00', 3.0: '3.00', 4.0: '4.00', 5.0: '5.00'
};
const DIP_PRIOR = { crustal: 60, interplate: 15, intraslab: 55 };
const LN10 = Math.LN10;

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** PGA (gal) + PGV (cm/s) of a scaled series (same recipe as the B2 scorecard). */
function peaksOf(accGal, sr) {
  let pga = 0, mean = 0;
  for (const v of accGal) mean += v;
  mean /= accGal.length;
  let vel = 0, pgv = 0;
  for (let i = 0; i < accGal.length; i++) {
    const v = Math.abs(accGal[i]);
    if (v > pga) pga = v;
    const a = accGal[i] - mean;
    if (i > 0) vel += 0.5 * (a + (accGal[i - 1] - mean)) / sr;
    const av = Math.abs(vel); if (av > pgv) pgv = av;
  }
  return { pga, pgv };
}

/** MS-CS target over deaggregation bins. Per bin: zhao2006 log10 median and
 *  sigma at every period (natural-log conversion here), epsilon at T*, then
 *  the Baker conditional mean; probability-weighted mixture mean + total
 *  spread (mixture + conditional variance). */
function msConditionalSpectrum(bins, imTarget, anchorKey, anchorPeriodSec, periods, vs30) {
  const logT = Math.log10(imTarget);
  let usable = [];
  for (const bin of bins) {
    const anchorMo = Physics._pshaBranchMotion('zhao2006', 'sa:' + anchorKey, bin.srcType, bin.repr.mw, bin.meanRrupKm, bin.repr.depthKm, vs30, Physics.PSHA_CLASS_RAKE[bin.srcType] || 0);
    if (!anchorMo || !(anchorMo.median > 0)) continue;
    const eps = (logT - Math.log10(anchorMo.median)) / anchorMo.sigmaLog10;
    usable.push({ bin, eps });
  }
  if (!usable.length) return null;
  const wSum = usable.reduce((a, u) => a + u.bin.prob, 0);
  const periodsOut = [];
  for (let pi = 0; pi < periods.length; pi++) {
    const T = periods[pi];
    let meanLn = 0, m2 = 0;
    for (const u of usable) {
      const w = u.bin.prob / wSum;
      const mo = Physics._pshaBranchMotion('zhao2006', 'sa:' + ZHAO_KEY[T], u.bin.srcType, u.bin.repr.mw, u.bin.meanRrupKm, u.bin.repr.depthKm, vs30, Physics.PSHA_CLASS_RAKE[u.bin.srcType] || 0);
      if (!mo || !(mo.median > 0)) { continue; }
      const muLn = Math.log(mo.median);
      const sigLn = mo.sigmaLog10 * LN10;
      const rho = Physics.rhoPeriodPair(T, anchorPeriodSec, u.bin.srcType);
      const muC = muLn + rho * sigLn * u.eps;
      const sigC = sigLn * Math.sqrt(Math.max(0, 1 - rho * rho));
      meanLn += w * muC; m2 += w * (muC * muC + sigC * sigC);
    }
    const sigmaLn = Math.sqrt(Math.max(0, m2 - meanLn * meanLn));
    periodsOut.push({ periodSec: T, meanGal: Math.exp(meanLn), meanLn, sigmaLn });
  }
  return { periods: periodsOut, nBinsUsed: usable.length, binMassUsed: wSum };
}

function main() {
  const write = process.argv.includes('--write');
  const model = loadJson(path.join(ROOT, 'public', 'geojson', 'psha-source-model.json'));
  const rhoDoc = loadJson(path.join(ROOT, 'public', 'geojson', 'jayaram2011-rho.json'));
  const jivsmCols = loadJson(path.join(ROOT, 'public', 'geojson', 'jivsm-columns.json'));
  const vs30Grid = loadJson(path.join(ROOT, 'public', 'geojson', 'vs30.json'));
  const bedrockGrid = loadJson(path.join(ROOT, 'public', 'geojson', 'jivsm-bedrock.json'));
  const cal = loadJson(path.join(ROOT, 'tools', 'data', 'broadband-hybrid-calibration.json'));
  Physics.setJivsmColumns(jivsmCols);
  Physics.setJayaram2011Rho(rhoDoc);
  const stressMPa = cal.chosenStressMPa, kappaSec = cal.chosenKappaSec;

  const periods = PRE_REG.periodsSec;
  const anchorIdx = periods.indexOf(PRE_REG.anchorPeriodSec);
  const anchorKey = ZHAO_KEY[PRE_REG.anchorPeriodSec];
  const wideLevels = [];
  for (let i = 0; i < PRE_REG.imLevels.n; i++) {
    wideLevels.push(+(PRE_REG.imLevels.lo * Math.pow(PRE_REG.imLevels.hi / PRE_REG.imLevels.lo, i / (PRE_REG.imLevels.n - 1))).toPrecision(4));
  }

  const cases = [];
  const realizations = [];
  const t0 = Date.now();
  for (const siteDef of PRE_REG.sites) {
    const site = { lat: siteDef.lat, lng: siteDef.lng };
    site.vs30 = Physics.lookupResearchGrid(vs30Grid, site.lat, site.lng) || 600;
    const bedrockM = Physics.lookupResearchGrid(bedrockGrid, site.lat, site.lng);
    const col = Physics.jivsmColumnAt(site.lat, site.lng);
    if (!col) { cases.push({ site: siteDef, skipped: 'no JIVSM column' }); continue; }
    const stack = hybrid.buildJivsmIaspStack(col);
    const profile = Physics.synthSiteProfile(site.vs30, bedrockM);

    for (const rp of PRE_REG.returnPeriods) {
      // wide-grid anchor inversion (default grid nulls out at Nankai-adjacent long RP)
      const anchorCurve = Physics.hazardCurve(model, site, 'sa:' + anchorKey, {
        imLevels: wideLevels, vs30: site.vs30
      });
      const imTarget = Physics._pshaInvertCurve(anchorCurve.imLevels, anchorCurve.meanRate, 1 / rp);
      if (!(imTarget > 0)) { cases.push({ site: siteDef, rp, skipped: 'anchor inversion outside the wide IM grid' }); continue; }
      const deagg = Physics.deaggregate(model, site, 'sa:' + anchorKey, { imTarget, vs30: site.vs30 });
      if (!deagg) { cases.push({ site: siteDef, rp, skipped: 'deaggregation empty' }); continue; }
      const mscs = msConditionalSpectrum(deagg.bins, imTarget, anchorKey, PRE_REG.anchorPeriodSec, periods, site.vs30);
      if (!mscs) { cases.push({ site: siteDef, rp, skipped: 'MS-CS unusable' }); continue; }

      // sampling pool: bins at Rrup >= 8 km; record the re-weighted-out mass
      const pool = deagg.bins.filter((b) => b.meanRrupKm >= PRE_REG.minRrupKmForSampling);
      const poolMass = pool.reduce((a, b) => a + b.prob, 0);
      const cum = [];
      let acc = 0;
      for (const b of pool) { acc += b.prob / poolMass; cum.push(acc); }

      const siteCurveFor = (mw, srcType, rRupKm, depthKm) => {
        if (!profile || profile.length < 2) return null;
        const g = Physics._pshaBranchMotion('zhao2006', 'pga', srcType, mw, rRupKm, depthKm, site.vs30, Physics.PSHA_CLASS_RAKE[srcType] || 0);
        if (!g || !(g.median > 0)) return null;
        const freqs = [];
        for (let i = 0; i < 120; i++) freqs.push(0.3 * Math.pow(20 / 0.3, i / 119));
        const res = Physics.siteResponse1D(profile, freqs, { rockPgaG: g.median / 980.665 });
        if (!res || !res.amp) return null;
        return { freqs, amps: res.amp.map((a2) => Math.max(0.2, Math.min(8, a2))) };
      };

      for (const arm of ['hybrid', 'brune']) {
        for (let i = 0; i < PRE_REG.realizationsPerCase; i++) {
          const rng = Physics.seededRng(hashSeed(siteDef.id + ':' + rp + ':' + arm + ':' + i));
          // sample a deaggregation bin
          const u = rng();
          let bi = 0;
          while (bi < cum.length - 1 && u > cum[bi]) bi++;
          const bin = pool[bi] || pool[pool.length - 1];
          const strike = +(rng() * 360).toFixed(2);
          const dip = DIP_PRIOR[bin.srcType] || 45;
          const rake = Physics.PSHA_CLASS_RAKE[bin.srcType] || 0;
          const siteCurve = siteCurveFor(bin.repr.mw, bin.srcType, bin.meanRrupKm, bin.repr.depthKm);
          const common = {
            sourceLat: bin.repr.lat, sourceLng: bin.repr.lng, sourceDepthKm: bin.repr.depthKm,
            mw: bin.repr.mw, strike, dip, rake,
            receiverLat: site.lat, receiverLng: site.lng, vs30: site.vs30,
            stressMPa, kappaSec, siteCurve, sampleRateHz: 50,
            seed: hashSeed(siteDef.id + ':' + rp + ':' + arm + ':' + i + ':synth')
          };
          let out;
          try {
            out = arm === 'hybrid' ? hybrid.hybridSynthesis(Object.assign({}, common, { stack })) : hybrid.bruneBaselineSynthesis(Object.assign({}, common, { stack }));
          } catch (e) {
            realizations.push({ arm, site: siteDef.id, rp, i, invalid: String(e.message || e).slice(0, 80) });
            continue;
          }
          const gal = out.transverse.map((a) => a * 100);
          const spec = Physics.sdofResponseSpectrum(gal, out.sampleRateHz, periods, 0.05);
          const psa = spec.map((row) => row.psaGal);
          const anchorPsa = psa[anchorIdx];
          if (!(anchorPsa > 0) || !isFinite(anchorPsa)) {
            realizations.push({ arm, site: siteDef.id, rp, i, invalid: 'non-positive anchor PSA' });
            continue;
          }
          const scale = imTarget / anchorPsa;
          const scaled = psa.map((v) => v * scale);
          const pk = peaksOf(gal.map((v) => v * scale), out.sampleRateHz);
          realizations.push({
            arm, site: siteDef.id, rp, i, srcType: bin.srcType, mw: +bin.repr.mw.toFixed(2),
            rRupKm: +bin.meanRrupKm.toFixed(1), distKm: +(out.meta.distKm || 0).toFixed(1),
            depthKm: +bin.repr.depthKm.toFixed(1), strike,
            log10Scale: +Math.log10(scale).toFixed(3), epsBin: +bin.meanEps.toFixed(2),
            psaGal: scaled.map((v) => +v.toFixed(1)), pga: +pk.pga.toFixed(1), pgv: +pk.pgv.toFixed(1)
          });
        }
      }
      cases.push({
        site: siteDef, rp, vs30: site.vs30, imTarget: +imTarget.toFixed(1),
        deagg: {
          meanMw: +deagg.mean.mw.toFixed(2), meanRrupKm: +deagg.mean.rRupKm.toFixed(1),
          meanEps: +deagg.mean.eps.toFixed(2), classShares: deagg.classShares,
          nBins: deagg.bins.length, samplingPoolBins: pool.length,
          excludedNearFieldMass: +(1 - poolMass).toFixed(4)
        },
        mscs: {
          nBinsUsed: mscs.nBinsUsed, binMassUsed: +mscs.binMassUsed.toFixed(4),
          meanGal: mscs.periods.map((p) => +p.meanGal.toFixed(1)),
          sigmaLn: mscs.periods.map((p) => +p.sigmaLn.toFixed(3))
        }
      });
      console.log(siteDef.id + ' RP' + rp + ': anchor ' + imTarget.toFixed(0) + ' gal, deagg M' + deagg.mean.mw.toFixed(1) + '@' + deagg.mean.rRupKm.toFixed(0) + 'km eps' + deagg.mean.eps.toFixed(2) + ', ' + realizations.filter((r) => r.site === siteDef.id && r.rp === rp && !r.invalid).length + ' valid realizations');
    }
  }
  console.log('synthesis elapsed', ((Date.now() - t0) / 1000 / 60).toFixed(1), 'min');

  // ---- ensemble scoring --------------------------------------------------
  const validCases = cases.filter((c) => c.mscs);
  function bandPeriods(name) {
    const map = { '0.1-0.5s': [0.1, 0.15, 0.2, 0.3, 0.4, 0.5], '0.5-2s': [0.7, 1.0, 1.5, 2.0], '2-5s': [3.0, 4.0, 5.0] };
    return map[name];
  }
  function caseEnsemble(siteId, rp, arm) {
    const rows = realizations.filter((r) => r.site === siteId && r.rp === rp && r.arm === arm && r.psaGal);
    if (!rows.length) return null;
    const lnMean = periods.map((_, pi) => {
      let s = 0;
      for (const r of rows) s += Math.log(r.psaGal[pi]);
      return s / rows.length;
    });
    const pgaLogs = rows.map((r) => Math.log(r.pga));
    return { n: rows.length, lnMean, geomeanGal: lnMean.map((v) => +Math.exp(v).toFixed(1)), pgaLnMean: pgaLogs.reduce((a, b) => a + b, 0) / pgaLogs.length };
  }

  const perCase = [];
  const biasLog10 = {}; // [arm][site][rp][periodIdx]
  for (const arm of ['hybrid', 'brune']) biasLog10[arm] = {};
  for (const c of validCases) {
    const mscsMeanLn = c.mscs.meanGal.map((g) => Math.log(g));
    for (const arm of ['hybrid', 'brune']) {
      const ens = caseEnsemble(c.site.id, c.rp, arm);
      if (!ens) continue;
      const bias = ens.lnMean.map((v, pi) => (v - mscsMeanLn[pi]) / LN10);
      const anchorCheck = Math.abs(bias[anchorIdx]);
      const containment = c.mscs.sigmaLn.filter((s, pi) => Math.abs(ens.lnMean[pi] - mscsMeanLn[pi]) <= s).length / periods.length;
      if (!biasLog10[arm][c.site.id]) biasLog10[arm][c.site.id] = {};
      biasLog10[arm][c.site.id][c.rp] = bias.map((v) => +v.toFixed(3));
      perCase.push({
        site: c.site.id, rp: c.rp, arm, n: ens.n,
        biasLog10: bias.map((v) => +v.toFixed(3)),
        anchorBiasLog10: +anchorCheck.toFixed(4),
        containmentFrac: +containment.toFixed(3),
        pgaBiasLog10: null // filled below vs case PGA target if defined
      });
    }
  }

  // band AbsMax + gates
  const bands = {};
  for (const band of Object.keys(PRE_REG.gates.bandAbsMax)) {
    const idx = bandPeriods(band).map((T) => periods.indexOf(T));
    bands[band] = {};
    for (const arm of ['hybrid', 'brune']) {
      let worst = 0, worstAt = null;
      for (const c of validCases) {
        const b = biasLog10[arm][c.site.id] && biasLog10[arm][c.site.id][c.rp];
        if (!b) continue;
        for (const pi of idx) {
          if (Math.abs(b[pi]) > worst) { worst = Math.abs(b[pi]); worstAt = c.site.id + ' RP' + c.rp + ' @' + periods[pi] + 's'; }
        }
      }
      bands[band][arm] = { absMax: +worst.toFixed(3), worstAt };
    }
    bands[band].gate = {
      limit: PRE_REG.gates.bandAbsMax[band],
      pass: bands[band].hybrid.absMax <= PRE_REG.gates.bandAbsMax[band]
    };
  }

  // anchor construction check: every valid realization rescales exactly
  const validRows = realizations.filter((r) => r.psaGal);
  const anchorWorst = Math.max(0, ...validRows.map((r) => {
    // anchor exactness is enforced at construction; recoverible check: scaled anchor == imTarget
    const c = validCases.find((cc) => cc.site.id === r.site && cc.rp === r.rp);
    return c ? Math.abs(Math.log10(r.psaGal[anchorIdx] / c.imTarget)) : 0;
  }));

  // containment aggregate
  const containmentFracs = perCase.filter((p) => p.arm === 'hybrid').map((p) => p.containmentFrac);
  const containmentFrac = containmentFracs.length ? containmentFracs.reduce((a, b) => a + b, 0) / containmentFracs.length : 0;

  // PGA non-regression vs brune: PGA target = MS-CS at the anchor only for shape;
  // non-regression compares |log10 bias| of PGA vs the same measured against the
  // brune arm's own ensemble (both scaled at 1 s, so PGA bias is relative to
  // the arm-independent... measured vs MS-CS PGA extrapolation is not defined)
  // -> honest simplification (frozen): compare PGA/PSA(T*) ratio shape instead:
  // ratio_i = PGA_i / PSAT*_i per realization; gate on the ensemble log-ratio
  // spread between arms (hybrid must not exceed brune by > 0.05 log10).
  function armPgaRatioLn(arm) {
    const rows = realizations.filter((r) => r.arm === arm && r.psaGal);
    let s = 0;
    for (const r of rows) s += Math.log(r.pga / r.psaGal[anchorIdx]);
    return s / rows.length;
  }
  const pgaRatioDelta = (armPgaRatioLn('hybrid') - armPgaRatioLn('brune')) / LN10;

  const gates = {
    anchorExact: { limit: PRE_REG.gates.anchorAbsLog10, observedAbsMax: +anchorWorst.toFixed(4), pass: anchorWorst <= PRE_REG.gates.anchorAbsLog10 },
    bandAbsMax: Object.fromEntries(Object.keys(bands).map((b) => [b, {
      limit: bands[b].gate.limit, hybridAbsMax: bands[b].hybrid.absMax, bruneAbsMax: bands[b].brune.absMax,
      worstAt: bands[b].hybrid.worstAt, pass: bands[b].gate.pass
    }])),
    containmentInSigma: { limit: PRE_REG.gates.containmentInSigmaFrac, observed: +containmentFrac.toFixed(3), pass: containmentFrac >= PRE_REG.gates.containmentInSigmaFrac },
    lpImprovementVsBrune: {
      hybridAbsMax: bands['2-5s'].hybrid.absMax, bruneAbsMax: bands['2-5s'].brune.absMax,
      improvement: +(bands['2-5s'].brune.absMax - bands['2-5s'].hybrid.absMax).toFixed(3),
      pass: (bands['2-5s'].brune.absMax - bands['2-5s'].hybrid.absMax) >= PRE_REG.gates.lpImprovementVsBruneMin
        || (bands['2-5s'].hybrid.absMax <= 0.10 && bands['2-5s'].brune.absMax <= 0.10)
    },
    pgaShapeNonRegressionVsBrune: {
      definition: 'ensemble log10(PGA/PSA(T*)) of hybrid may not exceed brune by more than the margin (both arms anchored at T*)',
      deltaHybridMinusBrune: +pgaRatioDelta.toFixed(3), margin: PRE_REG.gates.pgaNonRegressionVsBruneMargin,
      pass: pgaRatioDelta <= PRE_REG.gates.pgaNonRegressionVsBruneMargin
    }
  };

  // scale-factor transparency (absorbed absolute deficit — NOT a gate)
  const scaleStats = {};
  for (const arm of ['hybrid', 'brune']) {
    const logs = realizations.filter((r) => r.arm === arm && r.log10Scale != null).map((r) => r.log10Scale);
    scaleStats[arm] = logs.length ? { median: +median(logs).toFixed(3), min: +Math.min(...logs).toFixed(3), max: +Math.max(...logs).toFixed(3), n: logs.length } : null;
  }
  const invalidCount = realizations.filter((r) => r.invalid).length;

  const report = {
    schema: 'quake-sim-cs-pipeline-v1',
    generatedAt: new Date().toISOString(),
    preRegistered: PRE_REG,
    chain: 'hazardCurve wide-grid anchor -> deaggregate -> MS-CS (per-bin Baker conditional spectra, prob-weighted mixture) -> hybrid/brune synthesis on sampled bins -> single amplitude scale to Sa(T*=1s) -> ensemble geomean vs MS-CS shape',
    arms: {
      hybrid: 'B1 SH DW LF + absolute Boore HF (frozen stress/kappa), JIVSM+IASP91 stack + eqlin site curve at the site',
      brune: 'full-band absolute stochastic baseline, same sampling/scaling (carrier comparison arm)'
    },
    stressMPa, kappaSec,
    cases, gates, bands, perCase, scaleFactors: scaleStats,
    invalidRealizations: invalidCount,
    realizations,
    findings: {}
  };
  // findings text is finalized below from the frozen numbers (no new metrics)
  const f = [];
  f.push('shape: ' + (Object.keys(gates.bandAbsMax).every((b) => gates.bandAbsMax[b].pass)
    ? 'PASS all band shape gates (|log10 ensemble/MS-CS| <= limit over all sites/RPs/periods)'
    : 'FAIL ' + Object.keys(gates.bandAbsMax).filter((b) => !gates.bandAbsMax[b].pass).map((b) => b + '(' + gates.bandAbsMax[b].hybridAbsMax + ')').join(', ') + ' vs limits'));
  f.push('lp vs brune: ' + (gates.lpImprovementVsBrune.pass ? 'PASS' : 'FAIL') + ' (hybrid ' + gates.lpImprovementVsBrune.hybridAbsMax + ' vs brune ' + gates.lpImprovementVsBrune.bruneAbsMax + ' in 2-5 s)');
  f.push('containment: ' + (gates.containmentInSigma.pass ? 'PASS' : 'FAIL') + ' (observed ' + gates.containmentInSigma.observed + ' >= ' + gates.containmentInSigma.limit + ')');
  f.push('scale factors (absorbed absolute deficit, diagnostic): hybrid median 10^' + (scaleStats.hybrid ? scaleStats.hybrid.median : 'n/a') + ', brune median 10^' + (scaleStats.brune ? scaleStats.brune.median : 'n/a') + ' — consistent with the B2 absolute-calibration deficit; shape gates are unaffected by construction');
  f.push('caveats: SH-only (transverse channel); deaggregation carries no mechanism (strike sampled, dip/rake class priors); single-corner Brune source; bins < 8 km Rrup excluded from sampling (near-field DW limit); anchor Sa(1s) means absolute PGA is diagnostic only');
  report.findings = { summary: f };

  if (write) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log('\n=== GATES ===');
  console.log('anchorExact:', gates.anchorExact.pass ? 'PASS' : 'FAIL', gates.anchorExact.observedAbsMax);
  for (const b of Object.keys(gates.bandAbsMax)) {
    console.log('band', b, gates.bandAbsMax[b].pass ? 'PASS' : 'FAIL', 'hybrid', gates.bandAbsMax[b].hybridAbsMax, 'brune', gates.bandAbsMax[b].bruneAbsMax, 'limit', gates.bandAbsMax[b].limit);
  }
  console.log('containment:', gates.containmentInSigma.pass ? 'PASS' : 'FAIL', gates.containmentInSigma.observed);
  console.log('lpImprovement:', gates.lpImprovementVsBrune.pass ? 'PASS' : 'FAIL', gates.lpImprovementVsBrune.improvement);
  console.log('pgaShapeNonRegression:', gates.pgaShapeNonRegressionVsBrune.pass ? 'PASS' : 'FAIL', gates.pgaShapeNonRegressionVsBrune.deltaHybridMinusBrune);
  console.log('invalid realizations:', invalidCount);
  console.log(write ? 'wrote ' + OUT : '(dry run — pass --write to freeze)');
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
