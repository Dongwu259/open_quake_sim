'use strict';
const test = require('node:test');
const assert = require('node:assert');
const DC3D = require('../public/dc3d');

test('DC3D surface displacement matches the frozen GeoClaw vertical benchmark', () => {
  const result=DC3D.surfaceDisplacement({x:1,y:-2,depth:10,dip:20,al1:-5,al2:5,aw1:-3,aw2:3,dipSlip:2});
  assert.equal(result.success,0);
  assert.ok(Math.abs(result.uz-0.07142811222892093)<1e-12);
});

test('DC3D is linear in dislocation and finite in the far field', () => {
  const input={x:3,y:-2,depth:8,dip:30,al1:-6,al2:6,aw1:-4,aw2:4,dipSlip:1};
  const one=DC3D.surfaceDisplacement(input),two=DC3D.surfaceDisplacement({...input,dipSlip:2});
  for(const component of ['ux','uy','uz'])assert.ok(Math.abs(two[component]-2*one[component])<1e-13);
  const far=DC3D.surfaceDisplacement({...input,x:1e6,y:1e6});
  assert.ok(Math.hypot(far.ux,far.uy,far.uz)<1e-10);
});
