const test = require('node:test');
const assert = require('node:assert/strict');
const MT = require('../public/moment-tensor.js');
const Physics = require('../public/physics.js');

test('normalizes NED tensor components and preserves provenance', () => {
  const out = MT.parse({source:'F-net', eventId:'abc', tensor:{xx:2,yy:-1,zz:-1,xy:0,xz:0,yz:0}, units:'Nm'});
  assert.equal(out.tensor.xx, 2);
  assert.equal(out.provenance.source, 'F-net');
  assert.equal(out.provenance.eventId, 'abc');
});

test('USGS RTP tensor converts to NED', () => {
  const out = MT.parseUSGS({properties:{code:'us1', products:{'moment-tensor':[{
    properties:{tensor:{Mrr:3,Mtt:2,Mpp:1,Mrt:4,Mrp:5,Mtp:6},'tensor-unit':'dyne-cm'}
  }]}}});
  assert.deepEqual(out.tensor, {xx:2e-7,yy:1e-7,zz:3e-7,xy:-6e-7,xz:4e-7,yz:-5e-7});
  assert.equal(out.provenance.coordinateSystemOriginal, 'RTP');
  assert.equal(out.provenance.coordinateSystem, 'NED');
});

test('QuakeML scalar moment and tensor parse', () => {
  const xml='<event publicID="smi:local/e1"><Mrr>1</Mrr><Mtt>-1</Mtt><Mpp>0</Mpp><Mrt>0</Mrt><Mrp>0</Mrp><Mtp>0</Mtp><scalarMoment>1e18</scalarMoment></event>';
  const out=MT.parseQuakeML(xml);
  assert.equal(out.tensor.xx, -1);
  assert.equal(out.momentNm, 1e18);
  assert.equal(out.provenance.eventId, 'smi:local/e1');
});

test('observed tensor produces renderer-compatible focal mechanism', () => {
  const imported=MT.parse({tensor:{xx:1,yy:0,zz:-1,xy:0,xz:0,yz:0},source:'GCMT',units:'Nm'});
  const fm=Physics.focalMechanismFromTensor(imported);
  assert.equal(fm.type, 'observed-moment-tensor');
  assert.ok(fm.axes.P && fm.axes.T && fm.plane1 && fm.plane2);
  assert.equal(fm.provenance.source, 'GCMT');
});

test('tensor-derived scalar moment uses the symmetric-tensor norm convention', () => {
  const moment=3e18;
  const generated=Physics.focalMechanism({strike:25,dip:40,rake:75,momentNm:moment});
  const observed=Physics.focalMechanismFromTensor({tensor:generated.tensor});
  assert.ok(Math.abs(observed.momentNm/moment-1)<1e-12);
});

test('rejects missing components instead of silently replacing them with zero', () => {
  assert.throws(() => MT.parse({tensor:{xx:1,yy:-1,zz:0},units:'Nm'}), /Missing tensor components/);
});

test('rejects unknown coordinate systems and ambiguous units', () => {
  const tensor={xx:1,yy:-1,zz:0,xy:0,xz:0,yz:0};
  assert.throws(() => MT.parse({tensor,coordinateSystem:'XYZ',units:'Nm'}), /coordinate system/);
  assert.throws(() => MT.parse({tensor,coordinateSystem:'NED',units:'counts'}), /units/);
  assert.throws(() => MT.parse({tensor,coordinateSystem:'NED'}), /units/);
});

test('quality report records provenance gaps without rejecting a valid tensor', () => {
  const out=MT.parse({tensor:{xx:1,yy:-1,zz:0,xy:0,xz:0,yz:0},units:'Nm'});
  assert.equal(out.quality.valid,true);
  assert.equal(out.quality.grade,'B');
  assert.ok(out.quality.warnings.includes('event_id_missing'));
});

test('DC, CLVD and ISO decomposition percentages are physically distinct', () => {
  const dc=Physics.focalMechanismFromTensor({tensor:{xx:-1,yy:0,zz:1,xy:0,xz:0,yz:0}}).decomposition;
  const clvd=Physics.focalMechanismFromTensor({tensor:{xx:-0.5,yy:-0.5,zz:1,xy:0,xz:0,yz:0}}).decomposition;
  const iso=Physics.focalMechanismFromTensor({tensor:{xx:1,yy:1,zz:1,xy:0,xz:0,yz:0}}).decomposition;
  assert.ok(dc.dcFraction>0.999&&dc.clvdFraction<1e-9);
  assert.ok(clvd.clvdFraction>0.999&&clvd.dcFraction<1e-9);
  assert.ok(iso.isoFraction>0.999&&iso.deviatoricFraction<1e-9);
});

test('component uncertainty produces bounded axis and plane uncertainty', () => {
  const raw={xx:-1,yy:0,zz:1,xy:0,xz:0,yz:0};
  const imported=MT.normalizeTensor(raw,{coordinateSystem:'NED',units:'Nm',uncertainty:{xx:.01,yy:.01,zz:.01,xy:.01,xz:.01,yz:.01},provenance:{source:'lab',eventId:'u1'}});
  const fm=Physics.focalMechanismFromTensor(imported);
  assert.ok(fm.uncertainty.planeDeg>0&&fm.uncertainty.planeDeg<10);
});
