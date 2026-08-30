'use strict';
// v6.0.1 R5 — landuse Manning pack (R5-6 closure).
//
// Gates the frozen public/geojson/landuse-manning.json pack against:
//   1. schema + grid contract (origin/res/dims = the REGIONAL_BATHY union
//      box at 0.025° — every regional/nested-fine grid the app can build
//      looks up inside the pack, so the runtime `_landuseManningField`
//      mapping never misses);
//   2. value domain = the verified MLIT L03-b_r class codes only;
//   3. frozen spot cells (dominant-class tripwire);
//   4. the app.js class table carries exactly the pack's classes with the
//      semantic ordering of the Japanese runup convention (forest rougher
//      than paddy, buildings rougher than sea, sea = scalar default);
//   5. the physics solver accepts a heterogeneous per-cell field, reports
//      per-cell mode and stays finite/stable.
// Provenance lives in the pack's `provenance` block (MLIT L03-b-14, CC BY 4.0,
// dominant-class 20×30 downsample) — asserted here so it cannot be stripped.
const test=require('node:test');
const assert=require('node:assert');
const fs=require('fs');
const path=require('path');
const Physics=require('../public/physics');

const PACK=JSON.parse(fs.readFileSync(path.join(__dirname,'../public/geojson/landuse-manning.json'),'utf8'));
const APP=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');

const CLASS_CODES=new Set([0,10,20,50,60,70,91,92,100,110,140,150,160]);

function cellAt(lng,lat){
  const x=Math.floor((lng-PACK.origin[0])/PACK.res),y=Math.floor((lat-PACK.origin[1])/PACK.res);
  assert.ok(x>=0&&y>=0&&x<PACK.nx&&y<PACK.ny,'query inside pack');
  return PACK.data[y*PACK.nx+x];
}

test('landuse pack: schema and grid contract',()=>{
  assert.strictEqual(PACK._schema,'quake-sim-landuse-manning-v1');
  assert.deepStrictEqual(PACK.origin,[132,30]);
  assert.strictEqual(PACK.res,0.025);
  assert.strictEqual(PACK.nx,501);   // 132..144.5 centers (+1 edge margin)
  assert.strictEqual(PACK.ny,541);   // 30..43.5 centers (+1 edge margin)
  assert.strictEqual(PACK.data.length,501*541);
  for(const v of PACK.data)assert.ok(CLASS_CODES.has(v),'class '+v+' in verified domain');
  // provenance cannot be stripped silently
  const p=PACK.provenance||{};
  assert.match(p.source||'',/L03-b-14/);
  assert.match(p.license||'',/CC BY 4\.0/);
  assert.match(p.url||'',/nlftp\.mlit\.go\.jp/);
});

test('landuse pack: regional grids stay inside the pack box',()=>{
  // the loader contract (app.js `_landuseManningField`) snaps px/py from the
  // solver grid origin; grid-package.js snaps origins UP to res multiples, so
  // every grid built from a REGIONAL_BATHY bbox fits iff the bbox + one res
  // margin fits inside the pack envelope
  const m=APP.match(/var REGIONAL_BATHY = \[([\s\S]*?)\];/);
  assert.ok(m,'REGIONAL_BATHY present');
  const boxes=[...m[1].matchAll(/bbox:\[([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\]/g)].map(r=>r.slice(1,5).map(Number));
  assert.ok(boxes.length>=5,'5 regional bboxes parsed');
  const east=PACK.origin[0]+PACK.nx*PACK.res, north=PACK.origin[1]+PACK.ny*PACK.res;
  for(const [w,s,e,n] of boxes){
    assert.ok(w>=PACK.origin[0]-1e-9&&e+PACK.res<=east+1e-9,'lng inside pack: '+[w,e]);
    assert.ok(s>=PACK.origin[1]-1e-9&&n+PACK.res<=north+1e-9,'lat inside pack: '+[s,n]);
  }
});

test('landuse pack: coverage stats plausible (2014 edition structure)',()=>{
  const hist={};
  for(const v of PACK.data)hist[v]=(hist[v]||0)+1;
  const covered=Object.entries(hist).filter(([k])=>k!=='0').reduce((a,[,c])=>a+c,0);
  assert.ok(covered>30000&&covered<120000,'covered cells '+covered);
  assert.ok(hist[50]>hist[10],'forest dominates paddy (Japan land structure)');
  assert.ok(hist[70]>1000,'building land present');
  assert.ok(hist[150]>5000,'coastal sea present');
});

test('landuse pack: frozen spot cells',()=>{
  // dominant class at 2.3×2.75 km — expectations are landmarks, not field maps
  assert.strictEqual(cellAt(139.767,35.681),70,'Tokyo Station → 建物用地');
  assert.strictEqual(cellAt(140.872,38.268),70,'Sendai downtown → 建物用地');
  assert.strictEqual(cellAt(140.4,42.6),50,'Hokkaido SW interior → 森林');
  assert.strictEqual(cellAt(136.05,35.25),110,'Lake Biwa → 河川湖沼');
  assert.strictEqual(cellAt(141.0,32.5),0,'SE open-ocean gap → 範囲外 (scalar fallback)');
});

test('app.js class table matches the pack classes and runup convention',()=>{
  const m=APP.match(/var LANDUSE_MANNING_BY_CLASS=\{([^}]*)\}/);
  assert.ok(m,'class table present');
  const table={};
  for(const kv of m[1].split(','))
    {const [k,v]=kv.split(':');table[Number(k)]=Number(v);}
  const packClasses=new Set(PACK.data.filter(v=>v!==0));
  for(const c of packClasses)assert.ok(table[c]!==undefined,'class '+c+' mapped');
  for(const k of Object.keys(table))assert.ok(CLASS_CODES.has(Number(k))&&Number(k)!==0,'no phantom class '+k);
  assert.strictEqual(table[150],0.025,'sea keeps the scalar default');
  assert.ok(table[50]>table[10],'forest rougher than paddy');
  assert.ok(table[70]>table[150],'buildings rougher than sea');
  for(const v of Object.values(table))assert.ok(v>=0.005&&v<=0.2,'n in solver clamp range');
});

test('physics: per-cell Manning field accepted and stable',()=>{
  const nx=40,ny=20;
  const data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(y<ny-3?-100:2); // north 3 rows land
  const grid={origin:[135,35],res:0.025,nx,ny,data,meta:{quality:'verification'}};
  const field=new Float32Array(nx*ny);
  for(let i=0;i<field.length;i++)field[i]=i%2?0.025:0.08; // heterogeneous land roughness
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{manning:0.025,manningField:field,initialState:()=>({eta:0,u:0,v:0})});
  assert.ok(solver,'solver built');
  assert.strictEqual(solver.hasManningField,true);
  solver.advanceTo(120);
  const d=solver.getDiagnostics();
  assert.strictEqual(d.manningField.mode,'per-cell');
  assert.strictEqual(d.manningField.cells,nx*ny);
  assert.strictEqual(d.nonFiniteCells,0);
  assert.ok(Number.isFinite(d.maxWaterDepthM));
});
