'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
const Physics=require('../public/physics.js');
const Scorecard=require('../tools/scorecard-strong-motion.js');

const OBS=JSON.parse(fs.readFileSync('public/geojson/strong-motion-obs.json','utf8'));
const CAL=JSON.parse(fs.readFileSync('public/geojson/gmpe-calibration.json','utf8'));
const EVENT_IDS=['tohoku2011','kumamoto2016','tokachi2003','fukushima2022','noto2024','hyuganada2024',
  'chuetsu2004','iwate2008','fukuoka2005','noto2007','fukushima2011','yamagata2019','iburihigashi2018',
  // v6.2 expansion (2026-09-03): +6 events, JMA hypocenters frozen in observed.json
  'tottori2000','geiyo2001','miyagioki2005','chuetsuoki2007','nagano2014','ishikawa2023'];

test('frozen strong-motion file has all nineteen events with stations and provenance',()=>{
  assert.equal(OBS.schema,'quake-sim-strong-motion-obs-v1');
  assert.deepEqual(OBS.events.map(e=>e.eventId).sort(),EVENT_IDS.slice().sort());
  for(const ev of OBS.events){
    assert.ok(ev.usgsId && ev.time && !isNaN(Date.parse(ev.time)),ev.eventId+' metadata');
    assert.ok(isFinite(ev.lat)&&isFinite(ev.lng)&&ev.depthKm>0&&ev.mw>=6.0,ev.eventId+' hypocenter (USGS Mw; JMA Mj differs)');
    assert.ok(['crustal','interplate','intraslab'].includes(ev.sourceType),ev.eventId+' sourceType');
    assert.ok(ev.provenance&&/^https:\/\//.test(ev.provenance.sourceUrl)&&ev.provenance.retrievedAt&&ev.provenance.license,ev.eventId+' provenance');
    assert.ok(ev.stations.length>100,ev.eventId+' station count');
  }
});

test('station records are unit-plausible instrumented peaks (gal / cm/s, MMI kept separate)',()=>{
  for(const ev of OBS.events){
    let withVs30=0;
    for(const s of ev.stations){
      assert.ok(s.code&&s.network,ev.eventId+' station identity');
      assert.ok(s.lat>20&&s.lat<50&&s.lng>125&&s.lng<150,'coords in Japan range: '+s.code);
      assert.ok(s.pgaGal>=2&&s.pgaGal<6000,'pgaGal plausible (gal, not %g): '+s.code+' '+s.pgaGal);
      assert.ok(s.pgvCms>0.05&&s.pgvCms<600,'pgvCms plausible: '+s.code+' '+s.pgvCms);
      assert.equal(s.intensityType,'MMI'); // shakemap instrumental MMI — never JMA
      if(s.vs30)withVs30++;
    }
    assert.ok(withVs30/ev.stations.length>0.9,ev.eventId+' vs30 coverage');
  }
  // The %g->gal unit trap: Tohoku near-field max must be 100..5000 gal.
  const tohoku=OBS.events.find(e=>e.eventId==='tohoku2011');
  const maxPga=Math.max(...tohoku.stations.map(s=>s.pgaGal));
  assert.ok(maxPga>100&&maxPga<5000,'Tohoku max pgaGal='+maxPga);
});

test('predictStation mirrors the forecast path and responds to site term and distance',()=>{
  const ev=OBS.events.find(e=>e.eventId==='tohoku2011');
  const near={lat:38.5,lng:141.5,vs30:300},far={lat:36,lng:139.5,vs30:300};
  const pNear=Scorecard.predictStation(ev,near),pFar=Scorecard.predictStation(ev,far);
  for(const p of [pNear,pFar]){
    assert.ok(isFinite(p.pga)&&p.pga>0&&isFinite(p.pgv)&&p.pgv>0&&isFinite(p.intensity));
    assert.ok(p.rHypoKm>0);
  }
  assert.ok(pNear.pga>pFar.pga,'PGA decays with distance');
  assert.equal(pNear.model,'zhao2006'); // interplate auto-routing
  // Station vs30 amplifies relative to the reference-site base.
  const rock=Scorecard.predictStation(ev,{lat:38.5,lng:141.5,vs30:null});
  assert.ok(pNear.pga>rock.pga,'soft station amplifies vs reference');
});

test('scorecard applies gmpe calibration exactly like the forecast path',()=>{
  const ev=OBS.events.find(e=>e.eventId==='kumamoto2016');
  const st=ev.stations[0];
  Physics.setGmpeCalibration(null);
  const raw=Scorecard.predictStation(ev,st).intensity;
  const delta=-0.25;
  Physics.setGmpeCalibration({schema:'quake-sim-gmpe-calibration-v1',bins:[{minM:6.5,maxM:99,deltaI:delta}]});
  const shifted=Scorecard.predictStation(ev,st).intensity;
  assert.ok(Math.abs((shifted-raw)-delta)<1e-9,'calibrateIntensity(I, mag) additive shift');
  Physics.setGmpeCalibration(null);
});

test('scorecard report is deterministic',()=>{
  const a=Scorecard.computeReport(OBS,CAL),b=Scorecard.computeReport(OBS,CAL);
  assert.deepEqual(a,b);
  assert.equal(a.overall.pga.n,OBS.events.reduce((n,e)=>n+e.stations.length,0));
  assert.ok(a.overall.intensity.rms>0&&a.overall.distanceBins.length===5);
  assert.equal(a.correctionEvaluation.perEvent.length,OBS.events.length);
  Physics.setGmpeCalibration(null); // leave global state clean for other test files
});

test('JMA-hypocenter mode is the default and cites repo sources per event',()=>{
  const rep=Scorecard.computeReport(OBS,CAL);
  assert.equal(rep.hypocenterMode,'jma');
  for(const e of rep.events){
    const ph=e.predictionHypocenter;
    assert.equal(ph.mode,'jma',e.eventId);
    assert.ok(/^public\/(geojson\/observed\.json#|app\.js PRESETS\.)/.test(ph.source),e.eventId+' source: '+ph.source);
    assert.ok(ph.depthKm>0&&isFinite(ph.lat)&&isFinite(ph.lng)&&isFinite(ph.mw),e.eventId+' jma hypo');
    // The frozen USGS event metadata stays attached for provenance.
    const frozen=OBS.events.find(x=>x.eventId===e.eventId);
    assert.equal(ph.usgs.lat,frozen.lat);assert.equal(ph.usgs.depthKm,frozen.depthKm);
    assert.equal(ph.usgs.mw,frozen.mw);
  }
  // Spot-pin the JMA catalog values against the repo data itself.
  const jma=Scorecard.loadJmaHypocenters();
  const obsJson=JSON.parse(fs.readFileSync('public/geojson/observed.json','utf8'));
  assert.equal(jma.tokachi2003.depthKm,obsJson.tokachi2003.depth); // 42 km JMA vs 27 USGS
  assert.equal(jma.tokachi2003.mw,obsJson.tokachi2003.mw);
  assert.equal(jma.tohoku2011.depthKm,obsJson.tohoku.depth);
  const appSrc=fs.readFileSync('public/app.js','utf8');
  const m=appSrc.match(/fukushima2022:\{lat:([\d.]+),lng:([\d.]+),mag:([\d.]+),depth:([\d.]+)/);
  assert.ok(m,'PRESETS.fukushima2022 parseable');
  assert.equal(jma.fukushima2022.depthKm,Number(m[4])); // 63 km JMA vs 41 USGS
  assert.equal(jma.fukushima2022.mw,Number(m[3]));
  Physics.setGmpeCalibration(null);
});

test('--usgs-hypo mode reproduces the frozen-hypocenter numbers',()=>{
  const rep=Scorecard.computeReport(OBS,CAL,{hypoMode:'usgs'});
  assert.equal(rep.hypocenterMode,'usgs');
  for(const e of rep.events){
    const frozen=OBS.events.find(x=>x.eventId===e.eventId);
    assert.equal(e.predictionHypocenter.depthKm,frozen.depthKm);
    assert.equal(e.predictionHypocenter.mw,frozen.mw);
    assert.equal(e.predictionHypocenter.source,'frozen obs file (USGS)');
  }
  // Deterministic across calls.
  assert.deepEqual(rep,Scorecard.computeReport(OBS,CAL,{hypoMode:'usgs'}));
  Physics.setGmpeCalibration(null);
});

test('calibrateIntensity opts pass-through: absent opts keeps legacy magnitude-bin behavior',()=>{
  const table={schema:'quake-sim-gmpe-calibration-v1',bins:[{minM:6.5,maxM:99,deltaI:-0.25}],
    modelBias:{zhao2006:{distBins:[{minKm:0,maxKm:100,deltaI:-0.8}]}}};
  Physics.setGmpeCalibration(table);
  assert.equal(Physics.calibrateIntensity(3.0,7.0),2.75,'no opts: magnitude bin only, modelBias untouched');
  assert.equal(Physics.calibrateIntensity(3.0,7.0,{}),2.75,'empty opts: magnitude bin only');
  assert.equal(Physics.calibrateIntensity(3.0,7.0,{model:'zhao2006'}),2.75,'no distKm: distBins are no-ops');
  Physics.setGmpeCalibration(null);
});

test('calibrateIntensity model-keyed shift applies only to the named model',()=>{
  const table={schema:'quake-sim-gmpe-calibration-v1',bins:[{minM:6.5,maxM:99,deltaI:0}],
    modelBias:{zhao2006:{minM:7,distBins:[{minKm:0,maxKm:400,deltaI:-1},{minKm:400,maxKm:null,deltaI:-0.3}]}}};
  Physics.setGmpeCalibration(table);
  assert.equal(Physics.calibrateIntensity(3.0,7.2,{model:'zhao2006',distKm:150}),2.0,'zhao2006 in-range bin applies');
  assert.equal(Physics.calibrateIntensity(3.0,7.2,{model:'zhao2006',distKm:800}),2.7,'far bin applies');
  assert.equal(Physics.calibrateIntensity(3.0,7.2,{model:'si-midorikawa',distKm:150}),3.0,'other models untouched');
  assert.equal(Physics.calibrateIntensity(3.0,7.2,{model:'kanno2006',distKm:150}),3.0,'unnamed model untouched');
  assert.equal(Physics.calibrateIntensity(3.0,6.8,{model:'zhao2006',distKm:150}),3.0,'below minM gate: no correction');
  assert.equal(Physics.calibrateIntensity(3.0,9.5,{model:'zhao2006',distKm:150}),2.0,'no maxM gate: great events corrected');
  Physics.setGmpeCalibration(null);
});

test('calibrateIntensity modelBias: outside measured bins are no-ops, shift capped at 1.0, floored at 0',()=>{
  const table={schema:'quake-sim-gmpe-calibration-v1',bins:[{minM:6.5,maxM:99,deltaI:0}],
    modelBias:{zhao2006:{distBins:[{minKm:100,maxKm:200,deltaI:-5}]}}};
  Physics.setGmpeCalibration(table);
  assert.equal(Physics.calibrateIntensity(3.0,7.5,{model:'zhao2006',distKm:50}),3.0,'below measured range: no-op');
  assert.equal(Physics.calibrateIntensity(3.0,7.5,{model:'zhao2006',distKm:200}),3.0,'bin edge [minKm,maxKm): next range unmeasured -> no-op');
  assert.equal(Physics.calibrateIntensity(3.0,7.5,{model:'zhao2006',distKm:150}),Math.max(0,3.0-1.0),'|deltaI|>1 hard-capped at 1.0');
  assert.equal(Physics.calibrateIntensity(0.5,7.5,{model:'zhao2006',distKm:150}),0,'result floored at 0');
  // A table without modelBias ignores opts entirely.
  Physics.setGmpeCalibration({schema:'quake-sim-gmpe-calibration-v1',bins:[{minM:6.5,maxM:99,deltaI:-0.25}]});
  assert.equal(Physics.calibrateIntensity(3.0,7.5,{model:'zhao2006',distKm:150}),2.75);
  Physics.setGmpeCalibration(null);
});

test('shipped gmpe-calibration.json modelBias is clipped to measured biases and capped',()=>{
  assert.ok(CAL.modelBias&&CAL.modelBias.zhao2006,'modelBias block present');
  const mb=CAL.modelBias.zhao2006;
  for(const b of mb.distBins){
    assert.ok(Math.abs(b.deltaI)<=1.0,'cap 1.0: '+JSON.stringify(b));
    // deltaI = -(measured bin bias) rounded to 3 decimals at fit time,
    // i.e. clipped to the measured value within rounding.
    assert.ok(Math.abs(b.deltaI+b.measuredBias)<1e-3||Math.abs(b.deltaI)===1.0,'clipped to measured bias');
    assert.ok(b.stations>0,'measured bin has stations (no extrapolation)');
  }
  // End-to-end through the scorecard prediction: tokachi2003 with the JMA
  // hypocenter — a station at 200-400 km hypocentral shifts by the bin deltaI.
  const ev=OBS.events.find(e=>e.eventId==='tokachi2003');
  const jma=Scorecard.loadJmaHypocenters().tokachi2003;
  const evJma=Object.assign({},ev,{lat:jma.lat,lng:jma.lng,depthKm:jma.depthKm,mw:jma.mw});
  const st={lat:40.0,lng:141.0,vs30:600};
  const rawCal=JSON.parse(fs.readFileSync('public/geojson/gmpe-calibration.json','utf8'));
  delete rawCal.modelBias;
  Physics.setGmpeCalibration(rawCal);
  const raw=Scorecard.predictStation(evJma,st);
  assert.ok(raw.rHypoKm>=200&&raw.rHypoKm<400,'station lands in the 200-400 bin, got '+raw.rHypoKm.toFixed(1));
  Physics.setGmpeCalibration(CAL);
  const corr=Scorecard.predictStation(evJma,st);
  // 2026-08-17 re-fit against the faithful Zhao (2006): the 200-400 km
  // measured bias is -0.409 (was -1.0, cap-clipped, under the pre-paper
  // refit model) — the faithful model needs less than half the correction.
  assert.ok(Math.abs((corr.intensity-raw.intensity)-0.409)<1e-9,'200-400 km bin applies +0.409');
  Physics.setGmpeCalibration(null);
});

test('shipped gmpe-calibration.json si-midorikawa/kanno2006 modelBias blocks are clipped to measured biases and capped',()=>{
  for(const name of ['si-midorikawa','kanno2006']){
    assert.ok(CAL.modelBias&&CAL.modelBias[name],'modelBias.'+name+' block present');
    const mb=CAL.modelBias[name];
    assert.equal(mb.minM,7,name+' minM gate matches the fitted magnitude range');
    for(const b of mb.distBins){
      assert.ok(Math.abs(b.deltaI)<=1.0,'cap 1.0: '+JSON.stringify(b));
      // deltaI = -(measured bin bias) rounded to 3 decimals at fit time,
      // i.e. clipped to the measured value within rounding.
      assert.ok(Math.abs(b.deltaI+b.measuredBias)<1e-3||Math.abs(b.deltaI)===1.0,'clipped to measured bias: '+JSON.stringify(b));
      assert.ok(Math.abs(b.deltaI)<=Math.abs(b.measuredBias)+1e-3,'never over-corrects: '+JSON.stringify(b));
      assert.ok(b.deltaI*b.measuredBias<=0,'deltaI opposes the measured bias: '+JSON.stringify(b));
      assert.ok(b.stations>0,'measured bin has stations (no extrapolation)');
    }
  }
});

// R0-4 (2026-08-24): leave-one-event-out generalization of the modelBias
// layer. Structure and honesty of the report are asserted; the current
// frozen 6-event set genuinely degrades held-out RMS (documented in
// tools/data/model-bias-loeo-report.json), so the test pins the mechanism,
// not a wishful "improves" outcome.
test('buildModelBiasLoeo: fold structure, gates and finite held-out statistics',()=>{
  for(const model of ['zhao2006','si-midorikawa']){
    const r=Scorecard.buildModelBiasLoeo(OBS,CAL,model);
    assert.equal(r.schema,'quake-sim-model-bias-loeo-v1');
    assert.equal(r.model,model);
    assert.ok(r.events>=2,model+' needs at least two foldable events');
    assert.equal(r.folds.length,r.events,'one fold per fitted event');
    assert.ok(r.stations>500,model+' station pool');
    assert.ok(Array.isArray(r.deployedDistBins)&&r.deployedDistBins.length>0);
    for(const f of r.folds){
      assert.ok(f.stations>100,f.eventId+' fold station count');
      for(const k of ['rmsUncorrected','rmsHeldOutRefit','rmsDeployed']){
        assert.ok(Number.isFinite(f[k])&&f[k]>0&&f[k]<5,`${model}/${f.eventId} ${k}=${f[k]}`);
      }
    }
    assert.ok(Number.isFinite(r.rmsHeldOutLOO)&&Number.isFinite(r.rmsUncorrected));
    assert.equal(typeof r.heldOutWorseThanUncorrected,'boolean');
    assert.ok(/leave-one-out|generalize/.test(r.conclusion),model+' conclusion text: '+r.conclusion);
    // The gate must mirror the deployed table (magnitude minM=7).
    assert.equal(r.magnitudeGate.minM,7);
  }
});
