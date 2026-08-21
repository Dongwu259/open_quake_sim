'use strict';
const test=require('node:test');
const assert=require('node:assert');
const Physics=require('../public/physics');

test('NLSWE accepts an auditable analytic initial condition without an earthquake source',()=>{
  const nx=31,ny=7,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(y===0||y===ny-1?1:-10);
  const grid={origin:[0,0],res:0.001,nx,ny,data,meta:{quality:'verification'}};
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{initialState:cell=>({eta:cell.x<10?0.2:0}),manning:0,coriolis:false});
  assert.ok(solver);
  solver.advanceTo(10);
  assert.ok(solver.getDiagnostics().steps>0);
  assert.ok(Number.isFinite(solver.sampleState(0.003,0.015).eta));
});

test('rupture source-time functions are bounded and complete',()=>{
  for(const stf of ['half-cosine','triangle','brune','boxcar']){
    const patch={ruptureTime:2,riseTime:4,sourceTimeFunction:stf};
    assert.equal(Physics.rupturePatchFraction(patch,1),0);
    assert.equal(Physics.rupturePatchFraction(patch,6),1);
    assert.ok(Physics.rupturePatchFraction(patch,4)>0&&Physics.rupturePatchFraction(patch,4)<1);
  }
});

function dynamicSourceFixture(sourceTimeFunction){
  const nx=21,ny=17,data=new Array(nx*ny).fill(-2000);
  for(let y=0;y<ny;y++)data[y*nx+nx-1]=5;
  const grid={origin:[140,35],res:0.01,nx,ny,data,meta:{quality:'verification'}};
  const source=Physics.createSourceModel({lat:35.08,lng:140.10,mw:7.2,depth:10,
    strike:0,dip:20,rake:90,sourceType:'interplate',generateSubSources:true,
    faultOptions:{sourceTimeFunction,randomSeed:52}});
  // Isolate the source-time-function test from spatial rupture travel time.
  for(const patch of source.geometry.subs){
    patch.ruptureTime=0;
    patch.riseTime=10;
    patch.sourceTimeFunction=sourceTimeFunction;
  }
  source.geometry.maxRuptureTime=0;
  return {solver:Physics.createNonlinearTsunamiSolver(grid,source,{manning:0,coriolis:false}),source};
}

test('dynamic seabed source starts unloaded and follows the configured STF',()=>{
  const brune=dynamicSourceFixture('brune').solver;
  const boxcar=dynamicSourceFixture('boxcar').solver;
  assert.equal(brune.getDiagnostics().sourceFraction,0,
    'finite rupture must not be applied as a full instantaneous displacement');
  brune.advanceTo(2.5);
  boxcar.advanceTo(2.5);
  const bruneFraction=brune.getDiagnostics().sourceFraction;
  const boxcarFraction=boxcar.getDiagnostics().sourceFraction;
  assert.ok(bruneFraction>boxcarFraction,
    `Brune STF should release faster at t/T=0.25: ${bruneFraction} vs ${boxcarFraction}`);
  assert.ok(Math.abs(boxcarFraction-0.25)<1e-9,
    `boxcar cumulative STF should equal t/T, got ${boxcarFraction}`);
});

test('dynamic seabed source completes and is excluded from mass-drift diagnostics',()=>{
  const solver=dynamicSourceFixture('half-cosine').solver;
  solver.advanceTo(12);
  const d=solver.getDiagnostics();
  assert.ok(Math.abs(d.sourceFraction-1)<1e-12,`source did not complete: ${d.sourceFraction}`);
  assert.ok(Math.abs(d.sourceVolumeM3)>1,
    'the fixture must prescribe a measurable source-volume change');
  const waterChange=d.currentWaterVolumeM3-d.initialWaterVolumeM3;
  assert.ok(Math.abs((waterChange-d.sourceVolumeM3)-d.massResidualM3)<1e-6,
    'reported residual must remove the prescribed seabed source volume exactly');
  assert.ok(Math.abs(d.massResidualFraction)<1e-5,
    `source application should not be misclassified as numerical mass drift: ${d.massResidualFraction}`);
});

test('wet-bed dam break reproduces the Stoker (1957) middle state on the MUSCL path',()=>{
  const G=9.80665,hL=100,hR=50;
  // Exact SWE Riemann middle state (Toro 2001): rarefaction 2(cL-c*) = u*
  // matched to the right-shock Rankine-Hugoniot condition.
  const f=h=>2*(Math.sqrt(G*hL)-Math.sqrt(G*h))-(h-hR)*Math.sqrt(G*(h+hR)/(2*h*hR));
  let lo=hR+1e-9,hi=hL-1e-9;
  for(let i=0;i<100;i++){const m=(lo+hi)/2;if(f(m)>0)lo=m;else hi=m;}
  const hStar=(lo+hi)/2,uStar=2*(Math.sqrt(G*hL)-Math.sqrt(G*hStar));
  const nx=201,length=9000,grid={origin:[0,0],res:length/(nx-1)/111320,nx,ny:5,
    data:Array.from({length:nx*5},(_,i)=>((i%(nx)===0||i%(nx)===nx-1)||Math.floor(i/nx)===0||Math.floor(i/nx)===4)?1:-0.0001),
    meta:{quality:'verification'}};
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{initialState:cell=>cell.x*length/(nx-1)<4000
    ?{eta:100-cell.stillDepth}:{eta:50-cell.stillDepth}}, {manning:0,coriolis:false,boundary:'wall'});
  solver.advanceTo(30);
  const s=solver.sampleState(2*grid.res,Math.round(4200/length*(nx-1))*grid.res);
  assert.ok(s&&Math.abs(s.h-hStar)<1,'sampled middle-state depth '+s.h+' vs exact '+hStar);
  assert.ok(Math.abs(s.u-uStar)<0.5,'sampled middle-state velocity '+s.u+' vs exact '+uStar);
});
