#!/usr/bin/env node
'use strict';

// Reproducible offline calibration for a cited first-motion catalogue.
// Usage: node tools/calibrate-polarity.js records.json reference.json [output.json]
const fs = require('fs');
const path = require('path');
const Physics = require('../public/physics.js');

const [recordsFile, referenceFile, outputFile] = process.argv.slice(2);
if (!recordsFile || !referenceFile) {
  console.error('Usage: node tools/calibrate-polarity.js records.json reference.json [output.json]');
  process.exit(2);
}
function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
const recordsDoc = readJson(recordsFile);
const reference = readJson(referenceFile);
const records = Array.isArray(recordsDoc) ? recordsDoc : (recordsDoc.records || recordsDoc.observations || recordsDoc.polarities);
if (!Array.isArray(records)) throw new TypeError('records.json must be an array or contain records/observations/polarities');
if (!reference.provenance || !reference.provenance.eventId || !/^https?:\/\//i.test(reference.provenance.url || '')) {
  throw new TypeError('reference.json must include provenance.eventId and an http(s) provenance.url');
}
const result = Physics.calibratePolarityRecords(records, reference, {
  takeoffConvention: reference.takeoffConvention || 'down',
  provenance: reference.provenance
});
const summary = {
  type: result.type,
  reference: result.reference,
  inputRecords: result.inputRecords,
  usedRecords: result.usedRecords,
  rejectedRecords: result.rejectedRecords,
  before: result.before,
  globalOffset: result.globalOffset,
  afterGlobal: result.afterGlobal,
  afterStationFlip: result.afterStationFlip,
  flippedStations: result.flippedStations,
  stationStats: result.stationStats,
  warning: result.warning,
  correctedRecords: result.correctedRecords
};
if (outputFile) fs.writeFileSync(path.resolve(outputFile), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  reference: result.reference.provenance,
  records: result.usedRecords + '/' + result.inputRecords,
  beforeFit: (100 * (1 - result.before.mismatchRate)).toFixed(2) + '%',
  afterGlobalFit: (100 * (1 - result.afterGlobal.mismatchRate)).toFixed(2) + '%',
  afterStationFlipFit: (100 * (1 - result.afterStationFlip.mismatchRate)).toFixed(2) + '%',
  globalOffset: result.globalOffset,
  flippedStations: result.flippedStations
}, null, 2));
