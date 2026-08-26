'use strict';
// v5.8 R5-4/R5-5 — tide offset, per-cell Manning roughness field, and
// per-subfault time-varying dtopo in the nonlinear SWE solver.
const test=require('node:test');
const assert=require('node:assert');
const Physics=require('../public/physics');
const DC3D=require('../public/dc3d.js');
global.DC3D=global.DC3D||DC3D;

function verificationGrid(depth){
  const nx=61,ny=25,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)
    data.push(y===0||y===ny-1?3:x>40&&x<46&&y>10&&y<15?2:-depth);
  return {origin:[140,34],res:0.02,nx,ny,data,meta:{quality:'verification'}};
}

test('tide offset raises the still level and pre-wets low land',()=>{
  const grid=verificationGrid(200);
  const base=Physics.createNonlinearTsunamiSolver(grid,null,{initialState:()=>({}),manning:0.025,coriolis:false});
  const tide=Physics.createNonlinearTsunamiSolver(grid,null,{initialState:()=>({}),manning:0.025,coriolis:false,tideOffsetM:1.5});
  assert.ok(base&&tide);
  // ocean column: depth grows by the tide
  const ocean=base.sampleState(34.2,140.5),oceanT=tide.sampleState(34.2,140.5);
  assert.ok(Math.abs((oceanT.h-ocean.h)-1.5)<1e-3,`ocean depth shift ${(oceanT.h-ocean.h)}`);
  // tide stays at rest exactly (well-balanced under a shifted datum)
  tide.advanceTo(900);
  let worst=0;
  for(let y=1;y<24;y++)for(let x=1;x<60;x++){
    const st=tide.sampleState(34+y*0.02,140+x*0.02);
    if(st&&st.h>0)worst=Math.max(worst,Math.abs(st.u),Math.abs(st.v));
  }
  assert.ok(worst<1e-6,`tide currents ${worst}`);
  const d=tide.getDiagnostics();
  assert.ok(d.tideOffsetM===1.5,'diagnostics carry the tide offset');
});

test('per-cell Manning field changes runup damping vs the scalar',()=>{
  const nx=81,ny=7,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(y===0||y===ny-1?3:-4+7*x/(nx-1));
  const grid={origin:[0,0],res:0.001,nx,ny,data,meta:{quality:'verification'}};
  // high roughness everywhere wet or inundated
  const field=new Float32Array(nx*ny).fill(0.08);
  const run=opt=>Physics.createNonlinearTsunamiSolver(grid,null,Object.assign(
    {manning:0.025,coriolis:false,initialState:cell=>({eta:cell.x<30?2:0})},opt));
  const uniform=run(null),rough=run({manningField:field});
  uniform.advanceTo(700);rough.advanceTo(700);
  const su=uniform.getSnapshot(1),sr=rough.getSnapshot(1);
  assert.ok(su.maxVelocity>0.05,'baseline flow missing');
  assert.ok(sr.maxVelocity<su.maxVelocity*0.95,
    `rough field did not damp flow (${sr.maxVelocity} vs ${su.maxVelocity})`);
  assert.ok(sr.inundatedAreaKm2<=su.inundatedAreaKm2*(1+1e-9),
    `rough field increased inundation (${sr.inundatedAreaKm2} vs ${su.inundatedAreaKm2})`);
  assert.ok(rough.getDiagnostics().manningField.mode==='per-cell','field diagnostics');
  // scalar run identical to a run without any field key
  const uniform2=run({manningField:null});
  uniform2.advanceTo(700);
  assert.equal(uniform2.getSnapshot(1).maxVelocity,su.maxVelocity);
});

function dtopoFixture(timing){
  const grid=verificationGrid(2000);
  const source=Physics.createSourceModel({lat:34.32,lng:140.35,mw:7.2,depth:12,
    strike:0,dip:20,rake:90,sourceType:'interplate',generateSubSources:true,
    faultOptions:{sourceTimeFunction:'half-cosine',randomSeed:7}});
  // stagger rupture times so per-patch and cumulative clearly differ mid-run
  const subs=source.geometry.subs;
  subs.forEach((sub,i)=>{sub.ruptureTime=6+3*i;sub.riseTime=4;sub.sourceTimeFunction='boxcar';});
  source.geometry.maxRuptureTime=6+3*(subs.length-1);
  const solver=Physics.createNonlinearTsunamiSolver(grid,source,{manning:0,coriolis:false,
    boundary:'wall',dtopoTiming:timing,dc3dFarFieldAggregation:false,
    horizontalSlopeCoupling:false});
  return {solver,source,grid};
}

