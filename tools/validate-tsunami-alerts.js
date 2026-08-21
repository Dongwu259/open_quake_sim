'use strict';

// Regional sanity checks for the JMA AreaTsunami warning pipeline.  This is
// intentionally a deterministic Node harness, not a browser integration test.
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const ROOT = path.resolve(__dirname, '..');
const grid = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/bathymetry.json'), 'utf8'));
const geo = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/geojson/jma_tsunami_forecast_areas.json'), 'utf8'));

function buildAreas() {
  return geo.features.map(feature => {
    const code = String(feature.properties.code).padStart(3, '0');
    const candidates = feature.geometry.coordinates.flat();
    const seen = new Set();
    let controls = [];
    for (const coord of candidates) {
      const wet = Physics.findNearestWetCell(grid, coord[1], coord[0], 2);
      if (!wet || seen.has(wet.index)) continue;
      seen.add(wet.index);
      controls.push({lat:wet.lat, lng:wet.lng, coastLat:coord[1], coastLng:coord[0],
        waterDepth:wet.depth, areaCode:code});
    }
    if (controls.length > 80) {
      controls = Array.from({length:80}, (_, index) =>
        controls[Math.floor(index * controls.length / 80)]);
    }
    return {code, name:feature.properties.name, controls};
  });
}

const areas = buildAreas();
const controls = areas.flatMap(area => area.controls);
const areaByCode = Object.fromEntries(areas.map(area => [area.code, area]));

function nearestSourceArea(source) {
  let best = null;
  let bestDistance = Infinity;
  for (const point of controls) {
    const distance = Physics.haversineDist(source.lat, source.lng, point.coastLat, point.coastLng);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point.areaCode;
    }
  }
  return best;
}

function forecastScenario(scenario) {
  const source = Physics.createSourceModel(scenario);
  const sourceWet = Physics.findNearestWetCell(grid, source.lat, source.lng, 8);
  const sourceDepth = sourceWet ? sourceWet.depth : 4000;
  const sourceAreaCode = nearestSourceArea(source);
  const field = Physics.buildTsunamiTravelTimeField(grid, source.lat, source.lng, 600);
  const byArea = Object.create(null);
  for (const point of controls) {
    const directDistance = Physics.haversineDist(source.lat, source.lng, point.lat, point.lng);
    if (directDistance > 1200) continue;
    const meta = field.lookupMeta(point.lat, point.lng);
    if (!isFinite(meta.travelTime)) continue;
    const blocked = meta.detourRatio > 1.08;
    let height = Physics.tsunamiWaveContribution(source, Math.max(directDistance, meta.pathDistance),
      sourceDepth, 0.50, 3.30);
    height *= Physics.tsunamiPathAttenuation(meta.detourRatio, blocked);
    height *= Physics.jmaTsunamiBasinTransmission(sourceAreaCode, point.areaCode, directDistance);
    height *= Physics.greenLawAmplification(point.waterDepth, 10, 5);
    if (!byArea[point.areaCode] || height > byArea[point.areaCode]) byArea[point.areaCode] = height;
  }
  const warnings = Object.entries(byArea).map(([code, height]) => ({
    code, name:areaByCode[code].name, basin:Physics.jmaTsunamiAreaBasin(code), height,
    decision:Physics.jmaTsunamiForecast(height, 0, 1.35)
  })).filter(item => item.decision.level);
  warnings.sort((a, b) => b.decision.rank - a.decision.rank || b.height - a.height);
  return {sourceAreaCode, sourceBasin:Physics.jmaTsunamiAreaBasin(sourceAreaCode), warnings};
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const scenarios = [
  {name:'Pacific thrust Mw8.0', params:{lat:38,lng:143,mw:8,depth:20,strike:195,dip:15,rake:90,sourceType:'interplate'}},
  {name:'Japan Sea reverse Mw7.8', params:{lat:38,lng:137.3,mw:7.8,depth:15,strike:20,dip:35,rake:90,sourceType:'crustal'}},
  {name:'Pacific strike-slip Mw8.0', params:{lat:38,lng:143,mw:8,depth:20,strike:195,dip:90,rake:0,sourceType:'crustal'}},
  {name:'Pacific offshore Mw6.2', params:{lat:36,lng:142,mw:6.2,depth:25,strike:190,dip:20,rake:90,sourceType:'interplate'}},
  {name:'Manual Mw8.0 with optional mechanism untouched', params:{lat:38,lng:143,mw:8,depth:20,strike:0,dip:90,rake:0,sourceType:'interplate',mechanismKnown:false}}
];

for (const scenario of scenarios) {
  scenario.result = forecastScenario(scenario.params);
  const summary = scenario.result.warnings.map(item =>
    `${item.code}:${item.name}:${item.decision.level}:${item.height.toFixed(2)}m`).join(', ');
  console.log(`${scenario.name} [source ${scenario.result.sourceAreaCode}/${scenario.result.sourceBasin}]`);
  console.log(summary || '(no warning areas)');
}

const pacific = scenarios[0].result.warnings;
assert(pacific.some(item => ['210','220','250'].includes(item.code) && item.decision.rank >= 2),
  'Pacific Mw8 must warn at least one core Tohoku Pacific area');
assert(!pacific.some(item => ['230','240','340','341','350','360','361','370','500','520','540','550','551'].includes(item.code)
  && item.decision.rank >= 2), 'Pacific Mw8 must not issue warning/major for core Japan Sea areas');

const japanSea = scenarios[1].result.warnings;
assert(japanSea.some(item => ['340','341','350','360'].includes(item.code)),
  'Japan Sea Mw7.8 must affect a core Japan Sea area');
assert(!japanSea.some(item => ['210','220','250','300','310','380'].includes(item.code) && item.decision.rank >= 2),
  'Japan Sea Mw7.8 must not broadly warn core Honshu Pacific areas');

assert(scenarios[2].result.warnings.length === 0, 'pure strike-slip event must issue no tsunami areas');
assert(scenarios[3].result.warnings.filter(item => item.decision.rank >= 2).length === 0,
  'Mw6.2 event must not issue broad warning/major areas');
assert(scenarios[4].result.warnings.some(item => ['210','220','250'].includes(item.code)),
  'untouched optional rake must not suppress a large manual-event tsunami forecast');

console.log('Tsunami regional validation passed.');
