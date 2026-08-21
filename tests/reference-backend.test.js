'use strict';
const test=require('node:test');
const assert=require('node:assert');
const Reference=require('../public/reference-backend');

test('CPU reference backend publishes explicit per-module tolerances',()=>{
  assert.equal(Reference.precision,'IEEE-754 binary64');
  for(const key of ['dc3d','moment','travelTime','jmaFilter','responseSpectrum','nlsweState','nlsweMass']){
    assert.ok(Reference.tolerances[key].absolute>=0&&Reference.tolerances[key].relative>=0);
  }
  assert.equal(Reference.compare('dc3d',1,1+1e-11).pass,true);
  assert.equal(Reference.compareArrays('nlsweState',[0,1],[0,1.1]).pass,false);
});
