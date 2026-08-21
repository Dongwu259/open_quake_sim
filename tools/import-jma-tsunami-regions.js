#!/usr/bin/env node
'use strict';

// Convert the official JMA AreaTsunami Shapefile into a browser-sized
// MultiLineString GeoJSON. No third-party GIS dependency is required.
// Source: https://www.data.jma.go.jp/developer/gis.html

const fs = require('fs');
const path = require('path');

const inputDir = path.resolve(process.argv[2] || '.tmp-jma-tsunami-gis');
const outputFile = path.resolve(process.argv[3] || 'public/geojson/jma_tsunami_forecast_areas.json');
const simplifyTolerance = Number(process.argv[4] || 0.004);

function findExtension(ext) {
  const name = fs.readdirSync(inputDir).find((entry) => entry.toLowerCase().endsWith(ext));
  if (!name) throw new Error(`Missing ${ext} file in ${inputDir}`);
  return path.join(inputDir, name);
}

function readDbf(file) {
  const data = fs.readFileSync(file);
  const count = data.readUInt32LE(4);
  const headerLength = data.readUInt16LE(8);
  const recordLength = data.readUInt16LE(10);
  const decoder = new TextDecoder('utf-8');
  const fields = [];
  let offset = 32;
  let recordOffset = 1;
  while (offset + 32 <= headerLength && data[offset] !== 0x0d) {
    const rawName = data.subarray(offset, offset + 11);
    const zero = rawName.indexOf(0);
    const name = rawName.subarray(0, zero < 0 ? 11 : zero).toString('ascii');
    const length = data[offset + 16];
    fields.push({ name, length, offset: recordOffset });
    recordOffset += length;
    offset += 32;
  }
  const rows = [];
  for (let i = 0; i < count; i++) {
    const base = headerLength + i * recordLength;
    if (data[base] === 0x2a) { rows.push(null); continue; }
    const row = {};
    for (const field of fields) {
      row[field.name] = decoder.decode(data.subarray(
        base + field.offset,
        base + field.offset + field.length
      )).replace(/\0/g, '').trim();
    }
    rows.push(row);
  }
  return rows;
}

function perpendicularDistanceSq(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) {
    const px = point[0] - start[0];
    const py = point[1] - start[1];
    return px * px + py * py;
  }
  const t = Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)
  ));
  const px = point[0] - (start[0] + t * dx);
  const py = point[1] - (start[1] + t * dy);
  return px * px + py * py;
}

function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const toleranceSq = tolerance * tolerance;
  while (stack.length) {
    const range = stack.pop();
    let maxDistance = toleranceSq;
    let maxIndex = -1;
    for (let i = range[0] + 1; i < range[1]; i++) {
      const distance = perpendicularDistanceSq(points[i], points[range[0]], points[range[1]]);
      if (distance > maxDistance) { maxDistance = distance; maxIndex = i; }
    }
    if (maxIndex >= 0) {
      keep[maxIndex] = 1;
      stack.push([range[0], maxIndex], [maxIndex, range[1]]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

function lineLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return length;
}

function roundCoordinate(value) {
  return Math.round(value * 1e5) / 1e5;
}

// The official JMA GIS ships the Diaoyu Islands group (Diaoyu Dao, Huangwei Yu,
// Chiwei Yu, Bei/Nan Xiaodao) as line parts of forecast area 802. They are
// Chinese territory and must not be shown as part of a Japanese tsunami
// forecast zone, so parts fully inside this box are dropped on import.
function isDiaoyuIslandsPart(points) {
  return points.length > 0 && points.every((point) =>
    point[0] >= 122.5 && point[0] <= 125.5 && point[1] >= 25.0 && point[1] <= 26.6);
}

function readShapefile(file, rows) {
  const data = fs.readFileSync(file);
  if (data.readInt32BE(0) !== 9994) throw new Error('Invalid Shapefile header');
  const type = data.readInt32LE(32);
  if (type !== 3) throw new Error(`Expected PolyLine Shapefile, received type ${type}`);
  const features = [];
  let offset = 100;
  let rowIndex = 0;
  let inputPoints = 0;
  let outputPoints = 0;
  while (offset + 8 <= data.length && rowIndex < rows.length) {
    const contentLength = data.readInt32BE(offset + 4) * 2;
    const contentOffset = offset + 8;
    const recordType = data.readInt32LE(contentOffset);
    const row = rows[rowIndex++];
    if (recordType === 3 && row && row.code && row.code !== '0') {
      const partCount = data.readInt32LE(contentOffset + 36);
      const pointCount = data.readInt32LE(contentOffset + 40);
      const partsOffset = contentOffset + 44;
      const pointsOffset = partsOffset + partCount * 4;
      const starts = [];
      for (let i = 0; i < partCount; i++) starts.push(data.readInt32LE(partsOffset + i * 4));
      starts.push(pointCount);
      const lines = [];
      inputPoints += pointCount;
      for (let part = 0; part < partCount; part++) {
        const points = [];
        for (let i = starts[part]; i < starts[part + 1]; i++) {
          const pointOffset = pointsOffset + i * 16;
          const lng = data.readDoubleLE(pointOffset);
          const lat = data.readDoubleLE(pointOffset + 8);
          if (Number.isFinite(lat) && Number.isFinite(lng)) points.push([lng, lat]);
        }
        // Sub-kilometre islets do not materially change regional warning display.
        if (points.length < 2 || lineLength(points) < 0.008) continue;
        if (isDiaoyuIslandsPart(points)) continue;
        const simplified = simplifyLine(points, simplifyTolerance)
          .map((point) => [roundCoordinate(point[0]), roundCoordinate(point[1])]);
        if (simplified.length >= 2) {
          lines.push(simplified);
          outputPoints += simplified.length;
        }
      }
      features.push({
        type: 'Feature',
        properties: {
          code: row.code.padStart(3, '0'),
          name: row.name,
          nameKana: row.namekana
        },
        geometry: { type: 'MultiLineString', coordinates: lines }
      });
    }
    offset += 8 + contentLength;
  }
  return { features, inputPoints, outputPoints };
}

const rows = readDbf(findExtension('.dbf'));
const converted = readShapefile(findExtension('.shp'), rows);
const output = {
  type: 'FeatureCollection',
  metadata: {
    dataset: 'JMA AreaTsunami GIS',
    source: 'Japan Meteorological Agency',
    sourceUrl: 'https://www.data.jma.go.jp/developer/gis.html',
    release: '2024-05-20',
    converted: new Date().toISOString().slice(0, 10),
    simplifyToleranceDegrees: simplifyTolerance,
    usageNote: 'Official forecast-area geometry; simulator forecasts remain non-operational.'
  },
  features: converted.features
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(output));
console.log(`Converted ${converted.features.length} JMA tsunami forecast areas`);
console.log(`Points: ${converted.inputPoints.toLocaleString()} -> ${converted.outputPoints.toLocaleString()}`);
console.log(`${outputFile}: ${(fs.statSync(outputFile).size / 1024 / 1024).toFixed(2)} MiB`);
