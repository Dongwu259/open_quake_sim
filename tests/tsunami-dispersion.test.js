'use strict';
// v5.8 R5-2 — Peregrine-type Boussinesq dispersion (optional solver topology).
//
// The correction reproduces the standard-Boussinesq [0,2] Padé dispersion
//   c² = gh / (1 + (kh)²/3)
// via a scalar Helmholtz solve on ψ = ∇·(∂u/∂t) (ADI / Thomas factorisation)
// plus a momentum acceleration dt·h·(h²/3)∇ψ (see physics.js). These tests
// lock:
//   1. the measured phase speed of a propagating wave packet at three kh
//      values matches the DISCRETE-symbol-corrected [0,2] prediction (the
//      centered-Laplacian and centered-gradient stencils scale the correction
//      by sinc(kΔx)·sin(kΔx)/(kΔx) — folded into the expectation) within 3-4%,
//      and the slow-down vs the non-dispersive arm grows with kh;
//   2. a lake at rest stays exactly still with dispersion enabled (ψ ≡ 0);
//   3. mass conservation and numerical stability hold over a long run;
//   4. a near-field shelf runup peak changes < 10% vs the non-dispersive arm
//      (the R5 acceptance guard: dispersion must not corrupt the near field);
//   5. the default path exposes no dispersion block in diagnostics.
const test=require('node:test');
const assert=require('node:assert');
const Physics=require('../public/physics');

const G=9.80665;

// Right-going wave packet (initial u matched to the linear SWE relation
// u = η·sqrt(g/h) so only one direction launches); the tracked carrier
// upcrossing advances at the phase speed.
function trackPhaseSpeed({depth,lambdaCells,dispersion,nx=300,resDeg=0.01}){
  const res=resDeg*111320,wavelength=lambdaCells*res,k=2*Math.PI/wavelength;
  const ny=5;
  const data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(y===0||y===ny-1?1:-depth);
  const grid={origin:[0,0],res:resDeg,nx,ny,data,meta:{quality:'verification'}};
  const x0=0.25*nx*resDeg,sigma=2*resDeg*lambdaCells,amp=0.3;
  const c0=Math.sqrt(G*depth);
  const etaAt=lng=>amp*Math.cos(k*lng*111320)*Math.exp(-Math.pow((lng-x0)/sigma,2));
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{
    manning:0,coriolis:false,dispersion,
    initialState:cell=>({eta:etaAt(cell.lng),u:etaAt(cell.lng)*c0/depth})
  });
  assert.ok(solver,'solver constructed');
  const rowLat=2*resDeg;
  const etaProfile=()=>{
    const out=new Array(nx);
    for(let x=0;x<nx;x++)out[x]=solver.sampleState(rowLat,x*resDeg).eta;
    return out;
  };
  const findUp=(p,from,to)=>{
    for(let i=Math.max(1,from);i<Math.min(nx-1,to);i++)if(p[i-1]<0&&p[i]>=0)return i;
    return -1;
  };
  let prof=etaProfile();
  const m0=prof.indexOf(Math.max(...prof));
  let xc=findUp(prof,m0-2*lambdaCells,m0+2*lambdaCells);
  assert.ok(xc>0,'no carrier upcrossing found in the initial packet');
  const samples=[[0,xc]];
  const dt=15;
  for(let t=dt;t<=1050;t+=dt){
    solver.advanceTo(t);
    const p=etaProfile();
    const next=findUp(p,Math.round(xc-0.6*lambdaCells),Math.round(xc+0.6*lambdaCells));
    if(next<0)break;
    xc=next;samples.push([t,xc]);
    if(xc>0.8*nx)break;
  }
  assert.ok(samples.length>=15,`only ${samples.length} tracked samples`);
  let st=0,sx=0,stx=0,stt=0;
  for(const [tt,xx] of samples){st+=tt;sx+=xx;stx+=tt*xx;stt+=tt*tt;}
  const slope=(samples.length*stx-st*sx)/(samples.length*stt-st*st);
  return {c:slope*res,k,res,kdx:k*res,diag:solver.getDiagnostics()};
}

function discreteTheory(depth,k,kdx){
  // [0,2] Padé with the discrete-operator symbols folded in
  const lap=Math.pow(2*Math.sin(kdx/2)/kdx,2),grad=Math.sin(kdx)/kdx;
  const kh=k*depth;
  return Math.sqrt(G*depth)/Math.sqrt(1+kh*kh*lap*grad/3);
}

test('dispersion: measured packet phase speed matches the discrete [0,2] Padé prediction',()=>{
  // kh ≈ 0.28 — weak-dispersion regime
  let r=trackPhaseSpeed({depth:500,lambdaCells:10,dispersion:'boussinesq'});
  let theo=discreteTheory(500,r.k,r.kdx);
  assert.ok(Math.abs(r.c/theo-1)<0.03,
    `kh=0.28: measured ${r.c.toFixed(1)} vs theory ${theo.toFixed(1)} (${(100*(r.c/theo-1)).toFixed(1)}%)`);
  // kh ≈ 0.56 — moderate
  r=trackPhaseSpeed({depth:1000,lambdaCells:10,dispersion:'boussinesq'});
  theo=discreteTheory(1000,r.k,r.kdx);
  assert.ok(Math.abs(r.c/theo-1)<0.03,
    `kh=0.56: measured ${r.c.toFixed(1)} vs theory ${theo.toFixed(1)} (${(100*(r.c/theo-1)).toFixed(1)}%)`);
  // kh ≈ 1.13 — strong (the non-dispersive arm is itself ~11% below sqrt(gh)
  // from scheme truncation at 10 cells/λ, so the absolute comparison against
  // the [0,2]+symbol prediction is the meaningful assertion here)
  r=trackPhaseSpeed({depth:2000,lambdaCells:10,dispersion:'boussinesq'});
  theo=discreteTheory(2000,r.k,r.kdx);
  assert.ok(Math.abs(r.c/theo-1)<0.04,
    `kh=1.13: measured ${r.c.toFixed(1)} vs theory ${theo.toFixed(1)} (${(100*(r.c/theo-1)).toFixed(1)}%)`);
  assert.ok(r.diag.dispersion&&r.diag.dispersion.model==='peregrine-boussinesq-q02',
    'diagnostics must expose the dispersion block');
});

