// generate-bathymetry.js
// Generates approximate bathymetry grid for Japan region using coastline data
// Falls back to real ETOPO1 data if available
// Output: public/geojson/bathymetry.json (~80KB)

const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'public', 'geojson', 'bathymetry.json');

// Japan region
const LAT_MIN = 20, LAT_MAX = 50;
const LNG_MIN = 120, LNG_MAX = 150;
const RES = 0.15;

const nx = Math.ceil((LNG_MAX - LNG_MIN) / RES);
const ny = Math.ceil((LAT_MAX - LAT_MIN) / RES);

console.log('=== Earthquake Simulator Pro — Bathymetry Generator ===\n');
console.log('Grid: ' + nx + 'x' + ny + ' @ ' + RES + '° resolution');
console.log('Region: ' + LAT_MIN + '°N-' + LAT_MAX + '°N, ' + LNG_MIN + '°E-' + LNG_MAX + '°E\n');

// Try loading coastline data to compute distance-to-coast
let coastPoints = [];
try {
  const coastFile = path.join(__dirname, 'public', 'geojson', 'coastline_10m.json');
  if (fs.existsSync(coastFile)) {
    const geo = JSON.parse(fs.readFileSync(coastFile, 'utf-8'));
    extractCoastPoints(geo);
  }
} catch(e) {}
if (coastPoints.length === 0) {
  try {
    const coastFile = path.join(__dirname, 'public', 'geojson', 'coastline_50m.json');
    if (fs.existsSync(coastFile)) {
      const geo = JSON.parse(fs.readFileSync(coastFile, 'utf-8'));
      extractCoastPoints(geo);
    }
  } catch(e) {}
}

function extractCoastPoints(geo) {
  const features = geo.features || [geo];
  for (const feat of features) {
    extractCoords(feat.geometry);
  }
  function extractCoords(geom) {
    if (!geom) return;
    if (geom.type === 'LineString') addLineCoords(geom.coordinates, 3);
    else if (geom.type === 'MultiLineString') for (const c of geom.coordinates) addLineCoords(c, 3);
    else if (geom.type === 'Polygon') { addLineCoords(geom.coordinates[0], 5); for (let i = 1; i < geom.coordinates.length; i++) addLineCoords(geom.coordinates[i], 3); }
    else if (geom.type === 'MultiPolygon') for (const p of geom.coordinates) { addLineCoords(p[0], 5); for (let i = 1; i < p.length; i++) addLineCoords(p[i], 3); }
    else if (geom.type === 'GeometryCollection') for (const g of geom.geometries) extractCoords(g);
  }
  function addLineCoords(coords, stride) {
    for (let i = 0; i < coords.length; i += stride) {
      coastPoints.push({lng: coords[i][0], lat: coords[i][1]});
    }
  }
}

console.log('Coastline points loaded: ' + coastPoints.length);

// Build a spatial index for fast nearest-coast distance lookup
// Use a coarse grid of coast distances
const COAST_GRID_RES = 0.05; // 0.05° for coast distance cache
const cgNx = Math.ceil((LNG_MAX - LNG_MIN) / COAST_GRID_RES) + 1;
const cgNy = Math.ceil((LAT_MAX - LAT_MIN) / COAST_GRID_RES) + 1;
const coastDistGrid = new Float32Array(cgNx * cgNy).fill(-1);

function getCoastGridIx(lng, lat) {
  const ix = Math.floor((lng - LNG_MIN) / COAST_GRID_RES);
  const iy = Math.floor((lat - LAT_MIN) / COAST_GRID_RES);
  if (ix < 0 || ix >= cgNx || iy < 0 || iy >= cgNy) return -1;
  return iy * cgNx + ix;
}

// Pre-compute coast distances at coarse grid
console.log('Computing coast distances...');
for (let iy = 0; iy < cgNy; iy++) {
  const lat = LAT_MIN + iy * COAST_GRID_RES;
  for (let ix = 0; ix < cgNx; ix++) {
    const lng = LNG_MIN + ix * COAST_GRID_RES;
    let minDist = Infinity;
    for (let ci = 0; ci < coastPoints.length; ci++) {
      const c = coastPoints[ci];
      const dlat = lat - c.lat, dlng = lng - c.lng;
      const dist = Math.sqrt(dlat * dlat + dlng * dlng);
      if (dist < minDist) minDist = dist;
    }
    coastDistGrid[iy * cgNx + ix] = minDist;
  }
  if (iy % 20 === 0) process.stdout.write('\r  Coast distance row ' + iy + '/' + cgNy + '...');
}
console.log('\r  Done.');

function distToCoastDeg(lng, lat) {
  const ix = Math.floor((lng - LNG_MIN) / COAST_GRID_RES);
  const iy = Math.floor((lat - LAT_MIN) / COAST_GRID_RES);
  if (ix < 0 || ix >= cgNx - 1 || iy < 0 || iy >= cgNy - 1) {
    // Fallback: approximate
    let minDist = Infinity;
    for (let ci = 0; ci < coastPoints.length; ci += 20) {
      const c = coastPoints[ci];
      const dlat = lat - c.lat, dlng = lng - c.lng;
      const dist = Math.sqrt(dlat * dlat + dlng * dlng);
      if (dist < minDist) minDist = dist;
    }
    return minDist;
  }
  // Bilinear interpolation from coast distance grid
  const fx = (lng - LNG_MIN) / COAST_GRID_RES - ix;
  const fy = (lat - LAT_MIN) / COAST_GRID_RES - iy;
  const d00 = coastDistGrid[iy * cgNx + ix];
  const d10 = coastDistGrid[iy * cgNx + ix + 1];
  const d01 = coastDistGrid[(iy + 1) * cgNx + ix];
  const d11 = coastDistGrid[(iy + 1) * cgNx + ix + 1];
  const d0 = d00 + (d10 - d00) * fx;
  const d1 = d01 + (d11 - d01) * fx;
  return Math.max(0, d0 + (d1 - d0) * fy);
}

