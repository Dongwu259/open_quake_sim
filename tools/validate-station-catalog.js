#!/usr/bin/env node
'use strict';

// Validate imported StationXML-derived catalogs before they are deployed.
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] || 'public/geojson/stations.json';
const input = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
if (Array.isArray(input)) {
  const ids = new Set();
  for (const station of input) {
    for (const key of ['id', 'lat', 'lng']) {
      if (station[key] === undefined || station[key] === null || station[key] === '') throw new Error(`Missing ${key}`);
    }
    if (ids.has(String(station.id))) throw new Error(`Duplicate station id: ${station.id}`);
    ids.add(String(station.id));
    if (!Number.isFinite(station.lat) || station.lat < -90 || station.lat > 90) throw new Error(`Invalid latitude: ${station.id}`);
    if (!Number.isFinite(station.lng) || station.lng < -180 || station.lng > 180) throw new Error(`Invalid longitude: ${station.id}`);
    if (station.vs30 !== undefined && (!Number.isFinite(station.vs30) || station.vs30 <= 0)) throw new Error(`Invalid Vs30: ${station.id}`);
    if (station.siteFactor !== undefined && (!Number.isFinite(station.siteFactor) || station.siteFactor <= 0)) throw new Error(`Invalid site factor: ${station.id}`);
  }
  console.log(`Station catalog valid: ${ids.size} stations (flat simulator catalog)`);
  process.exit(0);
}
if (input._schema !== 'quake-sim-station-catalog-v1' || !Array.isArray(input.stations)) {
  throw new Error('Expected quake-sim-station-catalog-v1 with stations[]');
}
const ids = new Set();
let channels = 0;
let responseChannels = 0;
for (const station of input.stations) {
  const required = ['id', 'network', 'station', 'lat', 'lng'];
  for (const key of required) if (station[key] === undefined || station[key] === null || station[key] === '') throw new Error(`Missing ${key}`);
  if (ids.has(String(station.id))) throw new Error(`Duplicate station id: ${station.id}`);
  ids.add(String(station.id));
  if (!Number.isFinite(station.lat) || station.lat < -90 || station.lat > 90) throw new Error(`Invalid latitude: ${station.id}`);
  if (!Number.isFinite(station.lng) || station.lng < -180 || station.lng > 180) throw new Error(`Invalid longitude: ${station.id}`);
  if (!Array.isArray(station.channels)) throw new Error(`channels[] missing: ${station.id}`);
  for (const channel of station.channels) {
    channels++;
    if (!channel.code) throw new Error(`Channel code missing: ${station.id}`);
    if (channel.sampleRateHz !== null && channel.sampleRateHz !== undefined && (!Number.isFinite(channel.sampleRateHz) || channel.sampleRateHz <= 0)) throw new Error(`Invalid sample rate: ${station.id}/${channel.code}`);
    if (channel.hasResponse) responseChannels++;
  }
}
if (!input._sourceSha256 || !/^[a-f0-9]{64}$/i.test(input._sourceSha256)) throw new Error('Missing source SHA-256 provenance');
if (!input._sourceUrl || !/^https?:\/\//i.test(input._sourceUrl)) console.warn('WARN: no public source URL; retain local provenance separately');
console.log(`Station catalog valid: ${ids.size} stations, ${channels} channels, ${responseChannels} with response metadata`);
