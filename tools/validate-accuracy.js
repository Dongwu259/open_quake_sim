'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Physics = require('../public/physics.js');
const Research = require('../public/research.js');

const ROOT = path.resolve(__dirname, '..');
const observed = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/observed.json'), 'utf8'));
const stations = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/stations.json'), 'utf8'));
const jmaCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/jma_stations.json'), 'utf8'));
const config = require('../public/config.js').CFG_DEFAULTS;
const FiniteFault = require('../public/finite-fault.js');
// Optional bundle of observed finite-fault models (2011 Tohoku). When present,
// the finite-fault path predicts from the imported patch geometry, matching
// the browser preset behavior.
let ObservedFaultModels = null;
try { ObservedFaultModels = require('../public/observed-fault-models.js'); } catch { /* bundle absent */ }
const args = process.argv.slice(2);
const modelArg = args.find(v => v.startsWith('--model='));
const model = modelArg ? modelArg.slice(8) : 'auto';
const pathArg = args.find(v => v.startsWith('--path='));
const predictionPath = pathArg ? pathArg.slice(7) : 'finite-fault';
if (!['finite-fault', 'point-source'].includes(predictionPath)) throw new Error(`Unknown prediction path: ${predictionPath}`);
const jsonArg = args.find(v => v.startsWith('--json='));
const csvArg = args.find(v => v.startsWith('--csv='));
const vs30GridArg = args.find(v => v.startsWith('--vs30-grid='));
let vs30Grid = null;
if (vs30GridArg) {
  const file = path.resolve(vs30GridArg.slice('--vs30-grid='.length));
  vs30Grid = JSON.parse(fs.readFileSync(file, 'utf8'));
  const validation = Physics.validateResearchGrid(vs30Grid, 'vs30');
  if (!validation.valid) throw new Error(`Invalid Vs30 grid ${file}: ${validation.errors.join(', ')}`);
}

const stationByName = new Map();
const stationById = new Map();
for (const station of stations) {
  if (station.name && !stationByName.has(station.name)) stationByName.set(station.name, station);
  if (station.id != null) stationById.set(String(station.id), station);
}
for (const station of (jmaCatalog.stations || [])) {
  stationById.set(String(station.id), station);
  if (station.name && !stationByName.has(station.name)) stationByName.set(station.name, station);
}

function defaultValue(key) { return config[key].v; }
function score(value) { return Physics.shindoScore(value); }
function round(value, digits = 4) { return value == null ? null : Number(value.toFixed(digits)); }
function distanceBin(km) { return km < 50 ? '<50 km' : km < 100 ? '50-100 km' : km < 300 ? '100-300 km' : '>=300 km'; }
function magnitudeBin(mw) { return mw < 7 ? 'Mw<7' : mw < 8 ? '7<=Mw<8' : 'Mw>=8'; }
function vs30Class(source) {
  if (source === 'measured') return 'measured-station';
  if (source === 'j-shis-grid') return 'j-shis-grid';
  if (source === 'station' || source === 'station-estimate') return 'station-estimate';
  if (source === 'regional-zone') return 'regional-zone';
  if (source === 'fallback') return 'fallback';
  return 'external-grid';
}
function resolveVs30(station) {
  const stationSource = station.vs30Source || 'station-estimate';
  const externalLookup = vs30Grid ? (lat, lng) => {
    const value = Physics.lookupResearchGrid(vs30Grid, lat, lng);
    if (!(value > 0)) return null;
    return {value, source:vs30Grid.meta?.vs30SourceClass || (/J-SHIS/i.test(vs30Grid.meta?.dataset || '') ? 'j-shis-grid' : 'external-grid')};
  } : null;
  return Physics.lookupVs30Details(station.lat, station.lng, station.vs30, externalLookup, stationSource);
}
function observationDetails(raw, event) {
  const record = raw && typeof raw === 'object' ? raw : {intensity:raw};
  return {
    value:record.intensity,
    stationId:record.stationId == null ? null : String(record.stationId),
    quality:record.quality || (event.estimated === true ? 'estimated' : 'direct'),
    source:record.source || null
  };
}

const SHINDO_ORDER = new Map(['0','1','2','3','4','5-','5+','6-','6+','7'].map((value, index) => [value, index]));
function categoryMetrics(values) {
  const eligible = values.filter(row => row.classifiable);
  let exact = 0, withinOne = 0;
  for (const row of eligible) {
    const delta = Math.abs(SHINDO_ORDER.get(String(row.predictedShindo)) - SHINDO_ORDER.get(String(row.observedShindo)));
    if (delta === 0) exact++;
    if (delta <= 1) withinOne++;
  }
  return {count:eligible.length, exactRate:eligible.length ? round(exact / eligible.length) : null,
    withinOneRate:eligible.length ? round(withinOne / eligible.length) : null};
}