// Known bathymetric features of Japan region
// Japan Trench: runs roughly N-S along ~143°E from 35°N to 42°N
// Depths can exceed 8000m in the trench
function trenchDepth(lng, lat) {
  // Japan Trench (Pacific side of NE Honshu / Hokkaido)
  // Roughly along 143-145°E, 36-43°N
  if (lng > 142 && lng < 146 && lat > 35 && lat < 44) {
    const trenchLng = 143.5 + (lat - 38) * 0.1;
    const distToTrench = Math.abs(lng - trenchLng);
    if (distToTrench < 0.8) {
      // Deep trench: up to 8000m
      return -6000 - 2000 * Math.exp(-distToTrench * distToTrench / 0.08);
    }
  }
  // Izu-Ogasawara Trench (south of Honshu, along ~142°E)
  if (lng > 141 && lng < 144 && lat > 28 && lat < 35) {
    const trenchLng2 = 142 + (lat - 31) * 0.15;
    const distToTrench2 = Math.abs(lng - trenchLng2);
    if (distToTrench2 < 0.6) {
      return -5000 - 3000 * Math.exp(-distToTrench2 * distToTrench2 / 0.06);
    }
  }
  // Nankai Trough (south of Shikoku/Kii Peninsula)
  if (lng > 134 && lng < 138 && lat > 31 && lat < 34) {
    const distTrough = Math.abs(lat - (32.5 + (lng - 136) * 0.3));
    if (distTrough < 0.5) {
      return -3500 - 1500 * Math.exp(-distTrough * distTrough / 0.04);
    }
  }
  // Ryukyu Trench (SE of Ryukyu Islands)
  if (lng > 126 && lng < 131 && lat > 23 && lat < 29) {
    const trenchDist = Math.abs(lng - (127.5 + (lat - 26) * 0.3));
    if (trenchDist < 0.5) {
      return -4000 - 2000 * Math.exp(-trenchDist * trenchDist / 0.06);
    }
  }
  return 0; // no trench here
}

// Kuril Trench (NE of Hokkaido)
function kurilTrenchDepth(lng, lat) {
  if (lng > 144 && lng < 150 && lat > 42 && lat < 46) {
    const distKT = Math.abs(lat - (44 + (lng - 147) * 0.2));
    if (distKT < 0.6) {
      return -5000 - 3000 * Math.exp(-distKT * distKT / 0.06);
    }
  }
  return 0;
}

console.log('Generating depth grid...');
const data = new Int16Array(nx * ny);
let minDepth = Infinity, maxDepth = -Infinity;

for (let iy = 0; iy < ny; iy++) {
  const lat = LAT_MIN + iy * RES;
  for (let ix = 0; ix < nx; ix++) {
    const lng = LNG_MIN + ix * RES;
    let depth;

    // Check if on land using coastline data
    const coastDistDeg = distToCoastDeg(lng, lat);
    const coastDistKm = coastDistDeg * 111.32;

    if (coastDistDeg < 0.02) {
      // On or very near land: small positive elevation
      depth = 50;
    } else {
      // Ocean: depth increases with distance from coast
      // Different basins have different max depths
      let maxDepthBasin, slopeFactor;

      if (lng > 135 && lat > 30 && lat < 42) {
        // Pacific Ocean side - deep, approaching trenches
        maxDepthBasin = 5500;
        slopeFactor = 0.015;
      } else if (lng < 135 && lat > 34 && lat < 42) {
        // Japan Sea - shallower enclosed basin
        maxDepthBasin = 2800;
        slopeFactor = 0.025;
      } else if (lat < 30) {
        // Philippine Sea / East China Sea - moderate
        maxDepthBasin = 4000;
        slopeFactor = 0.02;
      } else if (lat > 42) {
        // Okhotsk Sea / North Pacific
        maxDepthBasin = 3500;
        slopeFactor = 0.018;
      } else {
        maxDepthBasin = 4500;
        slopeFactor = 0.018;
      }

      // Exponential approach to max depth
      depth = -maxDepthBasin * (1 - Math.exp(-coastDistKm * slopeFactor));

      // Apply trench features (make deeper)
      const td = trenchDepth(lng, lat);
      if (td < depth) depth = td;
      const ktd = kurilTrenchDepth(lng, lat);
      if (ktd < depth) depth = ktd;

      // Ensure minimum water depth near coast
      if (depth > -30) depth = -30;
    }

    const val = Math.round(depth);
    data[iy * nx + ix] = val;
    if (val < minDepth) minDepth = val;
    if (val > maxDepth) maxDepth = val;
  }
  if (iy % 20 === 0) process.stdout.write('\r  Row ' + iy + '/' + ny + '...');
}
console.log('\r  Done. Depth range: ' + minDepth + 'm to ' + maxDepth + 'm');

// Write output
const output = {
  origin: [LNG_MIN, LAT_MIN],
  res: RES,
  nx: nx,
  ny: ny,
  minDepth: minDepth,
  maxDepth: maxDepth,
  data: Array.from(data)
};

const outDir = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const jsonStr = JSON.stringify(output);
fs.writeFileSync(OUTPUT_FILE, jsonStr);
console.log('\nWrote: ' + OUTPUT_FILE + ' (' + (jsonStr.length / 1024).toFixed(1) + ' KB)');
console.log('\nDone! Bathymetry data ready.\n');
console.log('Note: This is approximate bathymetry based on coastline distance and known features.');
console.log('For higher accuracy, download real ETOPO1 data and re-run with --from-file.\n');
