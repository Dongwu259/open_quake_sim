#!/usr/bin/env node
'use strict';
// Freeze already response-corrected quake-sim-waveform-v1 files into one event package.
// The metadata JSON explicitly maps files to K-NET/KiK-net sites; nothing is inferred.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const StrongMotionData=require('../public/strong-motion-data.js');
const [metadataPath,outputPath]=process.argv.slice(2);if(!metadataPath||!outputPath){console.error('Usage: node tools/build-strong-motion-event.js metadata.json output.json');process.exit(1);}
const metadata=JSON.parse(fs.readFileSync(metadataPath,'utf8')),base=path.dirname(path.resolve(metadataPath));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const records=(metadata.records||[]).map(function(record){const file=path.resolve(base,record.file),waveform=JSON.parse(fs.readFileSync(file,'utf8'));return {stationId:record.stationId,siteId:record.siteId,locationType:record.locationType,sensorDepthM:record.sensorDepthM||0,station:record.station,waveform,inputFile:path.basename(file),inputSha256:sha(file)};});
const payload={_schema:StrongMotionData.SCHEMA,event:metadata.event,provenance:metadata.provenance,quality:{frozen:true,requireSurfaceBoreholePairs:metadata.requireSurfaceBoreholePairs!==false,metadataSha256:sha(metadataPath)},records};
const validation=StrongMotionData.validate(payload);if(!validation.valid)throw new Error(validation.errors.join(', '));fs.writeFileSync(outputPath,JSON.stringify(payload));
console.log(`Wrote ${records.length} records and ${validation.pairs.length} surface/borehole pairs to ${outputPath}; researchReady=${validation.researchReady}`);