test('per-patch dtopo converges to the same final uplift as cumulative timing',()=>{
  const a=dtopoFixture('cumulative'),b=dtopoFixture('per-patch');
  const tEnd=a.source.geometry.maxRuptureTime+40;
  a.solver.advanceTo(tEnd);b.solver.advanceTo(tEnd);
  // after all patches complete both modes have applied the full deformation
  const fa=a.solver.sampleState(34.3,140.4),fb=b.solver.sampleState(34.3,140.4);
  assert.ok(Math.abs(fa.eta-fb.eta)<0.02*Math.max(0.1,Math.abs(fa.eta)),
    `final surface differs: cumulative ${fa.eta} vs per-patch ${fb.eta}`);
  const da=a.solver.getDiagnostics(),db=b.solver.getDiagnostics();
  // both booked the same injected source volume (pure vertical DC3D, water
  // cells; the per-patch 1e-3 uz cutoff and reach box allow a small deficit)
  const va=da.sourceVolumeM3,vb=db.sourceVolumeM3;
  assert.ok(Math.abs(va-vb)<0.05*Math.max(Math.abs(va),1),
    `source volume mismatch: cumulative ${va} vs per-patch ${vb}`);
  assert.equal(db.dtopoTiming.mode,'per-patch');
  assert.ok(db.dtopoTiming.patches>0,'patch list built');
});

test('mid-rupture per-patch timing differs from the uniform cumulative scaling',()=>{
  const a=dtopoFixture('cumulative'),b=dtopoFixture('per-patch');
  const tMid=6+3*2+2; // inside patch #2-#3 window, many patches not yet ruptured
  a.solver.advanceTo(tMid);b.solver.advanceTo(tMid);
  const da=a.solver.getDiagnostics(),db=b.solver.getDiagnostics();
  // the two timings must genuinely differ mid-rupture (per-patch tracks each
  // patch's own window; cumulative scales the whole field by the released
  // moment fraction — with heterogeneous slip they diverge either way)
  assert.ok(Math.abs(db.sourceVolumeM3-da.sourceVolumeM3)>0.01*Math.max(da.sourceVolumeM3,1),
    `mid-rupture volumes unexpectedly equal: cumulative ${da.sourceVolumeM3} per-patch ${db.sourceVolumeM3}`);
  // and the run must remain numerically healthy
  assert.equal(db.nonFiniteCells,0);
  assert.ok(db.maxCfl<=db.cflLimit+1e-9);
});

test('default timing stays cumulative and byte-identical',()=>{
  const grid=verificationGrid(2000);
  const source=Physics.createSourceModel({lat:34.32,lng:140.35,mw:7.2,depth:12,
    strike:0,dip:20,rake:90,sourceType:'interplate',generateSubSources:true,
    faultOptions:{sourceTimeFunction:'half-cosine',randomSeed:7}});
  source.geometry.subs.forEach((sub,i)=>{sub.ruptureTime=6+3*i;sub.riseTime=4;sub.sourceTimeFunction='boxcar';});
  source.geometry.maxRuptureTime=6+3*(source.geometry.subs.length-1);
  const legacy=Physics.createNonlinearTsunamiSolver(grid,source,{manning:0,coriolis:false,boundary:'wall'});
  const explicit=Physics.createNonlinearTsunamiSolver(grid,source,{manning:0,coriolis:false,boundary:'wall',dtopoTiming:'cumulative'});
  legacy.advanceTo(30);explicit.advanceTo(30);
  assert.equal(legacy.dtopoTiming,'cumulative');
  const fl=legacy._fields(),fe=explicit._fields();
  for(let i=0;i<fl.h.length;i++)assert.equal(fl.h[i],fe.h[i],`legacy path diverged at ${i}`);
});
