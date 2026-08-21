'use strict';
const assert = require('node:assert');
const Physics = require('../public/physics');

const G=9.80665;
function stripGrid(nx,lengthM,terrainAt){
  const ny=5,res=(lengthM/(nx-1))/111320,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(y===0||y===ny-1?1:terrainAt(x*lengthM/(nx-1)));
  return {origin:[0,0],res,nx,ny,data,meta:{quality:'verification',dataset:'NLSWE public benchmark'}};
}
function rowStates(solver,grid){
  const y=2,states=[];
  for(let x=1;x<grid.nx-1;x++)states.push(solver.sampleState(grid.origin[1]+y*grid.res,grid.origin[0]+x*grid.res));
  return states;
}

// 1. C-property: non-flat bathymetry and a constant free surface remain still.
{
  const grid=stripGrid(101,5000,x=>-Math.max(1,20+5*Math.sin(2*Math.PI*x/5000)));
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{initialState:()=>({eta:0}),manning:0,coriolis:false,boundary:'wall'});
  solver.advanceTo(300);
  const max=Math.max(...rowStates(solver,grid).map(s=>Math.max(Math.abs(s.eta),Math.abs(s.u),Math.abs(s.v))));
  assert.ok(max<2e-5,`lake at rest error ${max}`);
  console.log(`lake-at-rest Linf=${max.toExponential(3)}`);
}

// 2. Ritter dry-bed dam break. Report L1 depth error at three resolutions.
function damBreak(nx){
  const length=5000,H=10,x0=2000,t=40,grid=stripGrid(nx,length,()=>-0.0001);
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{initialState:cell=>({eta:cell.x*length/(nx-1)<x0?H-cell.stillDepth:-cell.stillDepth}),
    dryTolerance:0.001,manning:0,coriolis:false,boundary:'wall'});
  solver.advanceTo(t);
  let error=0,count=0;
  for(let x=1;x<nx-1;x++){
    const coordinate=x*length/(nx-1)-x0;
    let exact;
    if(coordinate<=-Math.sqrt(G*H)*t)exact=H;
    else if(coordinate>=2*Math.sqrt(G*H)*t)exact=0;
    else exact=4/(9*G)*Math.pow(Math.sqrt(G*H)-coordinate/(2*t),2);
    const state=solver.sampleState(2*grid.res,x*grid.res);
    error+=Math.abs(state.h-exact);count++;
  }
  return {error:error/count,diagnostics:solver.getDiagnostics()};
}
const dam=[101,201,401].map(damBreak);
const order12=Math.log(dam[0].error/dam[1].error)/Math.log(2),order23=Math.log(dam[1].error/dam[2].error)/Math.log(2);
assert.ok(dam[2].error<dam[0].error,`dam-break did not converge: ${dam.map(x=>x.error)}`);
assert.ok(order12>0.35&&order23>0.35,`dam-break convergence orders ${order12}, ${order23}`);
assert.ok(Math.abs(dam[2].diagnostics.massResidualFraction)<2e-5,'wall-boundary dam break lost mass');
console.log(`dam-break L1=${dam.map(x=>x.error.toExponential(3)).join(',')} order=${order12.toFixed(3)},${order23.toFixed(3)}`);

// 3. Solitary long wave on a plane beach: the wet front must run above the
// initial shoreline without non-finite or negative-depth failures.
{
  const length=5000,H=10,a=1,x0=900,grid=stripGrid(251,length,x=>x<3000?-H:-H+(x-3000)*0.01);
  const k=Math.sqrt(3*a/(4*Math.pow(H,3))),c=Math.sqrt(G*(H+a));
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{initialState:cell=>{
    const x=cell.x*length/(grid.nx-1),eta=a/Math.pow(Math.cosh(k*(x-x0)),2);
    return {eta:cell.terrain<0?eta:0,u:cell.terrain<0?c*eta/(H+eta):0};
  },dryTolerance:0.01,manning:0,coriolis:false,boundary:'radiation'});
  solver.advanceTo(420);
  const snap=solver.getSnapshot(1),diag=solver.getDiagnostics();
  assert.ok(snap.maxRunup>0.15&&snap.maxInundationDistanceKm>0,'solitary wave produced no run-up');
  assert.equal(diag.nonFiniteCorrections,0);
  console.log(`solitary-runup max=${snap.maxRunup.toFixed(4)}m inundation=${snap.maxInundationDistanceKm.toFixed(4)}km`);
}

// 4. Radiation boundary should release an outgoing pulse instead of returning
// the wall-reflected amplitude into the domain.
function outgoing(boundary){
  const length=5000,H=20,grid=stripGrid(201,length,()=>-H),center=1500,sigma=180,c=Math.sqrt(G*H);
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{initialState:cell=>{
    const x=cell.x*length/(grid.nx-1),eta=0.5*Math.exp(-0.5*Math.pow((x-center)/sigma,2));
    return {eta,u:c*eta/(H+eta)};
  },dryTolerance:0.001,manning:0,coriolis:false,boundary});
  solver.advanceTo(360);
  return Math.max(...rowStates(solver,grid).map(s=>Math.abs(s.eta)));
}
const radiation=outgoing('radiation'),wall=outgoing('wall');
assert.ok(radiation<wall*0.55,`radiation=${radiation}, wall=${wall}`);
console.log(`open-boundary residual=${radiation.toExponential(3)} wall-reflection=${wall.toExponential(3)}`);

