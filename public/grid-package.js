(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ResearchGridPackage = api;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';
  var SCHEMA = 'quake-sim-grid-package-v1';

  function intersects(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
  function validate(manifest) {
    var errors = [], ids = Object.create(null), paths = Object.create(null);
    if (!manifest || manifest._schema !== SCHEMA) errors.push('unsupported-schema');
    if (!manifest || !['terrain','vs30'].includes(manifest.kind)) errors.push('invalid-kind');
    if (!manifest || !manifest.meta || !manifest.meta.dataset || !manifest.meta.sourceUrl || !manifest.meta.license || !manifest.meta.crs || !manifest.meta.processing) errors.push('incomplete-provenance');
    if (!manifest || !Array.isArray(manifest.levels) || !manifest.levels.length) errors.push('levels-missing');
    (manifest && manifest.levels || []).forEach(function(level) {
      if (!level.id || ids[level.id]) errors.push('duplicate-level'); ids[level.id] = true;
      if (!(Number(level.res) > 0) || !Array.isArray(level.tiles) || !level.tiles.length) errors.push('invalid-level-' + (level.id || '?'));
      (level.tiles || []).forEach(function(tile) {
        if (!tile.path || paths[tile.path]) errors.push('duplicate-tile-path'); paths[tile.path] = true;
        if (!Array.isArray(tile.bbox) || tile.bbox.length !== 4 || tile.bbox.some(function(value){return !isFinite(Number(value));})) errors.push('invalid-tile-bbox');
        if (!(tile.nx > 1 && tile.ny > 1)) errors.push('invalid-tile-shape');
      });
    });
    return {valid:errors.length === 0,errors:errors};
  }

  function chooseLevel(manifest, targetResolution) {
    var levels = (manifest.levels || []).slice().sort(function(a,b){return a.res-b.res;});
    if (!levels.length) return null;
    if (!(targetResolution > 0)) return levels[0];
    var selected = levels[0];
    for (var i=0;i<levels.length;i++) if (levels[i].res <= targetResolution) selected=levels[i];
    return selected;
  }

  function tilesForBounds(level, bbox) {
    return (level && level.tiles || []).filter(function(tile){return intersects(tile.bbox,bbox);});
  }

  function merge(level, tilePayloads, bbox, meta) {
    if (!level || !tilePayloads || !tilePayloads.length) return null;
    var res=Number(level.res), minLng=Infinity,minLat=Infinity,maxLng=-Infinity,maxLat=-Infinity;
    tilePayloads.forEach(function(grid){
      minLng=Math.min(minLng,grid.origin[0]);minLat=Math.min(minLat,grid.origin[1]);
      maxLng=Math.max(maxLng,grid.origin[0]+res*(grid.nx-1));maxLat=Math.max(maxLat,grid.origin[1]+res*(grid.ny-1));
    });
    if (bbox) {minLng=Math.max(minLng,bbox[0]);minLat=Math.max(minLat,bbox[1]);maxLng=Math.min(maxLng,bbox[2]);maxLat=Math.min(maxLat,bbox[3]);}
    var origin=[Math.ceil(minLng/res-1e-9)*res,Math.ceil(minLat/res-1e-9)*res];
    // JavaScript preserves a signed zero; normalize it so serialized package
    // coordinates and exact reproducibility checks remain canonical.
    if(Object.is(origin[0],-0))origin[0]=0;if(Object.is(origin[1],-0))origin[1]=0;
    var nx=Math.floor((maxLng-origin[0])/res+1e-9)+1,ny=Math.floor((maxLat-origin[1])/res+1e-9)+1;
    if(nx<2||ny<2)return null;
    var data=new Array(nx*ny).fill(null);
    tilePayloads.forEach(function(grid){
      for(var y=0;y<grid.ny;y++)for(var x=0;x<grid.nx;x++){
        var gx=Math.round((grid.origin[0]+x*res-origin[0])/res),gy=Math.round((grid.origin[1]+y*res-origin[1])/res);
        if(gx>=0&&gx<nx&&gy>=0&&gy<ny)data[gy*nx+gx]=grid.data[y*grid.nx+x];
      }
    });
    return {origin:origin,res:res,nx:nx,ny:ny,data:data,meta:Object.assign({},meta||{},{packageLevel:level.id,loadedTiles:tilePayloads.length})};
  }

  async function loadBounds(manifestUrl, bbox, targetResolution, fetcher) {
    fetcher=fetcher||fetch;
    var response=await fetcher(manifestUrl);if(!response.ok)throw new Error('grid package manifest HTTP '+response.status);
    var manifest=await response.json(),validation=validate(manifest);if(!validation.valid)throw new Error(validation.errors.join(', '));
    var level=chooseLevel(manifest,targetResolution),tiles=tilesForBounds(level,bbox),base=manifestUrl.replace(/[^/]*$/,'');
    if(!tiles.length)throw new Error('no grid tiles cover the requested bounds');
    var payloads=await Promise.all(tiles.map(async function(tile){var r=await fetcher(base+tile.path);if(!r.ok)throw new Error('grid tile HTTP '+r.status+': '+tile.path);return r.json();}));
    var grid=merge(level,payloads,bbox,manifest.meta);if(!grid||grid.data.some(function(value){return value==null||!isFinite(value);}))throw new Error('requested grid bounds contain gaps');
    return {manifest:manifest,level:level,tiles:tiles,grid:grid};
  }

  return {SCHEMA:SCHEMA,validate:validate,chooseLevel:chooseLevel,tilesForBounds:tilesForBounds,merge:merge,loadBounds:loadBounds};
});