const splitByEvent = new Map();
const split = observed._validation;
for (const name of ['training', 'calibration', 'independent']) {
  for (const eventId of split[name] || []) {
    if (splitByEvent.has(eventId)) throw new Error(`Event ${eventId} appears in multiple validation splits`);
    splitByEvent.set(eventId, name);
  }
}

const eventIds = Object.keys(observed).filter(key => !key.startsWith('_'));
for (const eventId of eventIds) if (!splitByEvent.has(eventId)) throw new Error(`Event ${eventId} is missing from _validation`);
for (const eventId of splitByEvent.keys()) if (!observed[eventId]) throw new Error(`Validation split references unknown event ${eventId}`);

const rows = [];
for (const eventId of eventIds) {
  const event = observed[eventId];
  const mw = Number(event.mw || event.mag);
  const depth = Number(event.depth);
  const sourceType = event.src || Physics.sourceType(depth);
  if (predictionPath === 'finite-fault' && mw >= 6.5 && !Number.isFinite(Number(event.strike))) {
    throw new Error(`Finite-fault validation requires strike metadata: ${eventId}`);
  }
  // Events with a bundled observed finite-fault model (2011 Tohoku) predict
  // from the imported patch geometry, matching the browser preset behavior.
  let source = {lat:event.epi_lat,lng:event.epi_lng,mag:event.mag,mw,depthKm:depth,
    strikeDeg:Number(event.strike) || 0,dipDeg:Number(event.dip) || 90,sourceType};
  let geometry = null;
  if (predictionPath === 'finite-fault' && ObservedFaultModels && ObservedFaultModels.get(eventId)) {
    const imported = FiniteFault.parse(ObservedFaultModels.get(eventId));
    geometry = imported.geometry;
    source = {lat:imported.event.lat,lng:imported.event.lng,mag:imported.mw,mw:imported.mw,
      depthKm:imported.event.depthKm,strikeDeg:imported.representativePlane.strikeDeg,
      dipDeg:imported.representativePlane.dipDeg,sourceType:imported.event.sourceType || sourceType};
  }
  const context = Physics.createGroundMotionContext(source, {
    gmpModel:model,finiteFault:predictionPath === 'finite-fault',geometry,rupSpeed:defaultValue('rupSpeed'),
    attA:defaultValue('attA'),attB:defaultValue('attB'),attC:defaultValue('attC'),anelastic:defaultValue('anelastic'),
    siteModel:defaultValue('siteModel'),siteBase:defaultValue('siteBase'),siteSoftMax:defaultValue('siteSoftMax'),
    siteHardMin:defaultValue('siteHardMin'),siteNonlinear:defaultValue('siteNonlinear'),directivity:defaultValue('directivity'),
    faultOptions:{sourceType,randomSeed:defaultValue('randomSeed'),hypocenterFrac:defaultValue('hypocenterFrac'),
      slipPerturbation:defaultValue('slipPerturbation'),ruptureMode:defaultValue('ruptureMode')}
  });
  for (const [city, rawObservation] of Object.entries(event.obs || {})) {
    const observation = observationDetails(rawObservation, event);
    const observedShindo = observation.value;
    const station = (observation.stationId && stationById.get(observation.stationId)) || stationByName.get(city);
    if (!station) throw new Error(`Observed city has no station coordinate: ${eventId}/${city}`);
    const surfaceDistance = Physics.haversineDist(event.epi_lat, event.epi_lng, station.lat, station.lng);
    const vs30Details = resolveVs30(station);
    const motion = Physics.predictStationMotion(context, {...station, vs30:vs30Details.value}, {stationFactor:1});
    const predictedIntensity = Math.min(7, motion.intensity);
    const observedScore = score(observedShindo);
    rows.push({event:eventId, split:splitByEvent.get(eventId), estimated:observation.quality !== 'direct',
      observationQuality:observation.quality,observationSource:observation.source,city,stationId:station.id,
      stationMatch:observation.stationId ? (String(observation.stationId).startsWith('jma:') ? 'exact-jma-id' : 'exact-id') : 'city-name-proxy',
      sourceType, magnitudeBin:magnitudeBin(mw), distanceBin:distanceBin(surfaceDistance), mw,
      distanceKm:round(surfaceDistance, 2),predictionDistanceKm:round(motion.distanceKm,2),distanceMetric:motion.distanceMetric,
      vs30:round(vs30Details.value,2),vs30Source:vs30Details.source,vs30Class:vs30Class(vs30Details.source),model:motion.model,predictionPath,
      observedShindo, observedScore, predictedIntensity:round(predictedIntensity),
      predictedShindo:Physics.intensityToShindo(predictedIntensity), pgaGal:round(motion.pga, 3), pgvCms:round(motion.pgv, 4),
      classifiable:SHINDO_ORDER.has(String(observedShindo)),residual:round(predictedIntensity - observedScore)});
  }
}

