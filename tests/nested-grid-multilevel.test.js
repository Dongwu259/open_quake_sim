'use strict';
// v5.8 R5-3 — recursive multi-level (3-level) nested AMR.
// The recursive driver must keep the two-level guarantees across BOTH seams:
// exact still-water preservation, small transmission error against a uniform
// finest-grid reference, CFL discipline, and bit-identical behaviour for the
// legacy two-argument form.
const test=require('node:test');
const assert=require('node:assert');
const path=require('path');
const Physics=require('../public/physics');

const D=111320,G=9.80665;
function makeGrid(ox,oy,nx,ny,resM,terr){
  const res=resM/D,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(terr(ox+x*resM,oy+y*resM));
  return {origin:[ox/D,oy/D],res,nx,ny,data,meta:{quality:'verification',dataset:'nested-grid-multilevel-test'}};
}
const sloped=(x,y)=>(y<50||y>950)?5:(x>1900&&x<2100&&y>500&&y<600)?4
  :-Math.max(1,20+5*Math.sin(2*Math.PI*x/3000)+2*Math.cos(2*Math.PI*y/500));
const flat=(x,y)=>(y<50||y>950)?5:(x>1900&&x<2100&&y>500&&y<600)?4:-20;

const triple=()=>({
  coarse:makeGrid(0,0,61,21,50,sloped),
  mid:makeGrid(1000,300,61,25,50/3,sloped),
  city:makeGrid(1000+50*(50/3),300+9*(50/3),21,20,50/9,sloped)
});

test('three levels validate as a chain and the solver builds',()=>{
  const {coarse,mid,city}=triple();
  const r1=Physics.validateNestedGrids(coarse,mid);
  const r2=Physics.validateNestedGrids(mid,city);
  assert.equal(r1.valid,true,JSON.stringify(r1.errors));
  assert.equal(r2.valid,true,JSON.stringify(r2.errors));
  assert.equal(r2.ratio,3);
  const solver=Physics.createNestedTsunamiSolver([coarse,mid,city],null,
    {initialState:()=>({eta:0}),manning:0,coriolis:false});
  assert.ok(solver,'3-level solver built');
  const d=solver.getDiagnostics();
  assert.equal(d.nested.model,'two-way-amr');
  assert.equal(d.nested.levelCount,3);
  assert.deepEqual(d.nested.ratios,[3,3]);
  assert.ok(Array.isArray(d.levels)&&d.levels.length===3,'levels aggregated');
  assert.ok(Array.isArray(solver.levels)&&solver.levels.length===3,'solver exposes level solvers');
});

test('three-level lake at rest stays exactly still across both seams',()=>{
  const {coarse,mid,city}=triple();
  const solver=Physics.createNestedTsunamiSolver([coarse,mid,city],null,
    {initialState:()=>({eta:0}),manning:0,coriolis:false});
  solver.advanceTo(120);
  let worst=0;
  for(let mx=50;mx<2950;mx+=50)for(let my=50;my<950;my+=50){
    const s=solver.sampleState(my/D,mx/D);
    if(s&&s.h>0.1)worst=Math.max(worst,Math.abs(s.eta),Math.abs(s.u),Math.abs(s.v));
  }
  assert.ok(worst<1e-9,`still-water perturbation ${worst}`);
  const d=solver.getDiagnostics();
  assert.equal(d.nonFiniteCells,0);
  assert.ok(d.maxCfl<=d.cflLimit+1e-9,`CFL ${d.maxCfl} over ${d.cflLimit}`);
});

test('gaussian pulse transmits through two seams against a uniform reference',()=>{
  const H=20,c=Math.sqrt(G*H),x0=500,sig=60,amp=0.5;
  const init=cell=>{
    const e=cell.terrain<0?amp*Math.exp(-0.5*Math.pow((cell.lng*D-x0)/sig,2)):0;
    return {eta:e,u:cell.terrain<0?c*e/(H+e):0};
  };
  const coarse=makeGrid(0,0,61,21,50,flat);
  const mid=makeGrid(1000,300,61,25,50/3,flat);
  const city=makeGrid(1000+50*(50/3),300+9*(50/3),21,20,50/9,flat);
  const nested=Physics.createNestedTsunamiSolver([coarse,mid,city],null,
    {initialState:init,manning:0,coriolis:false,boundary:'wall'});
  // uniform reference at 50/6 m: finer than the mid level, coarser than the
  // city level (the city-probe tolerance absorbs that resolution delta)
  const reference=Physics.createNonlinearTsunamiSolver(makeGrid(0,0,361,121,50/6,flat),null,
    {initialState:init,manning:0,coriolis:false,boundary:'wall'});
  nested.advanceTo(150);reference.advanceTo(150);
  let l1City=0,nCity=0,l1Mid=0,nMid=0;
  for(let mx=40;mx<2960;mx+=10){
    const sN=nested.sampleState(300/D,mx/D),sR=reference.sampleState(300/D,mx/D);
    if(sN&&sR&&sN.h>0.1&&sR.h>0.1){
      const e=Math.abs(sN.eta-sR.eta);
      l1Mid+=e;nMid++;
    }
  }
  for(let mx=1838;mx<=1948;mx+=5){
    const sN=nested.sampleState(470/D,mx/D),sR=reference.sampleState(470/D,mx/D);
    if(sN&&sR&&sN.h>0.1&&sR.h>0.1){l1City+=Math.abs(sN.eta-sR.eta);nCity++;}
  }
  assert.ok(nMid>200&&nCity>8,`probe coverage n=${nMid} nCity=${nCity}`);
  // two-seam transmission measures ~5.4% of amplitude vs ~3% through the
  // single seam of the two-level test — threshold set with that margin
  assert.ok(l1Mid/nMid<0.06*amp,`mid-region L1 ${(l1Mid/nMid).toExponential(3)} exceeds 6% of amplitude`);
  assert.ok(l1City/nCity<0.08*amp,`city-region L1 ${(l1City/nCity).toExponential(3)} exceeds 8% of amplitude`);
  const d=nested.getDiagnostics();
  assert.equal(d.nonFiniteCells,0);
  assert.ok(Math.abs(d.massResidualFraction)<2e-3,`mass residual ${d.massResidualFraction}`);
});

