// Generate comprehensive station grid using coastline polygon
// Result: ~1,500-2,500 stations with uniform coverage across Japan
const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf');

const STATIONS_IN  = path.join(__dirname, 'public', 'geojson', 'stations.json');
const COASTLINE_IN = path.join(__dirname, 'public', 'geojson', 'coastline_50m.json');
const STATIONS_OUT = path.join(__dirname, 'public', 'geojson', 'stations.json');

const GRID_STEP = 0.12;  // ~13km resolution → ~2000 land stations
const MIN_REAL_DIST = 8; // keep infill >8km from real stations

function haversineDist(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Build a proper land polygon from coastline LineStrings
function buildLandPolygon(coastline) {
  const lines = [];
  for (const feat of coastline.features) {
    const coords = feat.geometry.coordinates;
    if (feat.geometry.type === 'LineString') {
      lines.push(turf.lineString(coords));
    } else if (feat.geometry.type === 'MultiLineString') {
      for (const line of coords) lines.push(turf.lineString(line));
    }
  }
  // Close open lines to form rings
  const rings = [];
  for (const line of lines) {
    const pts = line.geometry.coordinates;
    if (pts.length < 3) continue;
    // Check if already closed
    const first = pts[0], last = pts[pts.length - 1];
    const dist = Math.sqrt((first[0]-last[0])**2 + (first[1]-last[1])**2);
    if (dist > 0.1) continue; // skip open lines (they won't form polygons)
    // Convert to polygon
    try {
      const poly = turf.lineToPolygon(line);
      rings.push(poly);
    } catch(e) {}
  }
  if (rings.length === 0) return null;
  // Merge all rings into a single MultiPolygon
  return turf.union(...rings);
}

// ----- MAIN -----
console.log('Loading coastline...');
const coastline = JSON.parse(fs.readFileSync(COASTLINE_IN, 'utf8'));

console.log('Building land polygon from coastline...');
const landPoly = buildLandPolygon(coastline);
if (!landPoly) { console.log('Failed to build land polygon'); process.exit(1); }
console.log('  Land polygon built OK');

console.log('Loading existing stations...');
const origStations = JSON.parse(fs.readFileSync(STATIONS_IN, 'utf8'));
console.log(`  ${origStations.length} real city stations`);

// Load validation cities
const observedPath = path.join(__dirname, 'public', 'geojson', 'observed.json');
const observed = JSON.parse(fs.readFileSync(observedPath, 'utf8'));
const protectCities = new Set();
for (const preset in observed) {
  if (preset.startsWith('_')) continue;
  for (const city in observed[preset].obs || {}) protectCities.add(city);
}

// Keep all real city stations
const kept = origStations.map(s => ({ lat: s.lat, lng: s.lng, name: s.name }));

// Generate grid infill
console.log('Generating grid stations on land...');
const LAT_MIN = 24, LAT_MAX = 46, LNG_MIN = 122, LNG_MAX = 150;
let added = 0, checked = 0, ocean = 0;

for (let lat = LAT_MIN; lat <= LAT_MAX; lat += GRID_STEP) {
  for (let lng = LNG_MIN; lng <= LNG_MAX; lng += GRID_STEP) {
    const midLat = lat + GRID_STEP / 2;
    const midLng = lng + GRID_STEP / 2;
    checked++;
    // Quick bounding box: Japan's approximate extent
    if (midLat < 24 || midLat > 46 || midLng < 122 || midLng > 150) continue;
    // Check land
    try {
      if (!turf.booleanPointInPolygon(turf.point([midLng, midLat]), landPoly)) { ocean++; continue; }
    } catch(e) { ocean++; continue; }
    // Check distance to nearest real station
    let minD = Infinity;
    for (const s of origStations) {
      const d = haversineDist(midLat, midLng, s.lat, s.lng);
      if (d < minD) minD = d;
      if (d < MIN_REAL_DIST) break;
    }
    if (minD < MIN_REAL_DIST) continue; // already covered by real station
    kept.push({
      lat: parseFloat(midLat.toFixed(4)),
      lng: parseFloat(midLng.toFixed(4)),
      name: 'G' + Math.round(midLat * 100) + '_' + Math.round(midLng * 100)
    });
    added++;
  }
}
console.log(`  Checked: ${checked}, Ocean: ${ocean}, Added: ${added}`);

// Re-index
for (let i = 0; i < kept.length; i++) kept[i].id = i;

// Verify validation cities
const names = new Set(kept.map(s => s.name));
const missing = [...protectCities].filter(c => !names.has(c));
if (missing.length > 0) {
  console.log(`WARNING: ${missing.length} validation cities missing:`, missing.slice(0,5));
} else {
  console.log('All validation cities present');
}

fs.writeFileSync(STATIONS_OUT, JSON.stringify(kept));
console.log(`Done: ${kept.length} total (${origStations.length} real + ${added} grid)`);