function grouped(field) {
  const groups = {};
  for (const row of rows) (groups[row[field]] ||= []).push(row);
  return Object.fromEntries(Object.entries(groups).sort().map(([key, values]) => [key, cleanMetrics(values)]));
}
function cleanMetrics(values) {
  const metrics = Research.residualMetrics(values);
  return {...Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, round(value)])),
    categories:categoryMetrics(values)};
}
function eventWeightedMetrics(values) {
  const groups = new Map();
  for (const row of values) (groups.get(row.event) || (groups.set(row.event, []), groups.get(row.event))).push(row);
  const perEvent = [...groups.entries()].map(([event, eventRows]) => ({event,...cleanMetrics(eventRows)}));
  if (!perEvent.length) return {eventCount:0,stationCount:0,bias:null,rms:null,mae:null,events:[]};
  return {eventCount:perEvent.length,stationCount:values.length,
    bias:round(perEvent.reduce((sum, item) => sum + item.bias, 0) / perEvent.length),
    rms:round(Math.sqrt(perEvent.reduce((sum, item) => sum + item.rms * item.rms, 0) / perEvent.length)),
    mae:round(perEvent.reduce((sum, item) => sum + item.mae, 0) / perEvent.length),events:perEvent};
}

const directRows = rows.filter(row => !row.estimated);
const estimatedRows = rows.filter(row => row.estimated);
const independentRows = rows.filter(row => row.split === 'independent');
const independentDirectRows = independentRows.filter(row => !row.estimated);
const proxyDirectIndependentRows = independentDirectRows.filter(row => row.stationMatch === 'city-name-proxy');
const report = {
  schema:'quake-sim-accuracy-report-v2', createdAt:new Date().toISOString(),
  method:predictionPath === 'finite-fault' ? 'shared-finite-fault-station-motion-v1' : 'shared-point-source-station-motion-v1',
  limitation:'This deterministic non-browser report shares the browser median GMPE, finite-fault, Rrup and Vs30 path. It excludes UI station jitter and does not establish operational forecast accuracy.',
  model,predictionPath,vs30Grid:vs30Grid ? {
    dataset:vs30Grid.meta?.dataset || 'unlabelled', sourceClass:vs30Grid.meta?.vs30SourceClass || 'external-grid',
    resolutionDegrees:vs30Grid.res, researchReady:vs30Grid.meta?.researchReady === true
  } : null,splitDefinition:split,overall:cleanMetrics(rows),eventWeightedOverall:eventWeightedMetrics(rows),
  directObservations:cleanMetrics(directRows),directEventWeighted:eventWeightedMetrics(directRows),
  independentDirect:cleanMetrics(independentDirectRows),independentDirectEventWeighted:eventWeightedMetrics(independentDirectRows),
  estimatedReferences:cleanMetrics(estimatedRows),estimatedEventWeighted:eventWeightedMetrics(estimatedRows),
  bySplit:grouped('split'),byObservationQuality:grouped('observationQuality'),byStationMatch:grouped('stationMatch'),
  byVs30Source:grouped('vs30Source'),byVs30Class:grouped('vs30Class'),bySourceType:grouped('sourceType'),byMagnitude:grouped('magnitudeBin'),byDistance:grouped('distanceBin'),
  outliers:[...rows].sort((a,b) => Math.abs(b.residual)-Math.abs(a.residual)).slice(0,10), rows
};
const independentDirectEvents = new Set(independentDirectRows.map(row => row.event)).size;
const exactIndependentRows = independentDirectRows.filter(row => (row.stationMatch === 'exact-id' || row.stationMatch === 'exact-jma-id') && row.observationSource);
const exactIndependentEvents = new Set(exactIndependentRows.map(row => row.event)).size;
report.dataReadiness = {
  proxyDirectIndependentEvents:new Set(proxyDirectIndependentRows.map(row => row.event)).size,
  proxyDirectIndependentRecords:proxyDirectIndependentRows.length,
  exactIndependentEvents,exactIndependentRecords:exactIndependentRows.length,
  minimumEvents:5,minimumRecords:30,
  sufficient:exactIndependentEvents >= 5 && exactIndependentRows.length >= 30,
  note:'Research-readiness requires cited, exact-station observations from multiple held-out events. City proxies and estimated historical references do not count; JMA station records use the separate JMA catalog.'
};
report.releaseGate = {
  independentRmsMax:1.5,independentAbsoluteBiasMax:0.75,
  directOverallRmsMax:0.8,directOverallAbsoluteBiasMax:0.25,
  independentDirectRmsMax:1.2,independentDirectAbsoluteBiasMax:1.0,
  passed:report.bySplit.independent.rms <= 1.5 && Math.abs(report.bySplit.independent.bias) <= 0.75
    && report.directObservations.rms <= 0.8 && Math.abs(report.directObservations.bias) <= 0.25
    && report.independentDirect.rms <= 1.2 && Math.abs(report.independentDirect.bias) <= 1.0,
  note:'Release numerical non-regression guard. Data readiness is reported separately and this is not a scientific-accuracy acceptance threshold.'
};

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function writeCsv(file) {
  const fields = ['event','split','estimated','observationQuality','observationSource','stationMatch','city','stationId','sourceType','mw',
    'distanceKm','predictionDistanceKm','distanceMetric','distanceBin','vs30','vs30Source','vs30Class','model','predictionPath',
    'observedShindo','observedScore','predictedIntensity','predictedShindo','pgaGal','pgvCms','residual'];
  const content = [fields.join(','), ...rows.map(row => fields.map(field => csvEscape(row[field])).join(','))].join('\n') + '\n';
  fs.writeFileSync(path.resolve(file), content, 'utf8');
}

