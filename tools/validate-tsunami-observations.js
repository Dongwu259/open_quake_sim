#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),TsunamiValidation=require('../public/tsunami-validation.js');
const datasetPath=process.argv[2]||'public/geojson/historical_tsunami_observations.json',predictionPath=process.argv[3];
const dataset=JSON.parse(fs.readFileSync(path.resolve(datasetPath),'utf8')),validation=TsunamiValidation.validate(dataset);
if(!validation.valid){console.error(validation.errors.join('\n'));process.exit(1);}console.log(`Tsunami observations: ${validation.eventCount} events, ${validation.observationCount} points, ${validation.areaCount} forecast-area labels, researchReady=${validation.researchReady}`);
if(predictionPath){const predictions=JSON.parse(fs.readFileSync(path.resolve(predictionPath),'utf8')),report=TsunamiValidation.evaluate(dataset,predictions);console.log(JSON.stringify(report,null,2));}
