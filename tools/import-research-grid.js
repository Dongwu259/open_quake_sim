// Convert an ESRI ASCII grid into the compact browser terrain/Vs30 schema.
// Usage: node tools/import-research-grid.js terrain input.asc output.json --source ETOPO2022
const fs = require('fs');
const crypto = require('crypto');

const [kind, input, output, ...args] = process.argv.slice(2);
if (!['terrain', 'vs30'].includes(kind) || !input || !output) {
  console.error('Usage: node tools/import-research-grid.js <terrain|vs30> input.asc output.json [--source NAME] [--source-url URL] [--license TEXT] [--release-date YYYY-MM-DD] [--source-class CLASS]');
  process.exit(1);
}
function option(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const lines = fs.readFileSync(input, 'utf8').trim().split(/\r?\n/);
const header = {};
let cursor = 0;
while (cursor < lines.length && Object.keys(header).length < 6) {
  const parts = lines[cursor].trim().split(/\s+/);
  if (parts.length < 2 || !/^[a-z_]+$/i.test(parts[0])) break;
  header[parts[0].toLowerCase()] = Number(parts[1]);
  cursor++;
}
const nx = header.ncols, ny = header.nrows, res = header.cellsize;
const x0 = header.xllcorner != null ? header.xllcorner : header.xllcenter - res / 2;
const y0 = header.yllcorner != null ? header.yllcorner : header.yllcenter - res / 2;
if (!(nx > 0 && ny > 0 && res > 0 && isFinite(x0) && isFinite(y0))) throw new Error('Invalid ESRI ASCII header');

const rows = lines.slice(cursor).map((line) => line.trim().split(/\s+/).map(Number));
if (rows.length !== ny || rows.some((row) => row.length !== nx)) throw new Error('Grid dimensions do not match header');
const nodata = header.nodata_value;
const data = new Array(nx * ny);
let valid = 0, min = Infinity, max = -Infinity;
for (let fileY = 0; fileY < ny; fileY++) {
  const y = ny - 1 - fileY;
  for (let x = 0; x < nx; x++) {
    let value = rows[fileY][x];
    if (!isFinite(value) || value === nodata) value = null;
    if (kind === 'vs30' && value != null && value <= 0) value = null;
    data[y * nx + x] = value;
    if (value != null) { valid++; min = Math.min(min, value); max = Math.max(max, value); }
  }
}

const source = option('--source', kind === 'terrain' ? 'User-supplied DEM/bathymetry' : 'User-supplied Vs30 grid');
const sourceUrl = option('--source-url', '');
const license = option('--license', '');
const releaseDate = option('--release-date', '');
const verticalDatum = kind === 'terrain' ? option('--vertical-datum', '') : undefined;
const requestedResearchReady = args.includes('--research-ready');
const provenanceComplete = /^https?:\/\//i.test(sourceUrl) && !!license && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)
  && (kind !== 'terrain' || !!verticalDatum);
if (requestedResearchReady && !provenanceComplete) throw new Error('--research-ready requires --source-url, --license, --release-date, and terrain --vertical-datum');
const result = {
  origin: [x0 + res / 2, y0 + res / 2], res, nx, ny, data,
  meta: {
    schema: kind === 'terrain' ? 'quake-sim-terrain-grid-v1' : 'quake-sim-vs30-grid-v1',
    dataset: source,
    source,
    sourceUrl: sourceUrl || 'unrecorded',
    license: license || 'Unrecorded; research certification blocked',
    releaseDate: releaseDate || null,
    horizontalDatum: option('--horizontal-datum', 'EPSG:4326'),
    verticalDatum,
    vs30SourceClass: kind === 'vs30'
      ? option('--source-class', /J-SHIS/i.test(source) ? 'j-shis-grid' : 'external-grid')
      : undefined,
    quality: requestedResearchReady ? 'user-verified' : 'user-imported',
    researchReady: requestedResearchReady && provenanceComplete,
    continuousTopoBathy: kind === 'terrain' && args.includes('--continuous-topobathy'),
    sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'),
    processing: 'ESRI ASCII rows normalized south-to-north; nodata preserved as null; no CRS or vertical-datum transform inferred',
    resolutionDegrees: res,
    validCells: valid,
    imported: new Date().toISOString()
  }
};
if (kind === 'terrain') { result.minDepth = min; result.maxDepth = max; }
fs.writeFileSync(output, JSON.stringify(result));
console.log(`Wrote ${output}: ${nx}x${ny}, ${valid} valid cells, ${min}..${max}`);
