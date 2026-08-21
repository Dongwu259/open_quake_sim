#!/usr/bin/env node
'use strict';
// Merge licensed bathymetry and coastal elevation onto one explicit vertical datum.
// Usage: node tools/merge-research-grids.js bathy.json topo.json output.json --vertical-datum "TP/JGD2011"
const fs=require('node:fs');
const crypto=require('node:crypto');
const [bathyPath,topoPath,outputPath,...args]=process.argv.slice(2);
function option(name,fallback){const i=args.indexOf(name);return i>=0&&args[i+1]?args[i+1]:fallback;}
if(!bathyPath||!topoPath||!outputPath||!option('--vertical-datum','')){console.error('Usage: node tools/merge-research-grids.js bathy.json topo.json output.json --vertical-datum NAME [--source-url URL] [--license TEXT]');process.exit(1);}
const bathy=JSON.parse(fs.readFileSync(bathyPath,'utf8')),topo=JSON.parse(fs.readFileSync(topoPath,'utf8'));
function sample(grid,lat,lng){
  const col=(lng-grid.origin[0])/grid.res,row=(lat-grid.origin[1])/grid.res,x=Math.round(col),y=Math.round(row);
  if(x<0||x>=grid.nx||y<0||y>=grid.ny)return null;const value=grid.data[y*grid.nx+x];return Number.isFinite(value)?value:null;
}
if(!Array.isArray(bathy.data)||!Array.isArray(topo.data))throw new Error('Both inputs must use the quake-sim research-grid schema');
const data=bathy.data.slice();let replaced=0;
for(let y=0;y<bathy.ny;y++)for(let x=0;x<bathy.nx;x++){
  const lat=bathy.origin[1]+y*bathy.res,lng=bathy.origin[0]+x*bathy.res,value=sample(topo,lat,lng);
  if(value!=null&&value>=0){data[y*bathy.nx+x]=value;replaced++;}
}
if(!replaced)throw new Error('Topography does not overlap the target bathymetry or contains no non-negative land cells');
const sourceHash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const result={origin:bathy.origin,res:bathy.res,nx:bathy.nx,ny:bathy.ny,data:data,meta:{schema:'quake-sim-terrain-grid-v1',dataset:option('--source','Continuous GEBCO/ETOPO + GSI topo-bathymetry'),source:[bathy.meta&&bathy.meta.dataset||bathyPath,topo.meta&&topo.meta.dataset||topoPath].join(' + '),sourceUrl:option('--source-url','https://www.gebco.net/'),license:option('--license','Record GEBCO/ETOPO and GSI terms before research use'),horizontalDatum:option('--horizontal-datum','EPSG:4326'),verticalDatum:option('--vertical-datum',''),quality:option('--quality','user-verified'),continuousTopoBathy:true,processing:'Nearest-neighbour land elevation replacement on the bathymetry grid; no vertical-datum shift was inferred',inputSha256:{bathymetry:sourceHash(bathyPath),topography:sourceHash(topoPath)},landElevationCells:replaced,created:new Date().toISOString()}};
fs.writeFileSync(outputPath,JSON.stringify(result));
console.log(`Wrote ${outputPath}: ${result.nx}x${result.ny}, ${replaced} land cells, vertical datum ${result.meta.verticalDatum}`);