// 5. Deep-water wet-bed dam break vs the exact SWE Riemann solution
// (Stoker 1957 / Toro 2001): hL=100 hR=50 keeps every face above the
// secondOrderDepthGate (20 m), so this is the FIRST convergence test that
// exercises the second-order MUSCL reconstruction path.
function stokerMiddle(hL,hR){
  const f=h=>2*(Math.sqrt(G*hL)-Math.sqrt(G*h))-(h-hR)*Math.sqrt(G*(h+hR)/(2*h*hR));
  let lo=hR+1e-9,hi=hL-1e-9;
  for(let i=0;i<100;i++){const m=(lo+hi)/2;if(f(m)>0)lo=m;else hi=m;}
  const h=(lo+hi)/2;
  return {h,u:2*(Math.sqrt(G*hL)-Math.sqrt(G*h))};
}
const STOKER=stokerMiddle(100,50);
function wetDam(nx){
  const length=9000,t=30,grid=stripGrid(nx,length,()=>-0.0001);
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{initialState:cell=>cell.x*length/(nx-1)<4000
    ?{eta:100-cell.stillDepth}:{eta:50-cell.stillDepth}},
    {manning:0,coriolis:false,boundary:'wall'});
  solver.advanceTo(t);
  // Middle-state plateau: tail = DAM+(u*-c*)t ~ 3478, shock = DAM+s*t ~ 4890.
  let eh=0,n=0;
  const step=(nx-1)/length;
  for(let m=3700;m<=4700;m+=length/(nx-1)){
    const s=solver.sampleState(2*grid.res,Math.round(m*step)*grid.res);
    if(!s||s.h<=0)continue;
    eh+=Math.abs(s.h-STOKER.h);n++;
  }
  return eh/n;
}
const wet=[101,201,401].map(wetDam);
const wOrder12=Math.log(wet[0]/wet[1])/Math.log(2),wOrder23=Math.log(wet[1]/wet[2])/Math.log(2);
assert.ok(wet[2]<wet[0],`wet-dam-break did not converge: ${wet}`);
assert.ok(wOrder12>1.0&&wOrder23>1.0,
  `MUSCL-path convergence orders ${wOrder12.toFixed(3)},${wOrder23.toFixed(3)} must exceed 1.0`);
console.log(`wet-dam-break(MUSCL) L1h=${wet.map(x=>x.toExponential(3)).join(',')} order=${wOrder12.toFixed(3)},${wOrder23.toFixed(3)} exact h*=${STOKER.h.toFixed(3)}`);

// 6. Synolakis (1987) non-breaking solitary-wave runup on a plane beach:
// R = 2.831 sqrt(cot b) d (a/d)^{5/4}. d=50 m, a/d=0.03, 1:19.85 slope.
// Runup is transient, so the wet free-surface maximum on the beach is
// tracked across the whole run. Converges toward the analytic law as the
// grid refines (documented under-resolution of the first-order wet/dry
// front at production grid sizes).
{
  const D=50,A=1.5,COT=19.85,XS=3000,LEN2=6000;
  const rAnalytic=2.831*Math.sqrt(COT)*D*Math.pow(A/D,1.25);
  function synolakis(nx){
    const grid=stripGrid(nx,LEN2,x=>x<XS?-D:Math.min(200,-D+(x-XS)/COT));
    const k=Math.sqrt(3*A/(4*D*D*D)),c=Math.sqrt(G*(D+A)),x0=1000;
    const solver=Physics.createNonlinearTsunamiSolver(grid,null,{initialState:cell=>{
      const x=cell.x*LEN2/(nx-1),eta=A/Math.pow(Math.cosh(k*(x-x0)),2);
      return {eta:cell.terrain<0?eta:0,u:cell.terrain<0?c*eta/(D+eta):0};
    },manning:0,coriolis:false,boundary:'radiation',dryTolerance:0.01});
    let runup=0;
    const step=(nx-1)/LEN2;
    const sweep=()=>{for(let m=XS+D*COT;m<LEN2;m+=LEN2/(nx-1)){
      const s=solver.sampleState(2*grid.res,Math.round(m*step)*grid.res);
      if(s&&s.h>0.05&&s.eta>runup)runup=s.eta;
    }};
    for(let t=0;t<400;t+=20){solver.advanceTo(t+20);sweep();}
    return {runup,diag:solver.getDiagnostics()};
  }
  const coarse=synolakis(501),fine=synolakis(1001);
  assert.ok(fine.runup>coarse.runup,'Synolakis runup must increase under refinement (converging toward the analytic law)');
  assert.ok(fine.runup/rAnalytic>0.65,`Synolakis runup ratio ${fine.runup/rAnalytic} must exceed 0.65`);
  assert.equal(fine.diag.nonFiniteCorrections,0);
  console.log(`synolakis-runup analytic=${rAnalytic.toFixed(3)}m coarse(501)=${coarse.runup.toFixed(3)}m (${(coarse.runup/rAnalytic).toFixed(2)}) fine(1001)=${fine.runup.toFixed(3)}m (${(fine.runup/rAnalytic).toFixed(2)})`);
}

