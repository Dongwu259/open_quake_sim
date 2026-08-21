#!/usr/bin/env node
'use strict';
// Tile one or more already-normalized grids into a multi-resolution package.
// Usage: node tools/build-grid-package.js terrain output/manifest.json coarse.json fine.json --tile-size 256 --source-url URL --license TEXT
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [kind,manifestPath,...rest]=process.argv.slice(2);const optionNames=new Set(['--tile-size','--source','--source-url','--license','--release-date','--crs','--vertical-datum']);
let firstOption=rest.findIndex(value=>optionNames.has(value));if(firstOption<0)firstOption=rest.length;const inputs=rest.slice(0,firstOption),args=rest.slice(firstOption);
function option(name,fallback){const i=args.indexOf(name);return i>=0&&args[i+1]?args[i+1]:fallback;}
if(!['terrain','vs30'].includes(kind)||!manifestPath||!inputs.length){console.error('Usage: node tools/build-grid-package.js <terrain|vs30> manifest.json grid.json [...] --tile-size 256 --source-url URL --license TEXT');process.exit(1);}
const tileSize=Math.max(16,Math.min(1024,Number(option('--tile-size','256'))||256)),manifestDir=path.dirname(path.resolve(manifestPath)),tileDirName=path.basename(manifestPath,'.json')+'-tiles',tileDir=path.join(manifestDir,tileDirName);fs.mkdirSync(tileDir,{recursive:true});
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const levels=inputs.map((input,index)=>{
  const grid=JSON.parse(fs.readFileSync(input,'utf8'));if(!grid||!Array.isArray(grid.data)||grid.data.length!==grid.nx*grid.ny)throw new Error('Invalid grid: '+input);
  const id='r'+String(grid.res).replace('.','p')+'-'+index,tiles=[];
  for(let y0=0;y0<grid.ny-1;y0+=tileSize-1)for(let x0=0;x0<grid.nx-1;x0+=tileSize-1){
    const nx=Math.min(tileSize,grid.nx-x0),ny=Math.min(tileSize,grid.ny-y0),data=[];
    for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(grid.data[(y0+y)*grid.nx+x0+x]);
    const tile={origin:[grid.origin[0]+x0*grid.res,grid.origin[1]+y0*grid.res],res:grid.res,nx,ny,data,meta:{packageLevel:id}};
    const file=`${id}-${x0}-${y0}.json`,encoded=JSON.stringify(tile);fs.writeFileSync(path.join(tileDir,file),encoded);
    tiles.push({path:tileDirName+'/'+file,bbox:[tile.origin[0],tile.origin[1],tile.origin[0]+grid.res*(nx-1),tile.origin[1]+grid.res*(ny-1)],nx,ny,sha256:hash(encoded)});
  }
  return {id,res:grid.res,bbox:[grid.origin[0],grid.origin[1],grid.origin[0]+grid.res*(grid.nx-1),grid.origin[1]+grid.res*(grid.ny-1)],tiles,inputSha256:hash(fs.readFileSync(input))};
}).sort((a,b)=>a.res-b.res);
const manifest={_schema:'quake-sim-grid-package-v1',kind,createdAt:new Date().toISOString(),meta:{dataset:option('--source','User-supplied multi-resolution '+kind),sourceUrl:option('--source-url',''),license:option('--license',''),releaseDate:option('--release-date',''),crs:option('--crs','EPSG:4326'),verticalDatum:kind==='terrain'?option('--vertical-datum',''):undefined,processing:'Normalized grids tiled with one-cell shared seams; loaded regions must have complete coverage'},levels};
fs.mkdirSync(manifestDir,{recursive:true});fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');console.log(`Wrote ${levels.length} levels and ${levels.reduce((n,l)=>n+l.tiles.length,0)} tiles to ${manifestPath}`);