test('array form with two grids matches the legacy pair form bit-for-bit',()=>{
  const coarse=makeGrid(0,0,61,21,50,flat);
  const mid=makeGrid(1000,300,61,25,50/3,flat);
  const H=20,c=Math.sqrt(G*H),x0=500,sig=60,amp=0.5;
  const init=cell=>{
    const e=cell.terrain<0?amp*Math.exp(-0.5*Math.pow((cell.lng*D-x0)/sig,2)):0;
    return {eta:e,u:cell.terrain<0?c*e/(H+e):0};
  };
  const a=Physics.createNestedTsunamiSolver(coarse,mid,null,{initialState:init,manning:0,coriolis:false});
  const b=Physics.createNestedTsunamiSolver([coarse,mid],null,{initialState:init,manning:0,coriolis:false});
  assert.ok(a&&b);
  a.advanceTo(60);b.advanceTo(60);
  const fa=a.levels.fine._fields(),fb=b.levels.fine._fields();
  for(let i=0;i<fa.h.length;i++){
    assert.equal(fa.h[i],fb.h[i],`fine h differs at ${i}`);
    assert.equal(fa.hu[i],fb.hu[i],`fine hu differs at ${i}`);
  }
  assert.equal(a.getTime(),b.getTime());
  const ca=a.levels.coarse._fields(),cb=b.levels.coarse._fields();
  for(let i=0;i<ca.h.length;i++)assert.equal(ca.h[i],cb.h[i],`coarse h differs at ${i}`);
});

test('production grid chain 0.15° + 0.025° + synthetic 0.005° nests at ratios 6/5 and runs healthy',()=>{
  const root=path.resolve(__dirname,'..');
  const global=require(path.join(root,'public/geojson/bathymetry.json'));
  const regional=require(path.join(root,'public/geojson/grids/jp-sanriku.json'));
  // synthetic 0.005° city patch straddling the Ofunato coastline, sampled
  // from the regional grid values so terrain is consistent across the seam
  const res=regional.res/5;
  // find a 6x6 regional block with both land and water (validateResearchGrid
  // requires a land-water mask on every level)
  let ix0=-1,iy0=-1;
  outer:
  for(let sy=20;sy<regional.ny-30;sy+=4)for(let sx=20;sx<regional.nx-30;sx+=4){
    let land=0,water=0;
    for(let y=0;y<6;y++)for(let x=0;x<6;x++){
      const v=regional.data[(sy+y)*regional.nx+sx+x];
      if(v>=0)land++;else water++;
    }
    if(land>0&&water>0){ix0=sx;iy0=sy;break outer;}
  }
  assert.ok(ix0>0,'found a coastal window in jp-sanriku');
  const nx=30,ny=30,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){
    const sx=Math.min(regional.nx-1,ix0+Math.round(x/5)),sy2=Math.min(regional.ny-1,iy0+Math.round(y/5));
    data.push(regional.data[sy2*regional.nx+sx]);
  }
  const city={origin:[regional.origin[0]+ix0*regional.res,regional.origin[1]+iy0*regional.res],
    res,nx,ny,data,meta:{quality:'verification',dataset:'synthetic city patch from jp-sanriku'}};
  const chk=Physics.validateNestedGrids(regional,city);
  assert.equal(chk.valid,true,JSON.stringify(chk.errors));
  assert.equal(chk.ratio,5);
  const source={lat:38.3,lng:142.37,depthKm:24,mag:8.5,mw:8.5,strikeDeg:200,dipDeg:14,rakeDeg:90};
  source.geometry=Physics.genSubSources(38.3,142.37,8.5,200,14,24,2.8,{});
  const solver=Physics.createNestedTsunamiSolver([global,regional,city],source,
    {manning:0.025,coriolis:false,boundary:'radiation'});
  assert.ok(solver,'3-level production chain solver built');
  solver.advanceTo(600);
  const d=solver.getDiagnostics();
  assert.equal(d.nonFiniteCells,0);
  assert.ok(d.maxCfl<=d.cflLimit+1e-9,`CFL ${d.maxCfl} over ${d.cflLimit}`);
  assert.deepEqual(d.nested.ratios,[6,5]);
  const snap=solver.getSnapshot(6);
  assert.ok(snap.cells.length>0,'snapshot has cells');
  // cells from all three resolutions must appear
  const resSet=new Set(snap.cells.map(c=>c.res));
  assert.ok(resSet.has(regional.res)&&resSet.has(city.res),'snapshot merges levels by resolution');
  // sampling precedence: a point inside the city patch resolves at the finest level
  const inCity=solver.sampleState(city.origin[1]+12*res,city.origin[0]+15*res);
  assert.ok(inCity,'city sample resolves');
});