// 7. Two-level nested grid (createNestedTsunamiSolver): the still-water
// C-property must hold across the coarse/fine seam on a sloped bed with an
// island inside the patch, and a pulse crossing the interface must track a
// uniform-fine reference with small reflection. Grids are authored in metres
// through the solver's own cell-centre convention.
const D=111320;
function metreGrid(ox,oy,nx,ny,resM,terr){
  const res=resM/D,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(terr(ox+x*resM,oy+y*resM));
  return {origin:[ox/D,oy/D],res,nx,ny,data,meta:{quality:'verification',dataset:'NLSWE nested benchmark'}};
}
const NEST_TERR=(x,y)=>(y<50||y>950)?5:(x>1900&&x<2100&&y>500&&y<600)?4:-Math.max(1,20+5*Math.sin(2*Math.PI*x/3000)+2*Math.cos(2*Math.PI*y/500));
const NEST_COARSE=metreGrid(0,0,61,21,50,NEST_TERR),NEST_FINE=metreGrid(1000,300,61,25,50/3,NEST_TERR);
let nestedStill=Infinity;
{
  const solver=Physics.createNestedTsunamiSolver(NEST_COARSE,NEST_FINE,null,{initialState:()=>({eta:0}),manning:0,coriolis:false});
  assert.ok(solver,'nested solver build failed');
  solver.advanceTo(120);
  let worst=0;
  for(let mx=50;mx<2950;mx+=50)for(let my=50;my<950;my+=50){
    const s=solver.sampleState(my/D,mx/D);
    if(s&&s.h>0.1)worst=Math.max(worst,Math.abs(s.eta),Math.abs(s.u),Math.abs(s.v));
  }
  nestedStill=worst;
  assert.ok(worst<1e-9,`nested lake at rest error ${worst}`);
  assert.equal(solver.getDiagnostics().nonFiniteCells,0);
  console.log(`nested-lake-at-rest Linf=${worst.toExponential(3)}`);
}
let nestedL1=Infinity,nestedRefl=Infinity;
{
  const H=20,c=Math.sqrt(G*H),x0=500,sig=60,amp=0.5;
  const flat=(x,y)=>(y<50||y>950)?5:(x>1900&&x<2100&&y>500&&y<600)?4:-H;
  const init=cell=>{const e=cell.terrain<0?amp*Math.exp(-0.5*Math.pow((cell.lng*D-x0)/sig,2)):0;return{eta:e,u:cell.terrain<0?c*e/(H+e):0};};
  const nested=Physics.createNestedTsunamiSolver(metreGrid(0,0,61,21,50,flat),metreGrid(1000,300,61,25,50/3,flat),null,
    {initialState:init,manning:0,coriolis:false,boundary:'wall'});
  const reference=Physics.createNonlinearTsunamiSolver(metreGrid(0,0,181,61,50/3,flat),null,
    {initialState:init,manning:0,coriolis:false,boundary:'wall'});
  nested.advanceTo(150);reference.advanceTo(150);
  let l1f=0,nf=0,refl=0;
  for(let mx=40;mx<2960;mx+=10){
    const sN=nested.sampleState(300/D,mx/D),sR=reference.sampleState(300/D,mx/D);
    if(sN&&sR&&sN.h>0.1&&sR.h>0.1&&mx>=1000&&mx<=2000){l1f+=Math.abs(sN.eta-sR.eta);nf++;}
  }
  for(let mx=40;mx<980;mx+=10){const s=nested.sampleState(300/D,mx/D);if(s&&s.h>0.1)refl=Math.max(refl,s.eta);}
  nestedL1=l1f/nf;nestedRefl=refl;
  assert.ok(nestedL1<0.03*amp,`nested transmission L1 ${nestedL1} exceeds 3% of amplitude`);
  assert.ok(nestedRefl<0.015*amp,`nested interface reflection ${nestedRefl} exceeds 1.5% of amplitude`);
  console.log(`nested-transmission L1=${nestedL1.toExponential(3)} reflection=${nestedRefl.toExponential(3)} (${(nestedRefl/amp*100).toFixed(2)}% of amplitude)`);
}

console.log(JSON.stringify({schema:'quake-sim-nlswe-benchmark-result-v1',lakeAtRest:'pass',damBreak:{errors:dam.map(x=>x.error),orders:[order12,order23]},wetDamBreakMUSCL:{exactMiddleState:STOKER.h,errors:wet,orders:[wOrder12,wOrder23]},solitaryRunup:'pass',synolakisRunup:'tracked-vs-analytic',wettingDrying:'pass',openBoundary:{radiation,wall},massConservation:dam[2].diagnostics.massResidualFraction,nestedGrid:{lakeAtRestStillWater:nestedStill,transmissionL1:nestedL1,interfaceReflection:nestedRefl}},null,2));
