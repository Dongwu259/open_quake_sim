// Rebuild the bundled demonstration terrain with an explicit Japan land mask.
// Water depths remain synthetic; land elevations are coastal-distance estimates.
const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf');

const root = path.join(__dirname, '..');
const bathyPath = path.join(root, 'public', 'geojson', 'bathymetry.json');
const landPath = path.join(root, 'public', 'geojson', 'japan_prefectures.geojson');
const grid = JSON.parse(fs.readFileSync(bathyPath, 'utf8'));
const land = JSON.parse(fs.readFileSync(landPath, 'utf8'));
const features = land.features.map((feature) => ({ feature, bbox: turf.bbox(feature) }));

const boundaryBins = new Map();
const binSize = 0.5;
function addBoundaryPoint(lng, lat) {
  const key = Math.floor(lng / binSize) + ',' + Math.floor(lat / binSize);
  if (!boundaryBins.has(key)) boundaryBins.set(key, []);
  boundaryBins.get(key).push([lng, lat]);
}
function visitRings(geometry) {
  if (!geometry) return;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const stride = Math.max(1, Math.floor(ring.length / 250));
      for (let i = 0; i < ring.length; i += stride) addBoundaryPoint(ring[i][0], ring[i][1]);
    }
  }
}
for (const item of features) visitRings(item.feature.geometry);

function isLand(lng, lat) {
  const point = turf.point([lng, lat]);
  for (const item of features) {
    const b = item.bbox;
    if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
    if (turf.booleanPointInPolygon(point, item.feature)) return true;
  }
  return false;
}

function coastDistanceKm(lng, lat) {
  const bx = Math.floor(lng / binSize), by = Math.floor(lat / binSize);
  let best = Infinity;
  for (let radius = 0; radius <= 4 && !isFinite(best); radius++) {
    for (let y = by - radius; y <= by + radius; y++) {
      for (let x = bx - radius; x <= bx + radius; x++) {
        const pts = boundaryBins.get(x + ',' + y);
        if (!pts) continue;
        for (const p of pts) {
          const dy = (lat - p[1]) * 111.32;
          const dx = (lng - p[0]) * 111.32 * Math.cos(lat * Math.PI / 180);
          best = Math.min(best, Math.sqrt(dx * dx + dy * dy));
        }
      }
    }
  }
  return isFinite(best) ? best : 20;
}

let landCells = 0, waterCells = 0, min = Infinity, max = -Infinity;
for (let y = 0; y < grid.ny; y++) {
  const lat = grid.origin[1] + y * grid.res;
  for (let x = 0; x < grid.nx; x++) {
    const lng = grid.origin[0] + x * grid.res;
    const idx = y * grid.nx + x;
    if (isLand(lng, lat)) {
      const distance = coastDistanceKm(lng, lat);
      // Screening DEM only: the first coarse coastal band represents the
      // intertidal floodplain; elevations then rise progressively inland.
      grid.data[idx] = distance <= 15 ? 0
        : Math.round(Math.min(1800, 2 + 5.5 * Math.pow(distance - 15, 1.12)));
      landCells++;
    } else {
      if (grid.data[idx] >= 0) grid.data[idx] = -30;
      waterCells++;
    }
    min = Math.min(min, grid.data[idx]);
    max = Math.max(max, grid.data[idx]);
  }
}

grid.minDepth = min;
grid.maxDepth = max;
grid.meta = {
  schema: 'quake-sim-terrain-grid-v1',
  dataset: 'Japan synthetic research-demonstration terrain',
  source: 'Synthetic offshore-depth model + Natural Earth-derived Japan prefecture land mask',
  license: 'Project demonstration data; not GEBCO, ETOPO, GSI or J-SHIS',
  verticalDatum: 'Approximate mean sea level',
  horizontalDatum: 'WGS84',
  resolutionDegrees: grid.res,
  quality: 'demonstration',
  suitableFor: ['regional propagation demonstration', 'software verification'],
  notSuitableFor: ['operational warning', 'site-specific run-up', 'engineering inundation'],
  generated: new Date().toISOString().slice(0, 10),
  landCells,
  waterCells
};

fs.writeFileSync(bathyPath, JSON.stringify(grid));
console.log(`Rebuilt ${grid.nx}x${grid.ny} terrain: ${landCells} land, ${waterCells} water, ${min}..${max} m`);