if (jsonArg) fs.writeFileSync(path.resolve(jsonArg.slice(7)), JSON.stringify(report, null, 2) + '\n', 'utf8');
if (csvArg) writeCsv(csvArg.slice(6));

console.log('Earthquake Simulator Pro - non-browser accuracy report');
console.log(`Method: ${report.method}; model=${model}; path=${predictionPath}; observations=${rows.length}; events=${eventIds.length}`);
console.log(`Vs30: ${report.vs30Grid ? `${report.vs30Grid.dataset} (${report.vs30Grid.sourceClass}, ${report.vs30Grid.resolutionDegrees} deg)` : 'bundled station estimates / regional fallback'}`);
console.log('Scope: shared deterministic station-motion path; browser display jitter and UI workflows are excluded.');
for (const [name, metrics] of Object.entries(report.bySplit)) {
  console.log(`${name.padEnd(11)} n=${String(metrics.count).padStart(3)} bias=${metrics.bias.toFixed(3)} RMS=${metrics.rms.toFixed(3)} MAE=${metrics.mae.toFixed(3)} P10/P50/P90=${metrics.p10.toFixed(3)}/${metrics.p50.toFixed(3)}/${metrics.p90.toFixed(3)}`);
}
console.log(`overall     n=${report.overall.count} bias=${report.overall.bias.toFixed(3)} RMS=${report.overall.rms.toFixed(3)} MAE=${report.overall.mae.toFixed(3)}`);
console.log(`event-equal events=${report.eventWeightedOverall.eventCount} bias=${report.eventWeightedOverall.bias.toFixed(3)} RMS=${report.eventWeightedOverall.rms.toFixed(3)} MAE=${report.eventWeightedOverall.mae.toFixed(3)}`);
console.log(`direct      n=${report.directObservations.count} bias=${report.directObservations.bias.toFixed(3)} RMS=${report.directObservations.rms.toFixed(3)} exact=${(report.directObservations.categories.exactRate*100).toFixed(1)}% within-one=${(report.directObservations.categories.withinOneRate*100).toFixed(1)}%`);
console.log(`data readiness ${report.dataReadiness.sufficient ? 'PASS' : 'INCOMPLETE'}: exact independent events=${exactIndependentEvents}/${report.dataReadiness.minimumEvents}, records=${exactIndependentRows.length}/${report.dataReadiness.minimumRecords}; proxy records=${proxyDirectIndependentRows.length}`);
console.log(`release gate ${report.releaseGate.passed ? 'PASS' : 'FAIL'}: independent RMS <= ${report.releaseGate.independentRmsMax}, |bias| <= ${report.releaseGate.independentAbsoluteBiasMax}; direct RMS <= ${report.releaseGate.directOverallRmsMax}`);
console.log(report.dataReadiness.sufficient
  ? 'Caution: passing the observation-count gate does not establish research-grade predictive accuracy; site, waveform, and instrument metadata limitations still apply.'
  : 'Warning: numerical fit must not be presented as research-grade accuracy until the direct independent dataset is sufficient.');
console.log('Largest absolute residuals:');
for (const row of report.outliers.slice(0,5)) console.log(`  ${row.event}/${row.city}: ${row.residual >= 0 ? '+' : ''}${row.residual.toFixed(3)} (${row.split}${row.estimated ? ', estimated' : ''})`);
if (!report.releaseGate.passed) process.exitCode = 1;