test('dispersion slow-down vs the non-dispersive arm grows with kh',()=>{
  function pair(depth,lambdaCells){
    const off=trackPhaseSpeed({depth,lambdaCells,dispersion:'off'});
    const on=trackPhaseSpeed({depth,lambdaCells,dispersion:'boussinesq'});
    return {slow:(off.c-on.c)/off.c,off:off.c,on:on.c,cSwe:Math.sqrt(G*depth)};
  }
  const weak=pair(500,10),moderate=pair(1000,10),strong=pair(3000,12);
  assert.ok(weak.slow>0.004&&weak.slow<0.02,
    `kh=0.28 slow-down ${(weak.slow*100).toFixed(2)}% outside [0.4%,2%]`);
  assert.ok(moderate.slow>0.02&&moderate.slow<0.06,
    `kh=0.56 slow-down ${(moderate.slow*100).toFixed(2)}% outside [2%,6%]`);
  assert.ok(strong.slow>0.05,
    `kh=1.41 slow-down ${(strong.slow*100).toFixed(2)}% not >5%`);
  // off arm tracks sqrt(gh) at ≥10 cells per wavelength
  assert.ok(Math.abs(weak.off/weak.cSwe-1)<0.03&&Math.abs(moderate.off/moderate.cSwe-1)<0.03,
    'off arm drifted from sqrt(gh) at ≥10 cells/λ');
});

test('lake at rest stays exactly still with dispersion enabled',()=>{
  const nx=41,ny=21,data=[];
  // flat bed at -300 m with one island block; still water everywhere
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(x>18&&x<22&&y>8&&y<12?5:-300);
  const grid={origin:[138,34],res:0.02,nx,ny,data,meta:{quality:'verification'}};
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,
    {manning:0.025,coriolis:false,dispersion:'boussinesq',initialState:()=>({})});
  solver.advanceTo(1200);
  let worst=0;
  for(let y=1;y<ny-1;y++)for(let x=1;x<nx-1;x++){
    const st=solver.sampleState(grid.origin[1]+y*grid.res,grid.origin[0]+x*grid.res);
    // dry land cells legitimately report eta = bed elevation; only water
    // columns carry the free surface
    if(st&&st.h>0)worst=Math.max(worst,Math.abs(st.eta));
  }
  assert.ok(worst<1e-6,`still-water surface drifted to ${worst} m`);
  const d=solver.getDiagnostics();
  assert.ok(d.dispersion,'dispersion diagnostics present');
  assert.ok(Math.abs(d.massResidualFraction)<1e-9,'lake mass must be conserved exactly');
});

test('dispersion run stays stable and conservative over a long horizon',()=>{
  const depth=800,lambdaCells=5,nx=160,ny=5,resDeg=0.01;
  const res=resDeg*111320,k=2*Math.PI/(lambdaCells*res);
  const data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(y===0||y===ny-1?1:-depth);
  const grid={origin:[0,0],res:resDeg,nx,ny,data,meta:{quality:'verification'}};
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{
    manning:0,coriolis:false,dispersion:'boussinesq',
    initialState:cell=>({eta:1.2*Math.cos(k*cell.lng*111320)})
  });
  solver.advanceTo(1500);
  const d=solver.getDiagnostics();
  assert.ok(d.nonFiniteCells===0,`non-finite cells: ${d.nonFiniteCells}`);
  assert.ok(d.maxCfl<=d.cflLimit+1e-9,`CFL ${d.maxCfl} exceeded limit ${d.cflLimit}`);
  assert.ok(Math.abs(d.massResidualFraction)<5e-4,
    `mass residual fraction ${d.massResidualFraction} too large with dispersion`);
});

test('near-field shelf runup peak changes <10% with dispersion (R5 acceptance guard)',()=>{
  function run(dispersion){
    const nx=81,ny=7,data=[];
    for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(y===0||y===ny-1?3:-4+7*x/(nx-1));
    const grid={origin:[0,0],res:0.001,nx,ny,data,meta:{quality:'verification'}};
    const solver=Physics.createNonlinearTsunamiSolver(grid,null,{
      manning:0.025,coriolis:false,dispersion,
      initialState:cell=>({eta:cell.x<30?2:0})
    });
    solver.advanceTo(700);
    return solver.getSnapshot(1).maxRunup;
  }
  const off=run('off'),on=run('boussinesq');
  assert.ok(off>0.5,`shelf runup baseline missing (${off})`);
  const change=Math.abs(on-off)/off;
  assert.ok(change<0.10,`near-field runup peak changed ${(change*100).toFixed(1)}% (>10%) with dispersion`);
});

test('default (no dispersion option) path exposes no dispersion block',()=>{
  const nx=31,ny=7,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(y===0||y===ny-1?1:-10);
  const grid={origin:[0,0],res:0.001,nx,ny,data,meta:{quality:'verification'}};
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{manning:0,coriolis:false,initialState:()=>({})});
  solver.advanceTo(10);
  assert.ok(!solver.getDiagnostics().dispersion,'default path must not report dispersion');
});
