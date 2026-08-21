'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const GridPackage = require('../public/grid-package.js');

function manifest() { return {_schema:GridPackage.SCHEMA,kind:'terrain',meta:{dataset:'x',sourceUrl:'https://example.org',license:'open',crs:'EPSG:4326',processing:'test'},levels:[{id:'fine',res:1,tiles:[{path:'a.json',bbox:[0,0,1,1],nx:2,ny:2},{path:'b.json',bbox:[1,0,2,1],nx:2,ny:2}]},{id:'coarse',res:2,tiles:[{path:'c.json',bbox:[0,0,2,2],nx:2,ny:2}]}]}; }

test('grid package validates and selects a requested level', () => {
  assert.equal(GridPackage.validate(manifest()).valid,true);
  assert.equal(GridPackage.chooseLevel(manifest(),1).id,'fine');
  assert.equal(GridPackage.chooseLevel(manifest(),2).id,'coarse');
});

test('adjacent tiles merge without a duplicate seam', () => {
  const level=manifest().levels[0];
  const a={origin:[0,0],res:1,nx:2,ny:2,data:[1,2,3,4]};
  const b={origin:[1,0],res:1,nx:2,ny:2,data:[2,5,4,6]};
  const grid=GridPackage.merge(level,[a,b],[0,0,2,1],{dataset:'merged'});
  assert.deepEqual({origin:grid.origin,nx:grid.nx,ny:grid.ny,data:grid.data},{origin:[0,0],nx:3,ny:2,data:[1,2,5,3,4,6]});
});

test('tile selection only returns intersecting regional data', () => {
  const tiles=GridPackage.tilesForBounds(manifest().levels[0],[1.2,0,2,1]);
  assert.deepEqual(tiles.map(tile=>tile.path),['b.json']);
});
