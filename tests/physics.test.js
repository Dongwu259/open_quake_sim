// ================================================================
//  Unit tests for Earthquake Simulator — Physics module
//  Run with:  node --test tests/physics.test.js
//             npm test
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Physics = require('../public/physics.js');

// ================================================================
//  FOCAL MECHANISM
// ================================================================

test('focalMechanism — double couple tensor is traceless and axes are orthogonal', () => {
  const fm = Physics.focalMechanism({strike:193,dip:10,rake:88,mw:8.5});
  assert.equal(fm.coordinateSystem, 'NED');
  assert.equal(fm.type, 'double-couple');
  assert.ok(Math.abs(fm.trace) < 1e-6 * fm.momentNm);
  const p=fm.axes.P.vector, t=fm.axes.T.vector, b=fm.axes.B.vector;
  assert.ok(Math.abs(p.x*t.x+p.y*t.y+p.z*t.z) < 1e-10);
  assert.ok(Math.abs(p.x*b.x+p.y*b.y+p.z*b.z) < 1e-10);
  assert.ok(Math.abs(t.x*b.x+t.y*b.y+t.z*b.z) < 1e-10);
  assert.ok(Math.abs(fm.plane1.strikeDeg-193) < 1e-8);
  assert.ok(Math.abs(fm.plane1.dipDeg-10) < 1e-8);
  assert.ok(Math.abs(fm.plane1.rakeDeg-88) < 1e-8);
});

test('focalMechanism — canonical fault styles produce expected axes', () => {
  const strikeSlip=Physics.focalMechanism({strike:0,dip:90,rake:0,momentNm:1});
  assert.ok(Math.abs(strikeSlip.axes.P.plungeDeg) < 1e-8);
  assert.ok(Math.abs(strikeSlip.axes.T.plungeDeg) < 1e-8);
  assert.ok(Math.abs(strikeSlip.axes.B.plungeDeg-90) < 1e-8);
  const thrust=Physics.focalMechanism({strike:0,dip:20,rake:90,momentNm:1});
  const normal=Physics.focalMechanism({strike:0,dip:20,rake:-90,momentNm:1});
  assert.ok(thrust.axes.T.plungeDeg > thrust.axes.P.plungeDeg);
  assert.ok(normal.axes.P.plungeDeg > normal.axes.T.plungeDeg);
});

test('focalMechanism — nodal planes are interchangeable', () => {
  const fm=Physics.focalMechanism({strike:193,dip:10,rake:88,mw:8});
  const np=fm.plane2;
  const swapped=Physics.focalMechanism({strike:np.strikeDeg,dip:np.dipDeg,rake:np.rakeDeg,mw:8});
  assert.ok(Math.abs(swapped.plane1.strikeDeg-np.strikeDeg) < 1e-6);
  assert.ok(Math.abs(swapped.plane1.dipDeg-np.dipDeg) < 1e-6);
  assert.ok(Math.abs(swapped.plane1.rakeDeg-np.rakeDeg) < 1e-6);
  assert.ok(Math.abs(swapped.tensor.xx-fm.tensor.xx) < 1e-8*fm.momentNm);
  assert.ok(Math.abs(swapped.tensor.xy-fm.tensor.xy) < 1e-8*fm.momentNm);
});

test('focalRadiation — sign follows the NED moment tensor', () => {
  const fm = Physics.focalMechanism({strike:25,dip:35,rake:70,momentNm:1});
  const ray = {azimuthDeg:123,takeoffDeg:48};
  const direct = Physics.focalRadiation(fm.tensor, ray.azimuthDeg, ray.takeoffDeg);
  const ar=ray.azimuthDeg*Math.PI/180, tr=ray.takeoffDeg*Math.PI/180;
  const v={x:Math.sin(tr)*Math.cos(ar),y:Math.sin(tr)*Math.sin(ar),z:Math.cos(tr)};
  const expected=fm.tensor.xx*v.x*v.x+fm.tensor.yy*v.y*v.y+fm.tensor.zz*v.z*v.z+2*(fm.tensor.xy*v.x*v.y+fm.tensor.xz*v.x*v.z+fm.tensor.yz*v.y*v.z);
  assert.ok(Math.abs(direct-expected)<1e-12);
});

test('invertFocalMechanismPolarity — recovers a synthetic mechanism', () => {
  const truth=Physics.focalMechanism({strike:30,dip:50,rake:80,momentNm:1});
  const records=[];
  for(let az=0;az<360;az+=30) for(let tk=20;tk<=160;tk+=35){
    const rad=Physics.focalRadiation(truth.tensor,az,tk);
    if(Math.abs(rad)<0.05) continue;
    records.push({azimuthDeg:az,takeoffDeg:tk,polarity:rad>0?'P':'N'});
  }
  const out=Physics.invertFocalMechanismPolarity(records,{coarseStep:10,fineStep:2});
  assert.equal(out.type,'first-motion-polarity');
  assert.ok(out.mismatchRate<0.12,`mismatch ${out.mismatchRate}`);
  const d=Math.abs(((out.strikeDeg-truth.plane1.strikeDeg+180)%360)-180);
  assert.ok(d<12,`strike difference ${d}`);
  assert.ok(Math.abs(out.dipDeg-truth.plane1.dipDeg)<12);
  assert.ok(Math.abs(out.rakeDeg-truth.plane1.rakeDeg)<16);
  assert.equal(out.rejectedRecords,0);
  assert.equal(out.observations.length,out.usedRecords);
});

test('invertFocalMechanismPolarity — rejects malformed records and validates convention', () => {
  assert.throws(()=>Physics.invertFocalMechanismPolarity([{azimuthDeg:1,takeoffDeg:20,polarity:'P'}],{}),/At least/);
  assert.throws(()=>Physics.invertFocalMechanismPolarity([], {takeoffConvention:'sideways'}),/Unknown takeoff/);
});

test('calibratePolarityRecords — recovers global offsets and station reversal', () => {
  const reference={strike:35,dip:48,rake:72};
  const fm=Physics.focalMechanism(Object.assign({},reference,{momentNm:1}));
  const records=[];
  for(let az=0;az<360;az+=20) for(let tk=25;tk<=155;tk+=25){
    const rad=Physics.focalRadiation(fm.tensor,az+3,tk-2);
    if(Math.abs(rad)<0.08) continue;
    const station=(az===0?'REV':'STA'+az);
    let pol=rad>0?'P':'N'; if(station==='REV') pol=pol==='P'?'N':'P';
    records.push({azimuthDeg:az,takeoffDeg:tk,polarity:pol,station});
  }
  const cal=Physics.calibratePolarityRecords(records,reference,{offsetStep:1,stationMinRecords:2});
  assert.ok(cal.before.mismatchRate>0.05);
  // Polarity mechanisms have nodal-plane symmetries; the offset is therefore
  // not unique, but it must remain within the searched physical range and
  // materially improve the fit before station-specific reversal handling.
  assert.ok(Math.abs(cal.globalOffset.azimuthDeg)<=8,`az offset ${cal.globalOffset.azimuthDeg}`);
  assert.ok(Math.abs(cal.globalOffset.takeoffDeg)<=6,`takeoff offset ${cal.globalOffset.takeoffDeg}`);
  assert.ok(cal.afterGlobal.mismatchRate<cal.before.mismatchRate);
  assert.ok(cal.flippedStations.includes('REV'));
  assert.ok(cal.afterStationFlip.mismatchRate<0.05);
  assert.equal(cal.correctedRecords.length,records.length);
});

// ================================================================
//  DISTANCE
// ================================================================

test('haversineDist — Tokyo to Osaka (~400 km)', () => {
  const d = Physics.haversineDist(35.68, 139.76, 34.69, 135.50);
  assert.ok(d > 390 && d < 410, `Tokyo-Osaka should be ~400 km, got ${d.toFixed(1)}`);
});

test('haversineDist — same point zero distance', () => {
  const d = Physics.haversineDist(35.0, 140.0, 35.0, 140.0);
  assert.ok(d < 0.01, `Same point should have 0 distance, got ${d}`);
});

test('haversineDist — Tokyo to London (~9600 km)', () => {
  const d = Physics.haversineDist(35.68, 139.76, 51.51, -0.13);
  assert.ok(d > 9400 && d < 9800, `Tokyo-London should be ~9600 km, got ${d.toFixed(0)}`);
});

test('hypoDist — surface station above 30km deep hypocenter', () => {
  const d = Physics.hypoDist(36.0, 140.0, 36.0, 140.0, 30);
  assert.ok(d > 29.9 && d < 30.1, `Directly above hypocenter should be depth=30km, got ${d.toFixed(1)}`);
});

test('hypoDist — null epicenter returns Infinity', () => {
  const d = Physics.hypoDist(36.0, 140.0, null, null, 30);
  assert.strictEqual(d, Infinity);
});

// ================================================================
//  SOURCE TYPE
// ================================================================

test('sourceType — shallow crustal (< 30 km)', () => {
  assert.strictEqual(Physics.sourceType(10), 'crustal');
  assert.strictEqual(Physics.sourceType(29), 'crustal');
});

test('sourceType — interplate (30-60 km)', () => {
  assert.strictEqual(Physics.sourceType(30), 'interplate');
  assert.strictEqual(Physics.sourceType(55), 'interplate');
});

test('sourceType — deep intraslab (>= 60 km)', () => {
  assert.strictEqual(Physics.sourceType(60), 'intraslab');
  assert.strictEqual(Physics.sourceType(300), 'intraslab');
});

// ================================================================
//  GMPE — LOG MODEL
// ================================================================

test('pgaLog — M7 at 50 km gives reasonable PGA', () => {
  const pga = Physics.pgaLog(7.0, 50, 0.50, 1.20, 0.30, 0);
  // pgaLog returns gal (cm/s²); ~58 gal for M7@50km
  assert.ok(pga > 10 && pga < 200, `M7@50km PGA should be ~58 gal, got ${pga.toFixed(1)}`);
});

test('pgaLog — magnitude scaling: M8 > M7', () => {
  const pga7 = Physics.pgaLog(7.0, 100, 0.50, 1.20, 0.30, 0);
  const pga8 = Physics.pgaLog(8.0, 100, 0.50, 1.20, 0.30, 0);
  assert.ok(pga8 > pga7, 'M8 should produce higher PGA than M7 at same distance');
});

test('pgaLog — near-field large events are not suppressed by saturation', () => {
  const pga7 = Physics.pgaLog(7.0, 3, 0.42, 1.34, 0.31, 0.001);
  const pga8 = Physics.pgaLog(8.0, 3, 0.42, 1.34, 0.31, 0.001);
  assert.ok(pga8 > pga7 * 2, `M8 near-field PGA (${pga8.toFixed(1)}) should clearly exceed M7 (${pga7.toFixed(1)})`);
});

test('auto GMPE — all Japan source classes route to Si-Midorikawa median', () => {
  assert.strictEqual(Physics.resolveGmpModel('auto', 'crustal', 6.5), 'si-midorikawa');
  assert.strictEqual(Physics.resolveGmpModel('auto', 'interplate', 8.0), 'zhao2006');
  assert.strictEqual(Physics.resolveGmpModel('auto', 'intraslab', 7.5), 'zhao2006');
});

test('auto GMPE — M8 shallow near-field reaches severe shaking', () => {
  const pga = Physics.calcPGA(8.0, 3, 'auto', 3, null, 8.0, 'crustal', 0.42, 1.34, 0.31, 0.001, 760);
  const pgv = Physics.calcPGV(8.0, 3, 'auto', 3, null, 8.0, 'crustal', 0.001, 760);
  const ampPga = Physics.vs30Amplification(150, 'pga');
  const ampPgv = Physics.vs30Amplification(150, 'pgv');
  const I = Physics.calcJmaIntensity(pga * ampPga, pgv * ampPgv);
  assert.strictEqual(Physics.intensityToShindo(I), 7);
});

test('shared station predictor reproduces point-source GMPE and site path', () => {
  const source = {lat:35,lng:140,mw:6.2,depthKm:20,strikeDeg:0,dipDeg:90,sourceType:'crustal'};
  const station = {lat:35.4,lng:140.2,vs30:300};
  const context = Physics.createGroundMotionContext(source, {gmpModel:'si-midorikawa',finiteFault:false});
  const result = Physics.predictStationMotion(context, station, {siteModel:'vs30',stationFactor:1});
  const expectedPga = Physics.pgaSiMid(source.mw, result.rhypoKm, source.depthKm, source.sourceType)
    * Physics.vs30Amplification(station.vs30, 'pga');
  assert.equal(result.distanceMetric, 'Rhypo');
  assert.ok(Math.abs(result.pga - expectedPga) < 1e-9);
  assert.equal(result.patches.length, 0);
});

test('shared station predictor executes deterministic finite-fault Rrup path', () => {
  // crustal keeps auto -> si-midorikawa, the model that exercises the Rrup path
  const source = {lat:38.1,lng:142.86,mw:8.5,depthKm:24,strikeDeg:195,dipDeg:10,sourceType:'crustal'};
  const options = {gmpModel:'auto',finiteFault:true,rupSpeed:2.8,
    faultOptions:{randomSeed:42,slipPerturbation:0.4,sourceType:'crustal'}};
  const first = Physics.predictStationMotion(Physics.createGroundMotionContext(source, options),
    {lat:38.27,lng:140.87,vs30:300}, {siteModel:'vs30'});
  const second = Physics.predictStationMotion(Physics.createGroundMotionContext(source, options),
    {lat:38.27,lng:140.87,vs30:300}, {siteModel:'vs30'});
  assert.equal(first.model, 'si-midorikawa'); // auto keeps crustal on Si-Mid (v5.4)
  assert.equal(first.distanceMetric, 'Rrup');
  assert.ok(first.patches.length > 1);
  assert.equal(first.pga, second.pga);
  assert.equal(first.pgv, second.pgv);
});

test('pgaLog — distance decay: 200km < 50km', () => {
  const pga50 = Physics.pgaLog(7.0, 50, 0.50, 1.20, 0.30, 0);
  const pga200 = Physics.pgaLog(7.0, 200, 0.50, 1.20, 0.30, 0);
  assert.ok(pga200 < pga50, 'PGA should decay with distance');
});

test('pgvLog — M7 at 50 km gives reasonable PGV', () => {
  const pgv = Physics.pgvLog(7.0, 50, 0);
  // Expected ~0.8 cm/s for M7@50km
  assert.ok(pgv > 0.1 && pgv < 3.0, `M7@50km PGV should be ~0.8 cm/s, got ${pgv.toFixed(4)}`);
});

// ================================================================
//  GMPE — SI & MIDORIKAWA
// ================================================================

test('pgaSiMid — returns gal (not fraction of g)', () => {
  const pga = Physics.pgaSiMid(7.0, 50, 30, 'crustal');
  // Si-Midorikawa returns gal, expect ~20-200 gal for M7@50km
  assert.ok(pga > 5 && pga < 300, `M7@50km Si-Mid PGA should be 20-200 gal, got ${pga.toFixed(1)}`);
});

// ================================================================
//  JMA INTENSITY
// ================================================================

test('calcJmaIntensity — zero for negligible motion', () => {
  const I = Physics.calcJmaIntensity(0.001, 0.0001);
  assert.strictEqual(I, 0);
});

test('calcJmaIntensity — ~100 gal, 10 cm/s gives Shindo ~4-5', () => {
  const I = Physics.calcJmaIntensity(100, 10);
  assert.ok(I >= 3.5 && I <= 5.5, `100gal/10cm/s should give I~4.5, got ${I.toFixed(2)}`);
});

test('calcJmaIntensity — PGA-dominant (hard rock)', () => {
  // High PGA, low PGV: typical of hard rock sites
  const I = Physics.calcJmaIntensity(300, 5);
  assert.ok(I >= 4.0, `300gal/5cm/s should give I>=4, got ${I.toFixed(2)}`);
});

test('intensityToShindo — boundary values', () => {
  assert.strictEqual(Physics.intensityToShindo(0.3), 0);
  assert.strictEqual(Physics.intensityToShindo(1.0), 1);
  assert.strictEqual(Physics.intensityToShindo(2.0), 2);
  assert.strictEqual(Physics.intensityToShindo(3.0), 3);
  assert.strictEqual(Physics.intensityToShindo(4.3), 4); // I < 4.5 → 4
  assert.strictEqual(Physics.intensityToShindo(4.8), '5-'); // 4.5 <= I < 5.0 → 5-
  assert.strictEqual(Physics.intensityToShindo(5.3), '5+'); // 5.0 <= I < 5.5 → 5+
  assert.strictEqual(Physics.intensityToShindo(5.8), '6-'); // 5.5 <= I < 6.0 → 6-
  assert.strictEqual(Physics.intensityToShindo(6.2), '6+'); // 6.0 <= I < 6.5 → 6+
  assert.strictEqual(Physics.intensityToShindo(6.8), 7);   // I >= 6.5 → 7
});

test('shindoScore — numeric values', () => {
  assert.strictEqual(Physics.shindoScore(0), 0);
  assert.strictEqual(Physics.shindoScore(4), 4);
  assert.strictEqual(Physics.shindoScore('5-'), 4.75);
  assert.strictEqual(Physics.shindoScore('6+'), 6.25);
  assert.strictEqual(Physics.shindoScore(7), 6.75);
});

test('shindoToMMI/shindoToEMS — numeric and label inputs never throw (shindoLabel regression)', () => {
  // numeric fractional intensities previously hit the missing Physics.shindoLabel
  assert.strictEqual(Physics.shindoToMMI(4.8), 7);   // 4.8 → '5-' → MMI 7
  assert.strictEqual(Physics.shindoToMMI(5.3), 8);   // 5.3 → '5+' → MMI 8
  assert.strictEqual(Physics.shindoToMMI(6.2), 10);  // 6.2 → '6+' → MMI 10
  assert.strictEqual(Physics.shindoToMMI(6.8), 11);  // 6.8 → 7 → MMI 11
  assert.strictEqual(Physics.shindoToMMI(0.3), 1);
  assert.strictEqual(Physics.shindoToMMI(3.0), 5);
  // label strings pass straight through
  assert.strictEqual(Physics.shindoToMMI('5-'), 7);
  assert.strictEqual(Physics.shindoToMMI('6+'), 10);
  assert.strictEqual(Physics.shindoToEMS(4.8), 7);
  assert.strictEqual(Physics.shindoToEMS('6-'), 9);
  // convertIntensity routing
  assert.strictEqual(Physics.convertIntensity(5.3, 'mmi'), 8);
  assert.strictEqual(Physics.convertIntensity(5.3, 'ems98'), 8);
  assert.strictEqual(Physics.convertIntensity(5.3, 'shindo'), 5.3);
  assert.strictEqual(Physics.convertIntensity('5+', 'mmi'), 8);
});

// ================================================================
//  FAULT SCALING
// ================================================================

test('faultLength — M7 produces ~50 km', () => {
  const L = Physics.faultLength(7.0);
  assert.ok(L > 30 && L < 80, `M7 fault length should be ~50 km, got ${L.toFixed(1)}`);
});

test('faultLength — M9 produces ~250 km', () => {
  const L = Physics.faultLength(9.0);
  assert.ok(L > 150 && L < 800, `M9 fault length should be ~250 km, got ${L.toFixed(1)}`);
});

test('faultLength — monotonic with magnitude', () => {
  assert.ok(Physics.faultLength(7.5) > Physics.faultLength(7.0));
  assert.ok(Physics.faultLength(8.0) > Physics.faultLength(7.5));
});

test('faultWidth — M7 produces ~20 km', () => {
  const W = Physics.faultWidth(7.0);
  assert.ok(W > 10 && W < 40, `M7 fault width should be ~20 km, got ${W.toFixed(1)}`);
});

test('faultDimensions — interplate megathrust uses source-specific scaling', () => {
  const crustal = Physics.faultDimensions(9.0, 'crustal');
  const interplate = Physics.faultDimensions(9.0, 'interplate');
  assert.ok(interplate.L > 500 && interplate.L < 700, `M9 interface length should be realistic, got ${interplate.L}`);
  assert.ok(interplate.W > 150 && interplate.W <= 200, `M9 interface width should reach the seismogenic cap, got ${interplate.W}`);
  assert.notStrictEqual(interplate.W, crustal.W);
});

test('faultDimensions — published source-class regressions expose provenance and uncertainty', () => {
  const crustal = Physics.faultDimensions(7.0, 'crustal');
  const slab = Physics.faultDimensions(7.5, 'intraslab');
  assert.ok(crustal.relation.includes('Wells & Coppersmith'));
  assert.ok(slab.relation.includes('Strasser'));
  assert.ok(crustal.sigmaLogL > 0 && crustal.sigmaLogW > 0);
  assert.ok(Math.abs(crustal.L - Math.pow(10, -2.44 + 0.59 * 7)) < 1e-10);
  assert.ok(Math.abs(slab.W - Math.pow(10, -1.058 + 0.356 * 7.5)) < 1e-10);
});

test('source-type spatial prior recognizes manual offshore trench scenarios', () => {
  assert.ok(Physics.distanceToJapanSubductionKm(38, 142.2) < 1);
  assert.equal(Physics.resolveSourceTypeAt(38, 142.4, 20, null, 'auto', true), 'interplate');
  assert.equal(Physics.resolveSourceTypeAt(38, 142.4, 20, 'crustal', 'auto', true), 'crustal');
  assert.equal(Physics.resolveSourceTypeAt(38, 142.4, 20, null, 'crustal', true), 'crustal');
});

test('buildFaultGeometry — moves hypocenter fraction before clipping nominal width', () => {
  const dims = Physics.faultDimensions(8.5, 'interplate');
  const g = Physics.buildFaultGeometry(36, 142, 8.5, 190, 20, 10, {sourceType:'interplate'});
  assert.ok(Math.abs(g.W - dims.W) < 1e-9, `Nominal width should survive, got ${g.W}/${dims.W}`);
  assert.equal(g.widthTruncated, false);
  assert.ok(g.hypocenterFrac < 0.35);
  assert.ok(g.topDepth >= -1e-9 && g.bottomDepth <= 80 + 1e-9);
});

test('buildFaultGeometry — reports genuinely depth-limited incompatible geometry', () => {
  const g = Physics.buildFaultGeometry(38, 142, 9.0, 190, 90, 24, {sourceType:'interplate'});
  assert.equal(g.widthTruncated, true);
  assert.equal(g.geometryQuality, 'depth-limited');
  assert.ok(g.widthRatio < 0.5);
  assert.ok(g.topDepth >= -1e-9 && g.bottomDepth <= 80 + 1e-9);
});

test('buildFaultGeometry — vertical M9 fault retains physical down-dip width', () => {
  const g = Physics.buildFaultGeometry(38.1, 142.8, 9.0, 193, 90, 30, {sourceType:'interplate'});
  assert.ok(g.W >= 40, `Vertical fault width must not collapse to depth, got ${g.W}`);
  assert.ok(g.nDip >= 2, `Vertical fault must remain a 2D physical grid, got nDip=${g.nDip}`);
  assert.ok(g.topDepth >= -1e-9, `Top edge must stay below the surface, got ${g.topDepth}`);
  assert.ok(g.bottomDepth <= 80 + 1e-9, `Bottom edge must stay in the interface zone, got ${g.bottomDepth}`);
});

test('buildFaultGeometry — hypocenter is inside top and bottom depth bounds', () => {
  const g = Physics.buildFaultGeometry(35, 135, 7.3, 230, 85, 16, {sourceType:'crustal'});
  assert.ok(g.topDepth < 16 && g.bottomDepth > 16);
  const frac = (16 - g.topDepth) / (g.bottomDepth - g.topDepth);
  assert.ok(Math.abs(frac - g.hypocenterFrac) < 1e-9, `Hypocenter fraction mismatch: ${frac}`);
});

test('genSubSources — patch seismic moments conserve total moment', () => {
  const ff = Physics.genSubSources(38.1, 142.8, 9.0, 193, 10, 24, 2.8, {sourceType:'interplate'});
  const sum = ff.subs.reduce((total, s) => total + s.moment, 0);
  const expected = Physics.seismicMoment(9.0);
  assert.ok(Math.abs(sum / expected - 1) < 1e-12, `Patch moment ratio should be 1, got ${sum / expected}`);
  for (const s of ff.subs) {
    assert.ok(Math.abs(Physics.seismicMoment(s.m) / s.moment - 1) < 1e-12);
    const recoveredMoment = s.slipM * ff.rigidityGPa * 1e9 * s.areaKm2 * 1e6;
    assert.ok(Math.abs(recoveredMoment / s.moment - 1) < 1e-12);
    assert.ok(s.riseTime >= 0.5 && s.riseTime <= 20);
  }
  assert.ok(ff.nStrike > 12, 'Megathrust should no longer use the coarse legacy 12-column grid');
  const patchAspect = (ff.L / ff.nStrike) / (ff.W / ff.nDip);
  assert.ok(patchAspect > 0.6 && patchAspect < 1.7, `Patches should be near equal-size, aspect=${patchAspect}`);
});

test('genSubSources — tapered correlated slip lowers rupture-edge slip', () => {
  const ff = Physics.genSubSources(38, 142, 8.5, 190, 15, 24, 2.8, {sourceType:'interplate',randomSeed:91});
  const edge = [], interior = [];
  for (const s of ff.subs) {
    if (s.strikeIndex === 0 || s.strikeIndex === ff.nStrike - 1 || s.dipIndex === 0 || s.dipIndex === ff.nDip - 1) edge.push(s.slipM);
    else interior.push(s.slipM);
  }
  const mean = values => values.reduce((a,b)=>a+b,0)/values.length;
  assert.ok(mean(edge) < mean(interior), `Edge taper failed: ${mean(edge)} >= ${mean(interior)}`);
  assert.ok(ff.maxSlipM > ff.averageSlipM);
});

test('ruptureState — moment release begins at onset and ends after finite rise time', () => {
  const ff = Physics.genSubSources(35, 140, 7.2, 30, 60, 12, 2.8, {sourceType:'crustal',randomSeed:7});
  const before = Physics.ruptureState(ff, -0.01);
  const after = Physics.ruptureState(ff, ff.maxRuptureTime + 25);
  assert.equal(before.releasedMomentFraction, 0);
  assert.equal(before.activePatches, 0);
  assert.ok(Math.abs(after.releasedMomentFraction - 1) < 1e-12);
  assert.equal(after.completedPatches, ff.subs.length);
  assert.ok(after.endTime > ff.maxRuptureTime);
});

test('finite-fault NNLS inversion recovers non-negative slip and optional moment', () => {
  const green=[[1,0.2,0],[0.1,1,0.2],[0,0.1,1],[0.5,0.5,0.5]],truth=[1,2,0.5];
  const observations=green.map(row=>row.reduce((sum,value,index)=>sum+value*truth[index],0));
  const result=Physics.invertFiniteFaultSlip(green,observations,{smoothing:0,maxIterations:10000,tolerance:1e-12});
  assert.ok(result&&result.rms<1e-8&&result.slipM.every(value=>value>=0));
  for(let i=0;i<truth.length;i++)assert.ok(Math.abs(result.slipM[i]-truth[i])<1e-6);
  const target=30e9*1e6*truth.reduce((sum,value)=>sum+value,0);
  const constrained=Physics.invertFiniteFaultSlip(green,observations,{targetMomentNm:target,rigidityGPa:30,patchAreaKm2:[1,1,1]});
  assert.ok(Math.abs(constrained.resolvedMomentNm/target-1)<1e-12);
});

test('genSubSources — custom asperities change moment share without changing total moment', () => {
  const ff = Physics.genSubSources(35, 140, 7.5, 30, 45, 15, 2.8, {
    sourceType:'crustal', aspList:[{sFrac:0.8,dFrac:0.6,weight:4}]
  });
  const fractions = ff.subs.map(s => s.momentFraction);
  assert.ok(Math.max(...fractions) > Math.min(...fractions) * 2);
  assert.ok(Math.abs(fractions.reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

test('rrupDistance — directly above a horizontal centered plane reaches its depth', () => {
  const g = Physics.buildFaultGeometry(35, 140, 7.0, 0, 0.1, 10, {
    sourceType:'crustal', seismoTopKm:0, seismoBottomKm:30
  });
  const rrup = Physics.rrupDistance(35, 140, g);
  assert.ok(rrup > 9 && rrup < 11, `Expected about 10 km, got ${rrup}`);
});

test('getFaultCorners and genSubSources share identical canonical geometry', () => {
  const opts = {sourceType:'interplate', hypocenterFrac:0.35};
  const corners = Physics.getFaultCorners(38, 143, 8.5, 193, 10, 24, opts);
  const ff = Physics.genSubSources(38, 143, 8.5, 193, 10, 24, 2.8, opts);
  assert.equal(corners.L, ff.L);
  assert.equal(corners.W, ff.W);
  assert.equal(corners.nStrike, ff.nStrike);
  assert.equal(corners.nDip, ff.nDip);
  assert.deepEqual(corners.corners, ff.corners);
});

test('multi-segment moment normalization preserves the mainshock Mw', () => {
  const segmentMw = [8.2, 8.5, 8.0, 7.8];
  const target = Physics.seismicMoment(9.1);
  const raw = segmentMw.reduce((sum, mw) => sum + Physics.seismicMoment(mw), 0);
  const normalized = segmentMw.map(mw => Physics.seismicMoment(mw) * target / raw);
  const total = normalized.reduce((sum, moment) => sum + moment, 0);
  assert.ok(Math.abs(total / target - 1) < 1e-12);
  assert.ok(Math.abs(Physics.momentMagnitude(total) - 9.1) < 1e-12);
});

// ================================================================
//  TSUNAMI
// ================================================================

test('calcTsunamiHeight — M9 at 100 km', () => {
  const H = Physics.calcTsunamiHeight(9.0, 100, 0.50, 3.30);
  // Expected ~1-5 m for M9 at 100 km
  assert.ok(H > 0.1 && H < 20, `M9@100km tsunami height ~1-5m, got ${H.toFixed(2)}`);
});

test('calcTsunamiHeight — distance decay', () => {
  const H10 = Physics.calcTsunamiHeight(8.0, 10, 0.50, 3.30);
  const H100 = Physics.calcTsunamiHeight(8.0, 100, 0.50, 3.30);
  assert.ok(H100 < H10, 'Tsunami height should decay with distance');
});

test('tsunamiWarningLevel — thresholds', () => {
  assert.strictEqual(Physics.tsunamiWarningLevel(0.1), null);
  assert.strictEqual(Physics.tsunamiWarningLevel(0.5), 'adv');
  assert.strictEqual(Physics.tsunamiWarningLevel(1.5), 'warn');
  assert.strictEqual(Physics.tsunamiWarningLevel(5.0), 'major');
});

test('tsunamiWarningLevel — conservative uplift changes alert rank, not trigger threshold', () => {
  assert.strictEqual(Physics.tsunamiWarningLevel(1.2, 0), 'warn');
  assert.strictEqual(Physics.tsunamiWarningLevel(1.2, 1), 'major');
  assert.strictEqual(Physics.tsunamiWarningLevel(0.5, 1), 'warn');
  assert.strictEqual(Physics.tsunamiWarningLevel(0.5, 2), 'major');
  assert.strictEqual(Physics.tsunamiWarningLevel(0.1, 2), null);
});

test('JMA regional forecast preserves physical height and separates conservative alert height', () => {
  const forecast = Physics.jmaTsunamiForecast(0.8, 0, 1.35);
  assert.strictEqual(forecast.physicalHeight, 0.8);
  assert.ok(Math.abs(forecast.alertHeight - 1.08) < 1e-9);
  assert.strictEqual(forecast.level, 'warn');
  assert.strictEqual(forecast.announcedHeight, '3m');
  const major = Physics.jmaTsunamiForecast(6, 0, 1);
  assert.strictEqual(major.level, 'major');
  assert.strictEqual(major.announcedHeight, '10m');
});

test('official JMA AreaTsunami dataset contains 66 unique forecast areas', () => {
  const areas = JSON.parse(fs.readFileSync(require.resolve('../public/geojson/jma_tsunami_forecast_areas.json'), 'utf8'));
  assert.strictEqual(areas.metadata.source, 'Japan Meteorological Agency');
  assert.strictEqual(areas.features.length, 66);
  assert.strictEqual(new Set(areas.features.map(feature => feature.properties.code)).size, 66);
  assert.ok(areas.features.every(feature => feature.geometry.type === 'MultiLineString' &&
    feature.geometry.coordinates.length > 0));
});

test('JMA tsunami basin gate separates opposite coasts without hiding gateways', () => {
  assert.strictEqual(Physics.jmaTsunamiAreaBasin('210'), 'pacific');
  assert.strictEqual(Physics.jmaTsunamiAreaBasin('340'), 'japanSea');
  assert.strictEqual(Physics.jmaTsunamiAreaBasin('312'), 'inner');
  assert.strictEqual(Physics.jmaTsunamiAreaBasin('730'), 'eastChina');
  assert.strictEqual(Physics.jmaTsunamiBasinTransmission('210', '250', 300), 1);
  assert.ok(Physics.jmaTsunamiBasinTransmission('210', '340', 400) < 0.02);
  assert.ok(Physics.jmaTsunamiBasinTransmission('210', '200', 350) >
    Physics.jmaTsunamiBasinTransmission('210', '340', 350));
  assert.ok(Physics.jmaTsunamiBasinTransmission('210', '312', 300) < 0.05);
  assert.ok(Physics.jmaTsunamiBasinTransmission('310', '312', 120) >= 0.2);
  assert.ok(Physics.jmaTsunamiBasinTransmission('202', '560', 700) < 0.03);
  assert.ok(Physics.jmaTsunamiBasinTransmission('730', '770', 400) > 0.3);
});

test('nearest wet-cell lookup chooses geometric nearest and does not jump across four cells', () => {
  const grid = {origin:[130,30],res:0.1,nx:7,ny:7,data:new Array(49).fill(10)};
  grid.data[3 * 7 + 2] = -20;
  grid.data[2 * 7 + 3] = -30;
  grid.data[3 * 7 + 6] = -100;
  const nearest = Physics.findNearestWetCell(grid, 30.3, 130.31, 2);
  assert.strictEqual(nearest.index, 3 * 7 + 2);
  const isolated = Physics.findNearestWetCell({origin:[130,30],res:0.1,nx:7,ny:7,
    data:new Array(49).fill(10).map((v,i)=>i===3*7+6?-100:v)}, 30.3, 130.3, 2);
  assert.strictEqual(isolated, null);
});

test('coastal warning coverage closes short holes without bridging separate islands', () => {
  const ringIds = Array.from({length:40}, (_, index) => index < 20 ? 1 : 2);
  const coverage = Physics.buildCoastalWarningCoverage([
    {segmentIndex:0, ringId:1, level:'warn'},
    {segmentIndex:10, ringId:1, level:'major'},
    {segmentIndex:20, ringId:2, level:'adv'},
    {segmentIndex:35, ringId:2, level:'adv'}
  ], 3, 10, ringIds);
  assert.strictEqual(coverage[5].ringId, '1');
  assert.ok(coverage[5].level === 'warn' || coverage[5].level === 'major');
  assert.strictEqual(coverage[17], undefined, 'coverage must not leak into another coastline ring');
  assert.strictEqual(coverage[27], undefined, 'a gap wider than one sample must remain quiet');
});

// ================================================================
//  EVENT FACTORY
// ================================================================

test('createEventState — mainshock properties', () => {
  const evt = Physics.createEventState(35.0, 140.0, 7.0, 30, 0, true);
  assert.strictEqual(evt.isMainshock, true);
  assert.strictEqual(evt.mag, 7.0);
  assert.strictEqual(evt.depth, 30);
  assert.strictEqual(evt.originTime, 0);
  assert.strictEqual(evt.pRadius, 0);
  assert.ok(evt.id.includes('event_main'));
});

test('createEventState — aftershock has orange color', () => {
  const evt = Physics.createEventState(35.0, 140.0, 6.0, 20, 120, false);
  assert.strictEqual(evt.isMainshock, false);
  assert.ok(evt.colorP.includes('255,140,40'), 'Aftershock should have orange P-wave color');
});

// ================================================================
//  AFTERSHOCK CATALOG
// ================================================================

test('generateAftershockCatalog — produces deterministic catalog', () => {
  const cat1 = Physics.generateAftershockCatalog(7.0, 35.0, 140.0, 45, 90, 30, 150, 0.1, 1.1, 0.9, 30);
  const cat2 = Physics.generateAftershockCatalog(7.0, 35.0, 140.0, 45, 90, 30, 150, 0.1, 1.1, 0.9, 30);
  assert.strictEqual(cat1.length, cat2.length, 'Same params should produce same catalog length');
  assert.strictEqual(cat1[0].time, cat2[0].time, 'Same params should produce same first event time');
});

test('aftershock catalog seed changes stochastic realization reproducibly', () => {
  const args = [7.0, 35.0, 140.0, 45, 60, 20, 150, 0.1, 1.1, 0.9, 30, 0, 1, 80, 'crustal'];
  const a = Physics.generateAftershockCatalog(...args, 1234);
  const b = Physics.generateAftershockCatalog(...args, 1234);
  const c = Physics.generateAftershockCatalog(...args, 5678);
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, c);
});

test('aftershock productivity uses the calibrated 10^0.809 magnitude slope', () => {
  // tools/data/etas-calibration-report.json: log10(N)/Mw = 0.809, replacing
  // the old 2^(M-5) law (slope 0.301, ~2.7x under-scaling per magnitude).
  const args = mw => [mw, 35.0, 140.0, 45, 90, 30, 150, 0.1, 1.1, 0.9, 30, 0, 1.0, 5000];
  const n5 = Physics.generateAftershockCatalog(...args(5.0)).length;
  const n6 = Physics.generateAftershockCatalog(...args(6.0)).length;
  const n7 = Physics.generateAftershockCatalog(...args(7.0)).length;
  assert.strictEqual(n5, 20, 'M5 display anchor unchanged (asyK=150 -> 20 events)');
  assert.strictEqual(n6, Math.floor(20 * Math.pow(10, Physics.AFTERSHOCK_PRODUCTIVITY_LOG10)),
    'M6 = anchor * 10^0.809');
  const slope = Math.pow(10, Physics.AFTERSHOCK_PRODUCTIVITY_LOG10);
  assert.ok(Math.abs(n7 / n6 - slope) < 0.06,
    `M7/M6 count ratio ${n7 / n6} must follow the calibrated slope ${slope.toFixed(3)} (old law: 2)`);
  assert.ok(Physics.AFTERSHOCK_PRODUCTIVITY_LOG10 > 0.7 && Physics.AFTERSHOCK_PRODUCTIVITY_LOG10 < 0.9,
    'calibrated slope stays inside the literature (Utsu/Reasenberg-Jones) 0.7-0.9 band');
});

test('ETAS branching alpha default is the calibrated natural-log productivity slope', () => {
  assert.ok(Math.abs(Physics.ETAS_ALPHA_NATLOG - Physics.AFTERSHOCK_PRODUCTIVITY_LOG10 * Math.LN10) < 1e-12,
    'ETAS_ALPHA_NATLOG = productivity slope in natural-log units');
  // The fallback (etasAlpha unset) must be the calibrated value, not 1.0.
  var catDefault = Physics.generateAftershockCatalog(6.5, 35.0, 140.0, 45, 90, 30,
    150, 0.1, 1.1, 0.9, 30, 1, undefined, 200);
  assert.ok(Array.isArray(catDefault) && catDefault.length > 0, 'ETAS with default alpha runs');
});

test('legacy waveform synthesis is deterministic by explicit seed', () => {
  const a = Physics.synthesizeWaveform(7, 80, 10, 1, 3, 20, 1234);
  const b = Physics.synthesizeWaveform(7, 80, 10, 1, 3, 20, 1234);
  const c = Physics.synthesizeWaveform(7, 80, 10, 1, 3, 20, 5678);
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, c);
});

test('generateAftershockCatalog — returns sorted by time', () => {
  const cat = Physics.generateAftershockCatalog(7.0, 35.0, 140.0, 45, 90, 30, 150, 0.1, 1.1, 0.9, 30);
  for (let i = 1; i < cat.length; i++) {
    assert.ok(cat[i].time >= cat[i-1].time, `Catalog must be sorted by time: ${cat[i].time} < ${cat[i-1].time}`);
  }
});

test('generateAftershockCatalog — magnitudes within bounds', () => {
  const cat = Physics.generateAftershockCatalog(7.0, 35.0, 140.0, 45, 90, 30, 150, 0.1, 1.1, 0.9, 30);
  for (const as of cat) {
    assert.ok(as.mag >= 4.0, `Mag ${as.mag} should be >= 4.0`);
    assert.ok(as.mag <= 6.5, `Mag ${as.mag} should be <= 6.5 (mainMw - 0.5)`);
  }
});

// ================================================================
//  BUILDING DAMAGE
// ================================================================

test('aggregateBuildingDamage — returns zero for empty circles', () => {
  const dmg = Physics.aggregateBuildingDamage([]);
  assert.strictEqual(dmg.wooden_total, 0);
  assert.strictEqual(dmg.rc_total, 0);
});

test('aggregateBuildingDamage — shindo 0 circles ignored', () => {
  const circles = [{ name: '東京都', shindo: 0, pga: 1 }];
  const dmg = Physics.aggregateBuildingDamage(circles);
  assert.strictEqual(dmg.wooden_total, 0);
});

// ================================================================
//  FORMATTING
// ================================================================

test('fmtSci — 1000000 formats as 1.00×10⁶', () => {
  const s = Physics.fmtSci(1000000);
  assert.ok(s.includes('1.00'), `Should start with 1.00, got: ${s}`);
  assert.ok(s.includes('10'), `Should include 10, got: ${s}`);
});

test('fmtTNT — renders appropriate units', () => {
  assert.ok(Physics.fmtTNT(500).includes('t'), '500t should stay in tons');
  assert.ok(Physics.fmtTNT(5000).includes('kt'), '5000t should become kilotons');
  assert.ok(Physics.fmtTNT(5e6).includes('Mt'), '5Mt should become megatons');
});

// ================================================================
//  KANNO ET AL. (2006) GMPE
// ================================================================

test('pgaKannoShallow — M7 at 50 km gives reasonable PGA', () => {
  const pga = Physics.pgaKannoShallow(7.0, 50, 400);
  assert.ok(pga > 10 && pga < 300, `M7@50km Kanno shallow PGA should be 20-200 gal, got ${pga.toFixed(1)}`);
});

test('pgvKannoShallow — M7 at 50 km gives reasonable PGV', () => {
  const pgv = Physics.pgvKannoShallow(7.0, 50, 400);
  assert.ok(pgv > 1 && pgv < 60, `M7@50km Kanno shallow PGV should be ~25 cm/s, got ${pgv.toFixed(2)}`);
});

test('pgaKannoDeep — M7 at 50 km deep source', () => {
  const pga = Physics.pgaKannoDeep(7.0, 50, 400);
  assert.ok(pga > 10 && pga < 600, `M7@50km Kanno deep PGA should be ~290 gal, got ${pga.toFixed(1)}`);
});

test('pgvKannoDeep — M7 at 50 km deep source', () => {
  const pgv = Physics.pgvKannoDeep(7.0, 50, 400);
  assert.ok(pgv > 1 && pgv < 60, `M7@50km Kanno deep PGV should be ~28 cm/s, got ${pgv.toFixed(2)}`);
});

test('pgaKanno — routes to shallow for depth <= 30', () => {
  const shallow = Physics.pgaKanno(7.0, 50, 20, 400);
  const expected = Physics.pgaKannoShallow(7.0, 50, 400);
  assert.strictEqual(shallow, expected, 'depth=20 should route to shallow');
});

test('pgaKanno — routes to deep for depth > 30', () => {
  const deep = Physics.pgaKanno(7.0, 50, 80, 400);
  const expected = Physics.pgaKannoDeep(7.0, 50, 400);
  assert.strictEqual(deep, expected, 'depth=80 should route to deep');
});

test('pgvKanno — routes to deep for depth > 30', () => {
  const deep = Physics.pgvKanno(7.0, 50, 80, 400);
  const expected = Physics.pgvKannoDeep(7.0, 50, 400);
  assert.strictEqual(deep, expected, 'depth=80 should route to deep PGV');
});

test('Kanno — M8 > M7 at same distance', () => {
  const pga7 = Physics.pgaKannoShallow(7.0, 100, 400);
  const pga8 = Physics.pgaKannoShallow(8.0, 100, 400);
  assert.ok(pga8 > pga7, 'M8 should produce higher PGA than M7');
});

test('Kanno — distance decay: 200km < 50km', () => {
  const pga50 = Physics.pgaKannoShallow(7.0, 50, 400);
  const pga200 = Physics.pgaKannoShallow(7.0, 200, 400);
  assert.ok(pga200 < pga50, 'PGA should decay with distance');
});

// ================================================================
//  Vs30 SITE AMPLIFICATION
// ================================================================

test('vs30Amplification — Vs30=400 gives moderate relative amplification', () => {
  const ampPGA = Physics.vs30Amplification(400, 'pga');
  const ampPGV = Physics.vs30Amplification(400, 'pgv');
  assert.ok(ampPGA > 1.1 && ampPGA < 1.5, `Vs30=400 PGA amp should be moderate, got ${ampPGA.toFixed(2)}`);
  assert.ok(ampPGV > 1.2 && ampPGV < 1.7, `Vs30=400 PGV amp should be moderate, got ${ampPGV.toFixed(2)}`);
});

test('vs30Amplification — softer soil amplifies more than harder rock', () => {
  const soft = Physics.vs30Amplification(200, 'pga');
  const hard = Physics.vs30Amplification(700, 'pga');
  assert.ok(soft > hard, `Vs30=200 (soft, ${soft.toFixed(1)}) should amplify more than Vs30=700 (hard, ${hard.toFixed(1)})`);
});

test('vs30Amplification — null/zero vs30 returns 1.0', () => {
  assert.strictEqual(Physics.vs30Amplification(0, 'pga'), 1.0);
  assert.strictEqual(Physics.vs30Amplification(null, 'pgv'), 1.0);
});

test('vs30Amplification — reference Vs30=760 is neutral', () => {
  assert.ok(Math.abs(Physics.vs30Amplification(760, 'pga') - 1.0) < 1e-12);
  assert.ok(Math.abs(Physics.vs30Amplification(760, 'pgv') - 1.0) < 1e-12);
});

test('Kanno — Vs30 site correction affects output', () => {
  const pgaSoft = Physics.pgaKannoShallow(7.0, 50, 200);
  const pgaHard = Physics.pgaKannoShallow(7.0, 50, 700);
  assert.ok(pgaSoft > pgaHard, 'Soft soil (Vs30=200) should produce higher PGA than hard rock (Vs30=700)');
});

// ================================================================
//  EDGE CASES
// ================================================================

test('edge — M9.5 magnitude saturation does not explode', () => {
  const pga = Physics.pgaLog(9.5, 50, 0.42, 1.34, 0.31, 0);
  const pga9 = Physics.pgaLog(9.0, 50, 0.42, 1.34, 0.31, 0);
  // Saturated M9.5 should be close to M9.0, not orders of magnitude larger
  const ratio = pga / pga9;
  assert.ok(ratio > 0.5 && ratio < 2.0, `M9.5/M9.0 PGA ratio should be near 1.0, got ${ratio.toFixed(2)}`);
});

test('edge — very deep event (depth 500km) IASP91 velocity', () => {
  // At 500km (transition zone: 410-660km), IASP91 P ≈ 8.5 km/s, S ≈ 4.6 km/s
  const vp = Physics.iasp91PVelocity(500);
  const vs = Physics.iasp91SVelocity(500);
  assert.ok(vp > 8.0 && vp < 10.0, `P-velocity at 500km should be ~8.5 km/s, got ${vp.toFixed(1)}`);
  assert.ok(vs > 4.0 && vs < 6.0, `S-velocity at 500km should be ~4.6 km/s, got ${vs.toFixed(1)}`);
});

test('edge — sourceType at extreme depths', () => {
  assert.strictEqual(Physics.sourceType(700), 'intraslab');
  assert.strictEqual(Physics.sourceType(0), 'crustal');
  assert.strictEqual(Physics.sourceType(-10), 'crustal', 'Negative depth defaults to crustal');
});

test('edge — pgaLog does not explode at Rkm=0', () => {
  const pga = Physics.pgaLog(7.0, 0, 0.42, 1.34, 0.31, 0);
  assert.ok(isFinite(pga) && pga > 0, `PGA at R=0 should be finite positive, got ${pga}`);
  assert.ok(pga < 10000, `PGA at R=0 should not be absurdly large, got ${pga.toFixed(1)}`);
});

test('edge — pgvLog near-field saturation (M9 at 5km)', () => {
  const pgv = Physics.pgvLog(9.0, 5, 0);
  assert.ok(isFinite(pgv) && pgv > 0 && pgv < 100, `Near-field PGV should be finite, got ${pgv.toFixed(2)}`);
});

test('edge — seismicMoment consistency with Mw', () => {
  // log10(M0) = 1.5*Mw + 9.1; Mw=5 → log10(M0)=16.6 → M0≈3.98e16
  const m0_5 = Physics.seismicMoment(5.0);
  const m0_7 = Physics.seismicMoment(7.0);
  assert.ok(m0_5 > 1e16 && m0_5 < 1e17, `Mw=5 Mo should be ~4e16, got ${m0_5.toExponential(1)}`);
  assert.ok(m0_7 > 1e19 && m0_7 < 1e20, `Mw=7 Mo should be ~4e19, got ${m0_7.toExponential(1)}`);
  // Mw+2 → Mo×1000
  const ratio = m0_7 / m0_5;
  assert.ok(ratio > 500 && ratio < 2000, `M7/M5 Mo ratio should be ~1000, got ${ratio.toFixed(0)}`);
});

test('edge — haversineDist NaN protection for antipodal points', () => {
  // Antipodal: Tokyo vs (-35.68, -40.24) — distance ~20000 km (half circumference)
  const d = Physics.haversineDist(35.68, 139.76, -35.68, -40.24);
  assert.ok(isFinite(d), `Antipodal distance should be finite, got ${d}`);
  assert.ok(d > 19000 && d < 21000, `Antipodal should be ~20000 km, got ${d.toFixed(0)}`);
});

test('edge — negative depth in hypoDist still works', () => {
  const d = Physics.hypoDist(36.0, 140.0, 36.0, 140.0, -5);
  assert.ok(isFinite(d) && d >= 0, `Negative depth hypoDist should be finite non-negative, got ${d}`);
});

// ================================================================
//  v4.1 — Zhao (2006) GMPE tests
// ================================================================
test('zhao2006 — PGA at M7 50km crustal within expected range', () => {
  const pga = Physics.pgaZhao2006(7.0, 50, 15, 'crustal', 400);
  assert.ok(pga > 50 && pga < 500, `PGA for M7@50km crustal should be 50-500 gal, got ${pga.toFixed(1)}`);
});

test('zhao2006 — interface PGA ≡ crustal PGA at all magnitudes (paper SI/QI/WI = 0 for PGA)', () => {
  // Zhao et al. (2006) Table 4: the interface-specific PGA coefficients are
  // SI=0.000, QI=0, WI=0 — interface and crustal share every other term, so
  // their PGA predictions coincide exactly. Differentiation only appears at
  // spectral periods (the PGV proxy uses the 1.0 s row, SI=-0.239).
  const pgaC = Physics.pgaZhao2006(7.0, 80, 20, 'crustal', 400);
  const pgaI = Physics.pgaZhao2006(7.0, 80, 20, 'interplate', 400);
  assert.ok(Math.abs(pgaI - pgaC) / pgaC < 1e-12, `Interplate PGA (${pgaI}) should equal crustal (${pgaC}) for PGA`);
  const pgvC = Physics.pgvZhao2006(7.0, 80, 20, 'crustal', 400);
  const pgvI = Physics.pgvZhao2006(7.0, 80, 20, 'interplate', 400);
  assert.ok(pgvI < pgvC, `Interplate 1s SA proxy PGV (${pgvI.toFixed(1)}) should be below crustal (${pgvC.toFixed(1)})`);
});

test('zhao2006 — PGA intraslab > crustal at same M/R (deep events radiate more)', () => {
  const pgaC = Physics.pgaZhao2006(7.0, 80, 50, 'crustal', 400);
  const pgaS = Physics.pgaZhao2006(7.0, 80, 50, 'intraslab', 400);
  assert.ok(pgaS > pgaC, `Intraslab PGA (${pgaS.toFixed(1)}) should exceed crustal (${pgaC.toFixed(1)})`);
});

test('zhao2006 — distance decay: PGA at 200km < PGA at 50km', () => {
  const pgaNear = Physics.pgaZhao2006(7.0, 50, 15, 'crustal', 400);
  const pgaFar = Physics.pgaZhao2006(7.0, 200, 15, 'crustal', 400);
  assert.ok(pgaFar < pgaNear, `Far PGA (${pgaFar.toFixed(1)}) should be less than near PGA (${pgaNear.toFixed(1)})`);
});

test('zhao2006 — magnitude scaling: M8 > M7 at same distance', () => {
  const pgaM7 = Physics.pgaZhao2006(7.0, 50, 15, 'crustal', 400);
  const pgaM8 = Physics.pgaZhao2006(8.0, 50, 15, 'crustal', 400);
  assert.ok(pgaM8 > pgaM7, `M8 PGA (${pgaM8.toFixed(1)}) should exceed M7 (${pgaM7.toFixed(1)})`);
});

// ============================================================
//  Somerville (1997) directivity — R0-1 (2026-08-24)
// ============================================================

test('somerville directivity — coefficient scales with magnitude', () => {
  assert.strictEqual(Physics.somervilleDirectivityCoefficient(4), 0.15);
  assert.strictEqual(Physics.somervilleDirectivityCoefficient(5), 0.15);
  assert.strictEqual(Physics.somervilleDirectivityCoefficient(7), 0.25);
  assert.strictEqual(Physics.somervilleDirectivityCoefficient(9), 0.35);
});

test('bearingRad — great-circle initial bearing (not planar atan2)', () => {
  const deg = r => r * 180 / Math.PI;
  assert.ok(Math.abs(deg(Physics.bearingRad(0, 0, 0, 1)) - 90) < 1e-9);
  assert.ok(Math.abs(deg(Physics.bearingRad(0, 0, 1, 0)) - 0) < 1e-9);
  // Destination built from equal-distance NE offsets at 44°N. The old planar
  // atan2(dLng, dLat) read ~54.3° here because it ignored the cos(lat) scale.
  const lat0 = 44, lng0 = 142, d = 0.2;
  const dLat = d * Math.SQRT1_2, dLng = d * Math.SQRT1_2 / Math.cos(lat0 * Math.PI / 180);
  assert.ok(Math.abs(deg(Physics.bearingRad(lat0, lng0, lat0 + dLat, lng0 + dLng)) - 45) < 0.3);
});

test('somerville directivity — full Bayless & Somerville (2013) replaces the PGA-only simplification', () => {
  const lat0 = 44, lng0 = 142, d = 0.2;
  const ctx = {
    source: { lat: lat0, lng: lng0, mw: 7, depthKm: 10, strikeDeg: 45, rakeDeg: 180, sourceType: 'crustal' },
    geometry: { lat: lat0, lng: lng0, L: 50, W: 20, depth: 10, strikeDeg: 45, dipDeg: 90, hypocenterFrac: 0.5 },
    gmpModel: 'zhao2006',
    options: { directivity: 'somerville1997', siteModel: 'none' }
  };
  const dLat = d * Math.SQRT1_2, dLng = d * Math.SQRT1_2 / Math.cos(lat0 * Math.PI / 180);
  const along = Physics.predictStationMotion(ctx, { lat: lat0 + dLat, lng: lng0 + dLng }, {});
  assert.ok(along, 'predictStationMotion returned null');
  // PGA anchors at the T=0.5 s row — zero by calibration
  assert.strictEqual(along.directivityFactor, 1, 'PGA row is zero in the coefficient table');
  // PGV at the T=1 s row: (C0 + C1*log10(s)*cos^2(theta)) * tapers — hand value
  const g = Physics.baylessSomervilleGeometry(ctx.source, ctx.geometry, lat0 + dLat, lng0 + dLng);
  assert.strictEqual(g.faultKind, 'strike', 'rake 180 routes strike-slip');
  assert.ok(Math.abs(g.sKm - 25) < 1e-9, 'bilateral centered rupture: s = L/2');
  const expect = -0.12 + 0.075 * Math.log10(25); // theta ~0 along strike
  assert.ok(Math.abs(along.pgvDirectivityFactor - Math.exp(expect)) < 0.01,
    `pgvDirectivityFactor ${along.pgvDirectivityFactor} vs exp(${expect.toFixed(4)})`);
  const back = Physics.predictStationMotion(ctx, { lat: lat0 - dLat, lng: lng0 - dLng }, {});
  // anti-parallel: theta ~0 again (cos^2 is symmetric), same factor — the
  // azimuthal lobes are double-ended under cos^2(theta)
  assert.ok(Math.abs(back.pgvDirectivityFactor - along.pgvDirectivityFactor) < 0.02);
  const across = Physics.predictStationMotion(ctx, { lat: lat0 + dLat, lng: lng0 - dLng }, {});
  // perpendicular: cos^2(90°)=0 -> only C0 remains
  assert.ok(Math.abs(across.pgvDirectivityFactor - Math.exp(-0.12)) < 0.01,
    'perpendicular keeps the C0 baseline only');
});

test('baylessSomervilleFD — frozen coefficients, tapers, geometry routing', () => {
  const T = Physics.BAYLESS_SOMMERVILLE_2013.periods;
  assert.deepEqual(T, [0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10]);
  const ss = Physics.BAYLESS_SOMMERVILLE_2013.strikeSlip.rotD50;
  assert.strictEqual(ss.c0[2], -0.12);   // Table 2.1 @1s
  assert.strictEqual(ss.c1[2], 0.075);
  assert.strictEqual(ss.c0[9], -0.30);   // @10s
  const ds = Physics.BAYLESS_SOMMERVILLE_2013.dipSlip.rotD50;
  assert.strictEqual(ds.c1[4], 0.034);   // Table 2.2 @2s — first nonzero
  assert.strictEqual(ds.c0[9], -0.176);  // @10s
  // coefficient interpolation between rows
  const mid = Physics._bsCoefficients('strike', 'rotD50', 1.25);
  assert.ok(Math.abs(mid.c0 - (-0.1475)) < 1e-12 && Math.abs(mid.c1 - 0.0825) < 1e-12);
  // geometric predictor: strike-slip cos^2(theta), s floor e
  const f0 = Physics.baylessSomervilleFD({ sKm: 100, thetaRad: 0, L: 200, W: 20, rrupKm: 30, mw: 7 }, 'strike', 'rotD50', 1);
  assert.ok(Math.abs(f0.geo - 2) < 1e-12, 'log10(100)*(0.5cos0+0.5)');
  const f90 = Physics.baylessSomervilleFD({ sKm: 100, thetaRad: Math.PI / 2, L: 200, W: 20, rrupKm: 30, mw: 7 }, 'strike', 'rotD50', 1);
  assert.strictEqual(f90.geo, 0, 'cos^2(90°) kills the geometry term');
  const fFloor = Physics.baylessSomervilleFD({ sKm: 0.5, thetaRad: 0, L: 200, W: 20, rrupKm: 30, mw: 7 }, 'strike', 'rotD50', 1);
  assert.ok(Math.abs(fFloor.geo - Math.log10(Math.E)) < 1e-12, 's floor = exp(1)');
  // dip-slip: cos(Rx/W as angle) and the sin^2(Az) taper
  const fd = Physics.baylessSomervilleFD({ dKm: 100, rxOverW: 0, azRad: Math.PI / 2, W: 20, rrupKm: 25, mw: 7 }, 'dip', 'rotD50', 2);
  assert.ok(Math.abs(fd.geo - 2) < 1e-12 && Math.abs(fd.tAz - 1) < 1e-12, 'broadside dip-slip');
  const fdEnd = Physics.baylessSomervilleFD({ dKm: 100, rxOverW: 0, azRad: 0, W: 20, rrupKm: 25, mw: 7 }, 'dip', 'rotD50', 2);
  assert.strictEqual(fdEnd.tAz, 0, 'off-the-end azimuth taper');
  const fdClamp = Physics.baylessSomervilleFD({ dKm: 100, rxOverW: -5, azRad: Math.PI / 2, W: 20, rrupKm: 25, mw: 7 }, 'dip', 'rotD50', 2);
  assert.ok(Math.abs(fdClamp.geo) < 1e-12, 'Rx/W clamped to -pi/2 -> cos = 0');
  // tapers: distance piecewise + magnitude
  const far = Physics.baylessSomervilleFD({ sKm: 100, thetaRad: 0, L: 100, W: 20, rrupKm: 150, mw: 7 }, 'strike', 'rotD50', 1);
  assert.strictEqual(far.tDist, 0, 'Rrup > L kills directivity');
  const small = Physics.baylessSomervilleFD({ sKm: 100, thetaRad: 0, L: 200, W: 20, rrupKm: 30, mw: 4.5 }, 'strike', 'rotD50', 1);
  assert.strictEqual(small.tMag, 0, 'M < 5 kills directivity');
  const mid5 = Physics.baylessSomervilleFD({ sKm: 100, thetaRad: 0, L: 200, W: 20, rrupKm: 30, mw: 5.75 }, 'strike', 'rotD50', 1);
  assert.ok(Math.abs(mid5.tMag - 0.5) < 1e-12, 'linear magnitude taper');
  // geometry routing incl. oblique
  const src = { lat: 35, lng: 140, mw: 7.5, depthKm: 10, strikeDeg: 0, dipDeg: 30 };
  const fp = { lat: 35, lng: 140, L: 100, W: 30, depth: 10, strikeDeg: 0, dipDeg: 30, hypocenterFrac: 0.5 };
  assert.strictEqual(Physics.baylessSomervilleGeometry({ ...src, rakeDeg: 90 }, fp, 35.3, 140).faultKind, 'dip');
  assert.strictEqual(Physics.baylessSomervilleGeometry({ ...src, rakeDeg: 45 }, fp, 35.3, 140).faultKind, null, 'oblique blends');
  // oblique blend: 45° rake = half dip + half strike
  const blend = Physics.baylessSomervilleLn({ ...src, rakeDeg: 45 }, fp, 35.3, 140);
  const pureS = Physics.baylessSomervilleLn({ ...src, rakeDeg: 0 }, fp, 35.3, 140);
  const pureD = Physics.baylessSomervilleLn({ ...src, rakeDeg: 90 }, fp, 35.3, 140);
  assert.ok(Math.abs(blend.lnPgv - 0.5 * (pureS.lnPgv + pureD.lnPgv)) < 1e-9, 'rake-weighted blend');
});

test('zhao2006 — PGV within reasonable range at M7 50km', () => {
  const pgv = Physics.pgvZhao2006(7.0, 50, 15, 'crustal', 400);
  assert.ok(pgv > 2 && pgv < 100, `PGV for M7@50km should be 2-100 cm/s, got ${pgv.toFixed(1)}`);
});

test('zhao2006 — soft soil (Vs30<760) amplifies relative to hard rock', () => {
  const pgaHard = Physics.pgaZhao2006(7.0, 50, 15, 'crustal', 1100);
  const pgaSoft = Physics.pgaZhao2006(7.0, 50, 15, 'crustal', 300);
  assert.ok(pgaSoft > pgaHard, `Soft soil PGA (${pgaSoft.toFixed(1)}) should exceed hard rock (${pgaHard.toFixed(1)})`);
});

test('zhao2006 — routed through calcPGA with gmpModel=zhao2006', () => {
  const pga = Physics.calcPGA(7.0, 50, 'zhao2006', 15, null, 7.0, 'crustal', 0.42, 1.34, 0.31, 0.003, 400);
  assert.ok(pga > 50 && pga < 500, `Routed PGA should be 50-500 gal, got ${pga.toFixed(1)}`);
});

test('zhao2006 — routed through calcPGV with gmpModel=zhao2006', () => {
  const pgv = Physics.calcPGV(7.0, 50, 'zhao2006', 15, null, 7.0, 'crustal', 0.003, 400);
  assert.ok(pgv > 2 && pgv < 100, `Routed PGV should be 2-100 cm/s, got ${pgv.toFixed(1)}`);
});

// ================================================================
//  v4.1 — Anelastic attenuation tests
// ================================================================
test('anelastic — non-zero anelastic reduces far-field PGA', () => {
  const pgaNear0 = Physics.pgaLog(7.0, 50, 0.42, 1.34, 0.31, 0);
  const pgaNear1 = Physics.pgaLog(7.0, 50, 0.42, 1.34, 0.31, 0.001);
  // At 50km: ratio = 10^(-k*Reff) = 10^(-0.001*75) ≈ 0.84
  const ratio = pgaNear1 / pgaNear0;
  assert.ok(ratio > 0.70 && ratio <= 1.0, `Near-field ratio k=0.001/0 should be 0.70-1.0, got ${ratio.toFixed(3)}`);
});

test('anelastic — non-zero anelastic significantly reduces far-field PGA', () => {
  const pgaFar0 = Physics.pgaLog(7.0, 300, 0.42, 1.34, 0.31, 0);
  const pgaFar1 = Physics.pgaLog(7.0, 300, 0.42, 1.34, 0.31, 0.001);
  // At 300km: ratio = 10^(-k*Reff) = 10^(-0.001*305) ≈ 0.50
  const ratio = pgaFar1 / pgaFar0;
  assert.ok(ratio < 0.8 && ratio > 0.3, `Far-field ratio k=0.001/0 should be 0.3-0.8, got ${ratio.toFixed(3)}`);
});

test('anelastic — PGV also affected by anelastic', () => {
  const pgv0 = Physics.pgvLog(7.0, 200, 0);
  const pgv1 = Physics.pgvLog(7.0, 200, 0.001);
  assert.ok(pgv1 < pgv0, `Anelastic PGV (${pgv1.toFixed(1)}) should be less than zero-k PGV (${pgv0.toFixed(1)})`);
});

// ================================================================
//  v4.1 — Vs30 amplification consistency tests
// ================================================================
test('vs30 — soft site (Vs30=200) amplifies more than reference (Vs30=760)', () => {
  const ampSoft = Physics.vs30Amplification(200, 'pga');
  const ampRef = Physics.vs30Amplification(760, 'pga');
  assert.ok(ampSoft > ampRef, `Soft amp (${ampSoft.toFixed(2)}) should exceed ref amp (${ampRef.toFixed(2)})`);
});

test('vs30 — hard rock (Vs30=1100) amplifies less than reference (Vs30=760)', () => {
  const ampHard = Physics.vs30Amplification(1100, 'pga');
  const ampRef = Physics.vs30Amplification(760, 'pga');
  assert.ok(ampHard < ampRef, `Hard rock amp (${ampHard.toFixed(2)}) should be less than ref amp (${ampRef.toFixed(2)})`);
});

test('vs30 — PGV amplification proportional to PGA', () => {
  const ampPGA = Physics.vs30Amplification(760, 'pga');
  const ampPGV = Physics.vs30Amplification(760, 'pgv');
  assert.ok(ampPGA > 0 && ampPGV > 0, 'Amplification should be positive');
});

// ================================================================
//  v4.3: GMPE SIGMA (aleatory variability)
// ================================================================

test('getGmpSigma — returns positive sigma for all models', () => {
  const models = ['log', 'si-midorikawa', 'log-ff', 'kanno2006', 'zhao2006', 'auto'];
  for (const m of models) {
    const s = Physics.getGmpSigma(m, 'crustal', 'pga');
    assert.ok(s > 0.1 && s < 0.9, `Sigma for ${m} should be 0.1-0.9, got ${s}`);
  }
});

test('getGmpSigma — Zhao2006 natural-log sigma is converted to log10', () => {
  const sCrustal = Physics.getGmpSigma('zhao2006', 'crustal', 'pga');
  // Paper Table 6: tau=0.303, phi=0.604 (ln units) -> total 0.676 -> 0.294 log10
  assert.ok(sCrustal > 0.28 && sCrustal < 0.31, `Zhao log10 sigma should be ~0.294, got ${sCrustal}`);
});

test('getGmpSigma — auto routing follows class-based selection', () => {
  assert.strictEqual(Physics.getGmpSigmaComponents('auto', 'crustal', 'pga', 7.4).model, 'si-midorikawa');
  assert.strictEqual(Physics.getGmpSigmaComponents('auto', 'interplate', 'pga', 8.5).model, 'zhao2006');
});

test('getGmpSigma — unknown model falls back to log sigma', () => {
  const s = Physics.getGmpSigma('unknown', 'crustal', 'pga');
  assert.strictEqual(s, Physics.LOG_SIGMA.sigmaT);
});

test('ZHAO2006_SIGMA — all source types have tau+phi=sigmaT relationship', () => {
  for (const src of ['crustal', 'interplate', 'intraslab']) {
    const z = Physics.ZHAO2006_SIGMA[src];
    const computed = Math.sqrt(z.tau * z.tau + z.phi * z.phi);
    assert.ok(Math.abs(computed - z.sigmaT) < 0.001,
      `Zhao ${src}: sqrt(tau^2+phi^2)=${computed.toFixed(3)} should equal sigmaT=${z.sigmaT}`);
  }
});

// ================================================================
//  v4.3: NONLINEAR SITE AMPLIFICATION (Seyhan & Stewart 2014)
// ================================================================

test('vs30AmplificationNL — at low rock PGA, result ≈ linear amp (f1 offset acceptable)', () => {
  const vs30 = 200;
  const lin = Physics.vs30Amplification(vs30, 'pga');
  const nlLo = Physics.vs30AmplificationNL(vs30, 'pga', 1.0); // 1 gal = very low shaking
  const nlHi = Physics.vs30AmplificationNL(vs30, 'pga', 500); // 500 gal = strong shaking
  // At low PGA, nonlinear reduction should be less than at high PGA
  // (f1 term gives ~10-15% baseline shift for soft soil)
  const ratioLo = nlLo / lin;
  const ratioHi = nlHi / lin;
  assert.ok(ratioLo > 0.80 && ratioLo < 0.95,
    `Low PGA NL/linear ratio should be 0.80-0.95, got ${ratioLo.toFixed(3)}`);
  assert.ok(ratioHi < ratioLo,
    `High PGA ratio (${ratioHi.toFixed(3)}) should be less than low PGA ratio (${ratioLo.toFixed(3)})`);
});

test('vs30AmplificationNL — at high rock PGA on soft soil, nonlinear < linear', () => {
  const vs30 = 200;
  const lin = Physics.vs30Amplification(vs30, 'pga');
  const nl = Physics.vs30AmplificationNL(vs30, 'pga', 500); // 500 gal = strong shaking
  assert.ok(nl < lin,
    `High PGA on soft soil: nonlinear (${nl.toFixed(2)}) should be less than linear (${lin.toFixed(2)})`);
  assert.ok(nl > 0.5,
    `Nonlinear amp should not be below 0.5, got ${nl.toFixed(2)}`);
});

test('vs30AmplificationNL — hard rock shows minimal nonlinear reduction', () => {
  const vs30 = 1100;
  const lin = Physics.vs30Amplification(vs30, 'pga');
  const nl = Physics.vs30AmplificationNL(vs30, 'pga', 500);
  const ratio = nl / lin;
  assert.ok(ratio > 0.95,
    `Hard rock NL/linear ratio should be >0.95, got ${ratio.toFixed(3)}`);
});

test('vs30AmplificationNL — null/zero inputs return linear amp', () => {
  const lin = Physics.vs30Amplification(400, 'pga');
  assert.strictEqual(Physics.vs30AmplificationNL(0, 'pga', 100), 1.0);
  assert.strictEqual(Physics.vs30AmplificationNL(null, 'pga', 100), 1.0);
  assert.strictEqual(Physics.vs30AmplificationNL(400, 'pga', 0), lin);
});

test('vs30AmplificationNL — PGV uses different coefficients than PGA', () => {
  const nlPga = Physics.vs30AmplificationNL(200, 'pga', 500);
  const nlPgv = Physics.vs30AmplificationNL(200, 'pgv', 50);
  // Both should be valid positive numbers
  assert.ok(nlPga > 0 && nlPgv > 0, 'Both PGA and PGV nonlinear amps should be positive');
});

// ================================================================
//  Zhao (2006) faithful paper site-class coefficients (Table 4)
// ================================================================

test('Zhao2006 — paper site-class arrays for PGA and 1.0 s SA', () => {
  for (const imt of ['pga', 'sa1']) {
    const row = Physics.ZHAO2006_PAPER[imt];
    assert.ok(Array.isArray(row.site) && row.site.length === 5,
      `ZHAO2006_PAPER.${imt}.site should hold the 5 paper classes [CH,C1,C2,C3,C4]`);
    for (const v of row.site) assert.ok(typeof v === 'number' && isFinite(v), `${imt} site terms must be finite`);
  }
  // Paper Table 4 PGA values (ln units, shared by every tectonic class)
  const s = Physics.ZHAO2006_PAPER.pga.site;
  assert.deepStrictEqual(s, [0.293, 1.111, 1.344, 1.355, 1.420]);
});

test('Zhao2006 — hard rock (CH) carries the lowest site term', () => {
  // Unlike the pre-paper table (which used SC_I = 0 as reference), the paper's
  // site terms are all relative to an implicit baseline; CH (>1100 m/s) is the
  // smallest, C4 (≤200 m/s soft soil) the largest.
  const pga = Physics.ZHAO2006_PAPER.pga.site;
  for (let i = 1; i < 5; i++) {
    assert.ok(pga[i] > pga[0], `site class ${i} (${pga[i]}) should exceed CH (${pga[0]})`);
  }
});

test('Zhao2006 — soft soil (C4) gives the largest amplification', () => {
  const pga = Physics.ZHAO2006_PAPER.pga.site;
  const sa1 = Physics.ZHAO2006_PAPER.sa1.site;
  for (let i = 0; i < 4; i++) {
    assert.ok(pga[4] >= pga[i], `PGA C4 (${pga[4]}) should be >= class ${i} (${pga[i]})`);
    assert.ok(sa1[4] > sa1[i], `1s SA C4 (${sa1[4]}) should exceed class ${i} (${sa1[i]})`);
  }
});

test('Zhao2006 — pgaZhao2006 uses site class from Vs30', () => {
  // Hard rock (Vs30=1200) should get SC_I → no boost
  const pgaHard = Physics.pgaZhao2006(7.0, 50, 30, 'crustal', 1200);
  // Soft soil (Vs30=200) should get SC_IV → significant boost
  const pgaSoft = Physics.pgaZhao2006(7.0, 50, 30, 'crustal', 200);
  assert.ok(pgaSoft > pgaHard,
    `Soft soil PGA (${pgaSoft.toFixed(1)}) should exceed hard rock PGA (${pgaHard.toFixed(1)})`);
  // Ratio should be > 2 (SC_V adjustment ~0.63 vs SC_I adjustment 0.0)
  assert.ok(pgaSoft / pgaHard > 2.0,
    `Soft/hard PGA ratio should be >2, got ${(pgaSoft/pgaHard).toFixed(1)}`);
});

test('Zhao2006 — _zhaoSiteClass returns 0-4 for valid Vs30 range', () => {
  const classes = [
    [2000, 0], [900, 1], [500, 2], [250, 3], [150, 4], [0, 2]
  ];
  for (const [vs30, expected] of classes) {
    const sc = Physics._zhaoSiteClass(vs30);
    assert.strictEqual(sc, expected, `Vs30=${vs30} should be class ${expected}, got ${sc}`);
  }
});

// ================================================================
//  v4.3: Vs30 ZONES AND REGIONAL Q
// ================================================================

test('lookupVs30 — Kanto basin returns low Vs30 (~180)', () => {
  var v = Physics.lookupVs30(35.6, 139.7); // Tokyo
  assert.ok(v > 100 && v < 300, `Kanto Vs30 should be 100-300, got ${v}`);
  assert.ok(v < 400, `Kanto should be softer than default 700`);
});

test('lookupVs30 — mountain area returns high Vs30 (~700)', () => {
  var v = Physics.lookupVs30(36.0, 138.0); // Nagano mountains
  assert.ok(v >= 500, `Mountain Vs30 should be >=500, got ${v}`);
});

test('lookupVs30 — station-specific value takes priority', () => {
  var v = Physics.lookupVs30(35.6, 139.7, 350); // Kanto with explicit Vs30
  assert.strictEqual(v, 350, 'Station Vs30 should override zone lookup');
});

test('lookupVs30Details — exposes station, external grid, zone and fallback provenance', () => {
  assert.deepStrictEqual(Physics.lookupVs30Details(35.6, 139.7, 350), { value:350, source:'station' });
  assert.deepStrictEqual(Physics.lookupVs30Details(35.6, 139.7, 350, () => ({value:420,source:'j-shis-grid'}), 'station-estimate'), {value:420,source:'j-shis-grid'});
  assert.deepStrictEqual(Physics.lookupVs30Details(35.6, 139.7, 350, () => ({value:420,source:'j-shis-grid'}), 'measured'), {value:350,source:'measured'});
  assert.deepStrictEqual(Physics.lookupVs30Details(36, 138, null, () => ({value:420, source:'test-grid'})), { value:420, source:'test-grid' });
  assert.strictEqual(Physics.lookupVs30Details(35.6, 139.7).source, 'regional-zone');
  assert.deepStrictEqual(Physics.lookupVs30Details(50, 150), { value:700, source:'fallback' });
});

test('resolveSourceType — explicit override wins, then event metadata, then depth', () => {
  assert.strictEqual(Physics.resolveSourceType(10, 'interplate', 'intraslab'), 'intraslab');
  assert.strictEqual(Physics.resolveSourceType(10, 'interplate', 'auto'), 'interplate');
  assert.strictEqual(Physics.resolveSourceType(70, null, 'auto'), 'intraslab');
});

test('calcJmaIntensity3C — returns finite intensity for three-component motion', () => {
  const rate = 20, n = 40;
  const x = Array.from({length:n}, (_, i) => 20 * Math.sin(2 * Math.PI * i / rate));
  const y = Array.from({length:n}, (_, i) => 10 * Math.sin(2 * Math.PI * i / rate));
  const z = new Array(n).fill(0);
  const value = Physics.calcJmaIntensity3C({x, y, z}, rate);
  assert.ok(Number.isFinite(value) && value > 0);
  assert.strictEqual(Physics.calcJmaIntensity3C({x:[], y:[], z:[]}, rate), null);
});

test('exceedanceProbability — is 50% at the median and monotonic', () => {
  assert.ok(Math.abs(Physics.exceedanceProbability(100, 0.3, 100) - 0.5) < 1e-6);
  assert.ok(Physics.exceedanceProbability(100, 0.3, 50) > 0.5);
  assert.ok(Physics.exceedanceProbability(100, 0.3, 200) < 0.5);
});

test('tsunamiTravelTime — integrates local shallow-water speeds', () => {
  const deep = Physics.tsunamiTravelTime(35, 140, 35, 141, () => 4000, 600, 20);
  const shallow = Physics.tsunamiTravelTime(35, 140, 35, 141, () => 100, 600, 20);
  assert.ok(deep > 0 && shallow > deep);
});

test('greenLawAmplification — amplifies toward shallow coast and respects cap', () => {
  assert.strictEqual(Physics.greenLawAmplification(null, 10, 5), 1);
  assert.ok(Physics.greenLawAmplification(4000, 20, 5) > 1);
  assert.ok(Physics.greenLawAmplification(1e9, 10, 3) <= 3);
});

test('lookupQ0 — Kyushu volcanic returns low Q (~100)', () => {
  var q = Physics.lookupQ0(32.0, 131.0);
  assert.ok(q > 80 && q < 150, `Kyushu Q0 should be 80-150, got ${q}`);
});

test('lookupQ0 — fore-arc returns high Q (>250)', () => {
  var q = Physics.lookupQ0(34.0, 134.0);
  assert.ok(q > 200, `Fore-arc Q0 should be >200, got ${q}`);
});

test('lookupQ0 — unknown area returns default 200', () => {
  assert.strictEqual(Physics.lookupQ0(50.0, 150.0), 200);
});

// ================================================================
//  v4.3: ETAS AFTERSHOCK
// ================================================================

test('ETAS — produces catalog with secondary triggering', () => {
  var cat = Physics.generateAftershockCatalog(9.1, 38.1, 142.8, 45, 10, 24,
    150, 0.1, 1.1, 0.9, 30, 1, 1.0, 200);
  assert.ok(cat.length > 20, `ETAS M9 catalog should be >20 events, got ${cat.length}`);
  assert.ok(cat.length <= 200, `ETAS catalog should respect cap of 200`);
  // Check sorted by time
  for (var i = 1; i < cat.length; i++)
    assert.ok(cat[i].time >= cat[i-1].time, `Catalog should be sorted by time`);
});

test('ETAS — Omori-Utsu path preserved with etasEnable=0', () => {
  var cat = Physics.generateAftershockCatalog(7.0, 35.0, 135.0, 45, 90, 30,
    150, 0.1, 1.1, 0.9, 30, 0, 1.0, 50); // catalogCap=50 → old behavior
  assert.ok(cat.length >= 10, `OU M7 catalog should be >=10 events, got ${cat.length}`);
  assert.ok(cat.length <= 50, `OU M7 capped at 50, got ${cat.length}`);
});

test('ETAS — respects catalogCap parameter', () => {
  var cat = Physics.generateAftershockCatalog(7.0, 35.0, 135.0, 45, 90, 30,
    150, 0.1, 1.1, 0.9, 30, 1, 1.0, 30);
  assert.ok(cat.length <= 30, `ETAS with cap=30 should have <=30 events, got ${cat.length}`);
});

// ================================================================
//  v5: RESEARCH-GRADE REGRESSION GUARDS
// ================================================================

test('Brune corner frequency uses a consistent physical unit system', () => {
  const fc = Physics.cornerFrequency(7.0, 10);
  assert.ok(fc > 0.03 && fc < 0.5, `Mw7, 10 MPa fc should be sub-Hz, got ${fc}`);
  assert.ok(Physics.cornerFrequency(6.0, 10) > fc, 'smaller event should have higher corner frequency');
});

test('physical duration grows with magnitude after Brune unit correction', () => {
  assert.ok(Physics.physicalDuration(8, 50, 10) > Physics.physicalDuration(6, 50, 10));
});

test('response-spectrum proxy is continuous at the corner period', () => {
  const Tg = 0.2 * 1.5;
  const left = Physics.calcResponseSpectrum(100, 1.5, Tg - 1e-7);
  const right = Physics.calcResponseSpectrum(100, 1.5, Tg + 1e-7);
  assert.ok(Math.abs(left - right) < 0.01, `spectrum jump at Tg: ${left} vs ${right}`);
});

test('Newmark SDOF spectrum returns finite positive PSA', () => {
  const r = Physics.sdofResponseSpectrum([0,100,-100,0,50,-50,0], 20, [0.2,1.0], 0.05);
  assert.strictEqual(r.length, 2);
  assert.ok(r.every(x => isFinite(x.psaGal) && x.psaGal > 0));
});

test('canonical source derives slip and preserves source metadata', () => {
  const s = Physics.createSourceModel({lat:38.1,lng:142.8,mw:9.1,depth:24,strike:193,dip:10,rake:88,sourceType:'interplate'});
  assert.ok(s.geometry && s.averageSlipM > 0);
  assert.strictEqual(s.rakeDeg, 88);
  assert.ok(Math.abs(Physics.momentMagnitude(s.momentNm) - 9.1) < 1e-12);
});

test('subduction prior resolves the shallow physical plane when nodal planes are swapped', () => {
  const fm = Physics.focalMechanism({strike:193,dip:12,rake:90,mw:8});
  const selected = Physics.selectFaultPlane({plane1:fm.plane2,plane2:fm.plane1}, {
    lat:38.1,lng:142.8,sourceType:'interplate'
  });
  assert.strictEqual(selected.index, 2);
  assert.strictEqual(selected.method, 'subduction-front-prior');
  assert.ok(Math.abs(selected.plane.dipDeg - 12) < 1e-8);
  assert.strictEqual(selected.ambiguous, false);
});

test('observed scalar moment controls Mw, geometry and every subsource moment', () => {
  const observedMw = 8.4;
  const momentNm = Physics.seismicMoment(observedMw);
  const fm = Physics.focalMechanism({strike:193,dip:12,rake:90,momentNm});
  const tensor = {tensor:fm.tensor,momentNm,provenance:{source:'test',eventId:'m0'}};
  const source = Physics.createSourceModel({lat:38.1,lng:142.8,mw:7,depth:24,
    sourceType:'interplate',momentTensor:tensor,generateSubSources:true,rupSpeed:2.8,
    faultOptions:{randomSeed:17}});
  const patchMoment = source.geometry.subs.reduce((sum, patch) => sum + patch.moment, 0);
  assert.ok(Math.abs(source.mw-observedMw) < 1e-10);
  assert.ok(Math.abs(source.geometry.mw-observedMw) < 1e-10);
  assert.ok(Math.abs(patchMoment/momentNm-1) < 1e-12);
  assert.ok(Math.abs(source.geometry.totalMoment/momentNm-1) < 1e-12);
});

test('tsunami source coupling suppresses pure strike-slip motion', () => {
  const thrust = Physics.createSourceModel({lat:38,lng:143,mw:8,depth:15,strike:190,dip:15,rake:90,sourceType:'interplate'});
  const strikeSlip = Physics.createSourceModel({lat:38,lng:143,mw:8,depth:15,strike:190,dip:90,rake:0,sourceType:'crustal'});
  assert.ok(Physics.tsunamiSourceAmplitude(thrust, 4000) > 0);
  assert.strictEqual(Physics.tsunamiSourceAmplitude(strikeSlip, 4000), 0);
  assert.strictEqual(Physics.tsunamiWaveContribution(strikeSlip, 50, 4000, 0.5, 3.3), 0,
    'rapid empirical forecast must not manufacture a tsunami for zero vertical slip');
});

test('unknown optional mechanism uses a tsunami source prior without weakening explicit strike slip', () => {
  const unknown = Physics.createSourceModel({lat:38,lng:143,mw:8,depth:20,strike:0,dip:90,rake:0,
    sourceType:'interplate',mechanismKnown:false});
  const explicit = Physics.createSourceModel({lat:38,lng:143,mw:8,depth:20,strike:0,dip:90,rake:0,
    sourceType:'interplate',mechanismKnown:true});
  assert.strictEqual(unknown.mechanismKnown, false);
  assert.ok(Physics.tsunamiDipSlipFactor(unknown) > 0);
  assert.ok(Physics.tsunamiWaveContribution(unknown, 50, 4000, 0.5, 3.3) > 0);
  assert.strictEqual(Physics.tsunamiWaveContribution(explicit, 50, 4000, 0.5, 3.3), 0);
});

test('aftershock sampling never produces negative time when p <= 1 is supplied', () => {
  const cat = Physics.generateAftershockCatalog(7,35,140,0,45,15,150,0.1,0.8,0.9,7,0,1,80,'crustal');
  assert.ok(cat.every(x => isFinite(x.time) && x.time >= 0));
});

test('bathymetric tsunami travel field routes through wet cells', () => {
  const grid = {origin:[140,35],res:0.1,nx:5,ny:5,data:new Array(25).fill(-1000)};
  // Central land cell should be avoided, not treated as a complete straight-line block.
  grid.data[2*5+2] = 10;
  const field = Physics.buildTsunamiTravelTimeField(grid,35.2,140.0,600);
  assert.ok(field && isFinite(field.lookup(35.2,140.4)));
  assert.ok(!isFinite(field.lookup(35.2,140.2)));
});

test('tsunami travel metadata identifies a coast shadowed by a land barrier', () => {
  const nx=11, ny=9;
  const grid={origin:[140,35],res:0.1,nx,ny,data:new Array(nx*ny).fill(-2000)};
  // A nearly complete north-south island forces the wave through a distant strait.
  for(let y=1;y<ny;y++) grid.data[y*nx+5]=20;
  const field=Physics.buildTsunamiTravelTimeField(grid,35.6,140.2,600);
  const meta=field.lookupMeta(35.6,140.8);
  assert.ok(isFinite(meta.travelTime), 'the sheltered coast remains reachable around the island');
  assert.ok(meta.pathDistance > meta.directDistance*1.5,
    `expected a substantial detour, ratio=${meta.detourRatio}`);
  assert.ok(Physics.tsunamiPathAttenuation(meta.detourRatio,true) < 0.01,
    'land shadow plus the detour should suppress a rapid advisory');
});

test('numerical tsunami height never falls back to an empirical warning', () => {
  const quietSolver={sample:()=>0, samplePeak:()=>0};
  const peakSolver={sample:()=>0.01, samplePeak:()=>0.37};
  assert.strictEqual(Physics.tsunamiModeledHeight(quietSolver,35,140),0);
  assert.strictEqual(Physics.tsunamiWarningLevel(Physics.tsunamiModeledHeight(quietSolver,35,140)),null);
  assert.strictEqual(Physics.tsunamiModeledHeight(peakSolver,35,140),0.37);
});

test('coastal tsunami height includes unresolved nearshore shoaling', () => {
  const solver={samplePeak:()=>1.3, sampleWaterDepth:()=>1600};
  const coastHeight=Physics.tsunamiCoastalHeight(solver,35,140,10,5);
  assert.ok(coastHeight > 4.5 && coastHeight < 4.7,
    `1.3 m at 1600 m depth should shoal to about 4.6 m, got ${coastHeight}`);
  const shadowed={samplePeak:()=>0.01, sampleWaterDepth:()=>1600};
  assert.ok(Physics.tsunamiCoastalHeight(shadowed,35,140,10,5) < 0.2,
    'near-zero shadow-zone waves must remain below advisory level after shoaling');
});

test('layered travel times are causal, monotonic, and P arrives before S', () => {
  const p50 = Physics.pTravelTime(50, 30);
  const p100 = Physics.pTravelTime(100, 30);
  const s50 = Physics.sTravelTime(50, 30);
  assert.ok(isFinite(p50) && p50 > 0);
  assert.ok(p100 > p50, `P travel time should increase with distance: ${p50} -> ${p100}`);
  assert.ok(s50 > p50, `S arrival ${s50} should follow P arrival ${p50}`);
  assert.ok(Physics.pTravelTime(50, 30, 7) < p50,
    'raising the configured surface velocity should shorten the layered travel time');
});

test('stochastic three-component JMA intensity is finite and deterministic by seed', () => {
  const a = Physics.calcStochasticJmaIntensity(6.5, 40, 120, 10, 50, 12345);
  const b = Physics.calcStochasticJmaIntensity(6.5, 40, 120, 10, 50, 12345);
  assert.ok(isFinite(a) && a > 0, `expected positive finite intensity, got ${a}`);
  assert.strictEqual(a, b);
});

test('linear tsunami solver remains finite and advances on a wet grid', () => {
  const grid = {origin:[140,35],res:0.05,nx:21,ny:21,data:new Array(21*21).fill(-2000)};
  const source = Physics.createSourceModel({lat:35.5,lng:140.5,mw:8,depth:15,strike:0,dip:20,rake:90,sourceType:'interplate'});
  const solver = Physics.createLinearTsunamiSolver(grid, source);
  assert.ok(solver && solver.stableDt > 0 && isFinite(solver.stableDt));
  assert.ok(solver.sourceAmplitude > 0);
  assert.ok(Number.isFinite(solver.initialSourceResidual),
    `finite-domain DC3D integral must be reported, residual=${solver.initialSourceResidual}`);
  solver.advanceTo(600);
  assert.ok(Math.abs(solver.getTime() - 600) < 1e-6);
  assert.ok(isFinite(solver.sample(35.5, 140.5)));
  const snapshot = solver.getSnapshot(1);
  assert.ok(snapshot.maxSurfaceElevation >= 0 && snapshot.maxWaveHeight >= 0);
  assert.ok(snapshot.maxVelocity >= 0);
  assert.ok(snapshot.cells.some(cell => cell.arrivalTime !== null));
});

test('linear tsunami solver starts with zero displacement for pure strike-slip', () => {
  const grid = {origin:[140,35],res:0.1,nx:9,ny:9,data:new Array(81).fill(-3000)};
  const source = Physics.createSourceModel({lat:35.4,lng:140.4,mw:7.5,depth:12,strike:0,dip:90,rake:0,sourceType:'crustal'});
  const solver = Physics.createLinearTsunamiSolver(grid, source);
  assert.strictEqual(solver.sourceAmplitude, 0);
  solver.advanceTo(300);
  assert.strictEqual(solver.sample(35.4, 140.4), 0);
});

test('research grid validation requires terrain land and water cells', () => {
  const grid = {origin:[140,35],res:0.1,nx:3,ny:3,data:[-10,-10,-10,-10,2,-10,-10,-10,-10],meta:{dataset:'test'}};
  const result = Physics.validateResearchGrid(grid, 'terrain');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.landCells, 1);
  assert.strictEqual(result.waterCells, 8);
  assert.strictEqual(Physics.validateResearchGrid({...grid,data:new Array(9).fill(-10)}, 'terrain').valid, false);
});

test('research grid validation rejects any non-finite cell', () => {
  const grid={origin:[130,30],res:0.1,nx:2,ny:2,data:[-100,10,NaN,-20]};
  const result=Physics.validateResearchGrid(grid,'terrain');
  assert.strictEqual(result.valid,false);
  assert.ok(result.errors.includes('non-finite-cells'));
  assert.strictEqual(Physics.createNonlinearTsunamiSolver(grid,{
    lat:30,lng:130,depthKm:10,dipDeg:30,rakeDeg:90,strikeDeg:0,averageSlipM:1
  },{}),null);
});

test('research grid validation rejects malformed geometry and numeric strings', () => {
  const malformed={origin:['130',30],res:0.1,nx:2.5,ny:2,data:[-10,5,-20,8]};
  const result=Physics.validateResearchGrid(malformed,'terrain');
  assert.strictEqual(result.valid,false);
  assert.ok(result.errors.includes('origin'));
  assert.ok(result.errors.includes('geometry'));
  const stringCell={origin:[130,30],res:0.1,nx:2,ny:2,data:[-10,5,'-20',8]};
  assert.ok(Physics.validateResearchGrid(stringCell,'terrain').errors.includes('non-finite-cells'));
});

test('research grid bilinear lookup preserves continuous values', () => {
  const grid = {origin:[0,0],res:1,nx:2,ny:2,data:[0,10,20,30]};
  assert.strictEqual(Physics.lookupResearchGrid(grid, 0.5, 0.5), 15);
  assert.strictEqual(Physics.lookupResearchGrid(grid, 2, 2), null);
});

test('analytical Okada deformation resolves thrust and strike-slip components', () => {
  const grid = {origin:[140,35],res:0.05,nx:31,ny:31,data:new Array(31*31).fill(-2000),meta:{quality:'test'}};
  const thrust = Physics.createSourceModel({lat:35.75,lng:140.75,mw:8,depth:15,strike:0,dip:20,rake:90,sourceType:'interplate'});
  const strike = Physics.createSourceModel({lat:35.75,lng:140.75,mw:8,depth:15,strike:0,dip:90,rake:0,sourceType:'crustal'});
  const deformation = Physics.buildOkadaDeformation(grid, thrust);
  assert.ok(deformation.maxUplift > 0 && deformation.maxSubsidence < 0);
  assert.strictEqual(deformation.method,'okada-dc3d-1992-surface');
  assert.ok(Number.isFinite(deformation.volumeResidualM3));
  const strikeDeformation = Physics.buildOkadaDeformation(grid, strike);
  assert.ok(strikeDeformation.data.every(Number.isFinite));
  assert.ok(Math.max(...strikeDeformation.data.map(Math.abs)) < Math.max(deformation.maxUplift,Math.abs(deformation.maxSubsidence)));
  const unknown=Physics.createSourceModel({lat:35.75,lng:140.75,mw:8,depth:15,strike:0,dip:90,rake:0,
    sourceType:'interplate',mechanismKnown:false});
  const inferredDeformation=Physics.buildOkadaDeformation(grid,unknown);
  assert.ok(inferredDeformation.maxUplift>0,
    'an untouched optional mechanism must initialize the numerical tsunami solver');
});

test('Okada volume correction does not impose a basin-wide sea-level offset', () => {
  const nx=101, ny=61;
  const grid={origin:[135,35],res:0.1,nx,ny,data:new Array(nx*ny).fill(-3000),meta:{quality:'test'}};
  const source=Physics.createSourceModel({lat:38,lng:143,mw:9,depth:20,strike:190,dip:12,rake:90,sourceType:'interplate'});
  const deformation=Physics.buildOkadaDeformation(grid,source);
  const farIndex=Math.round((38-grid.origin[1])/grid.res)*nx+Math.round((136-grid.origin[0])/grid.res);
  // The elastic far field decays smoothly with distance; it must not become a
  // uniform basin-wide offset. Guard relative to the peak: 600+ km away the
  // displacement stays below 2% of the maximum uplift.
  assert.ok(Math.abs(deformation.data[farIndex]) < Math.max(1e-4,0.02*deformation.maxUplift),
    `far basin should remain near rest, displacement=${deformation.data[farIndex]}, maxUplift=${deformation.maxUplift}`);
});

test('Okada patch deformation is linear in physical slip, not moment metadata', () => {
  const grid={origin:[140,35],res:0.05,nx:24,ny:24,data:new Array(24*24).fill(-3000)};
  function sourceWithFraction(momentFraction){
    return {lat:35.5,lng:140.5,depthKm:12,strikeDeg:0,dipDeg:20,rakeDeg:90,
      mechanismKnown:true,averageSlipM:2,geometry:{L:20,W:10,nStrike:1,nDip:1,
        subs:[{lat:35.5,lng:140.5,depth:12,slipM:2,slipWeight:3,momentFraction}]}};
  }
  const low=Physics.buildOkadaDeformation(grid,sourceWithFraction(0.1));
  const high=Physics.buildOkadaDeformation(grid,sourceWithFraction(0.9));
  assert.strictEqual(low.method,'okada-dc3d-1992-surface');
  assert.strictEqual(low.slipWeighting,'linear');
  assert.ok(Math.abs(low.maxUplift-high.maxUplift)<1e-10);
  assert.ok(Math.abs(low.maxSubsidence-high.maxSubsidence)<1e-10);
});

test('nonlinear SWE preserves a lake at rest and advances stably', () => {
  const nx=25, ny=21, data=[];
  for(let y=0;y<ny;y++) for(let x=0;x<nx;x++) data.push(x<17 ? -100 : (x-17)*2);
  const grid={origin:[140,35],res:0.02,nx,ny,data,meta:{quality:'test'}};
  const still=Physics.createNonlinearTsunamiSolver(grid,null,{initialState:()=>({eta:0}),dryTolerance:0.02});
  still.advanceTo(1200);
  assert.strictEqual(still.getSnapshot(1).cells.length, 0);
  const thrust=Physics.createSourceModel({lat:35.2,lng:140.2,mw:7.5,depth:10,strike:0,dip:20,rake:90,sourceType:'interplate'});
  const wave=Physics.createNonlinearTsunamiSolver(grid,thrust,{dryTolerance:0.02});
  wave.advanceTo(1200);
  const snapshot=wave.getSnapshot(1);
  const diagnostics=wave.getDiagnostics();
  assert.ok(snapshot.cells.length > 0);
  assert.ok(isFinite(wave.getStableDt()) && wave.getStableDt() > 0);
  assert.ok(snapshot.cells.every(cell => isFinite(cell.eta) && isFinite(cell.maxDepth)));
  assert.ok(diagnostics.steps > 0);
  assert.ok(diagnostics.maxCfl <= diagnostics.cflLimit + 1e-12,
    `CFL ${diagnostics.maxCfl} exceeds ${diagnostics.cflLimit}`);
  assert.strictEqual(diagnostics.nonFiniteCorrections, 0);
  assert.strictEqual(diagnostics.nonFiniteCells, 0);
  assert.strictEqual(diagnostics.gridNx, nx);
  assert.strictEqual(diagnostics.gridNy, ny);
  assert.strictEqual(diagnostics.cellCount, nx*ny);
  assert.ok(Number.isFinite(diagnostics.massResidualFraction));
  assert.deepStrictEqual(snapshot.diagnostics, diagnostics);
  assert.strictEqual(Physics.assessTsunamiNumericalHealth(diagnostics).level, 'healthy');
});

test('tsunami numerical health separates pending, warning, and unstable runs', () => {
  const base={steps:100,cellCount:1000,maxCfl:0.37,cflLimit:0.38,massResidualFraction:0,
    nonFiniteCells:0,nonFiniteCorrections:0,negativeDepthCorrections:0};
  assert.strictEqual(Physics.assessTsunamiNumericalHealth({...base,steps:0}).level,'pending');
  const warning=Physics.assessTsunamiNumericalHealth({...base,massResidualFraction:0.002});
  assert.strictEqual(warning.level,'warning');
  assert.ok(warning.reasons.includes('massWarning'));
  const unstable=Physics.assessTsunamiNumericalHealth({...base,maxCfl:0.4,nonFiniteCells:1});
  assert.strictEqual(unstable.level,'unstable');
  assert.ok(unstable.reasons.includes('cflExceeded')&&unstable.reasons.includes('nonFinite'));
});

test('nonlinear SWE wets initially dry coastal cells and records run-up', () => {
  const nx=50,ny=30,data=[];
  for(let y=0;y<ny;y++) for(let x=0;x<nx;x++) data.push(x<30 ? -Math.max(0.2,(30-x)*2) : Math.min(3,(x-30)*0.1));
  const grid={origin:[0,0],res:0.002,nx,ny,data,meta:{quality:'test'}};
  const source=Physics.createSourceModel({lat:0.03,lng:0.045,mw:10,depth:1,strike:0,dip:5,rake:90,sourceType:'interplate'});
  const solver=Physics.createNonlinearTsunamiSolver(grid,source,{dryTolerance:0.001,manning:0});
  solver.advanceTo(900);
  const snapshot=solver.getSnapshot(1);
  assert.ok(snapshot.maxRunup > 0);
  assert.ok(snapshot.maxInundation > 0);
  assert.ok(snapshot.inundatedAreaKm2 > 0);
  assert.ok(snapshot.maxInundationDistanceKm >= 0);
  assert.ok(snapshot.maxVelocity > 0);
  assert.ok(snapshot.maxSurfaceElevation > 0 && snapshot.maxWaveHeight > 0);
  assert.ok(snapshot.inundationZones.length > 0);
  assert.ok(snapshot.cells.some(cell => cell.arrivalTime !== null && cell.maxVelocity >= 0));
  assert.ok(snapshot.cells.some(cell => cell.terrain >= 0 && cell.maxDepth > 0));
});

test('second-order reconstruction preserves a deep-ocean pulse the first-order flux dissipates', () => {
  const nx=201,ny=5,length=5000,res=(length/(nx-1))/111320,H=20,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(y===0||y===ny-1?1:-H);
  const grid={origin:[0,0],res,nx,ny,data,meta:{quality:'test'}};
  const c=Math.sqrt(9.80665*H);
  function pulse(options){
    const solver=Physics.createNonlinearTsunamiSolver(grid,null,Object.assign({
      initialState:cell=>{
        const x=cell.x*length/(nx-1),eta=0.5*Math.exp(-0.5*Math.pow((x-1500)/180,2));
        return {eta,u:c*eta/(H+eta)};
      },dryTolerance:0.001,manning:0,coriolis:false,boundary:'radiation'},options||{}));
    solver.advanceTo(180);
    let peak=0;
    for(let x=1;x<nx-1;x++)peak=Math.max(peak,solver.sampleState(2*res,x*res).eta);
    return peak;
  }
  const secondOrder=pulse(),firstOrder=pulse({secondOrderDepthGate:1e9});
  assert.ok(secondOrder>0.44,`MUSCL should preserve the pulse, peak=${secondOrder}`);
  assert.ok(firstOrder<0.38,`first-order flux should visibly dissipate the pulse, peak=${firstOrder}`);
  assert.ok(secondOrder>firstOrder*1.2);
});

test('radiation boundary preserves a lake at rest on sloping edge bathymetry', () => {
  // Regression: the transmissive edge used to copy the interior water DEPTH
  // into boundary cells. Across a sloping boundary bed that fabricates an eta
  // jump at the edge face on every step, pumping water in or out until the
  // whole run explodes (the "tsunami data only breaks in NLSWE+runup mode"
  // report). Copying the free surface must hold rest exactly.
  const nx=24,ny=16,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){
    let depth=-400-10*Math.min(x,nx-1-x)-5*Math.min(y,ny-1-y);
    if(x===0)depth=-80-15*(y%4);      // west edge shallower than its interior neighbour
    if(x===nx-1)depth=-900;           // east edge deeper
    if(y===0)depth=-60-10*(x%3);      // south edge shallower
    if(y===ny-1)depth=-700;           // north edge deeper
    if(x>=20&&y>=13)depth=5;          // land block meeting the deeper east/north edges
    data.push(depth);
  }
  const grid={origin:[140,30],res:0.05,nx,ny,data,meta:{quality:'test'}};
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{initialState:()=>({eta:0}),boundary:'radiation',coriolis:false,manning:0,dryTolerance:0.05});
  solver.advanceTo(600);
  const snapshot=solver.getSnapshot(1);
  const diagnostics=solver.getDiagnostics();
  assert.ok(snapshot.maxEta<0.01,`radiation edges must not fabricate waves, maxEta=${snapshot.maxEta}`);
  assert.ok(snapshot.maxVelocity<0.01,`radiation edges must not fabricate currents, maxVelocity=${snapshot.maxVelocity}`);
  assert.ok(Math.abs(diagnostics.massResidualFraction)<1e-6,
    `mass should be conserved at rest, got ${diagnostics.massResidualFraction}`);
  assert.strictEqual(diagnostics.nonFiniteCorrections,0);
});

test('open boundary stays stable around sharp coastal topography over long integrations', () => {
  // Regression: a plain zero-gradient open boundary is ill-posed for the
  // 2-D SWE — diffracted energy around an isolated land cell wound up a
  // domain-scale gyre (50+ m/s currents, 60+ m eta anomalies, even at first
  // order). The sponge band along open water edges must absorb that mode.
  const nx=102,ny=6,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(x===50&&y===3?5:-500);
  const grid={origin:[0,0],res:0.02,nx,ny,data,meta:{quality:'test'}};
  const H=500,c=Math.sqrt(9.80665*H);
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{
    initialState:cell=>{
      const x=cell.x*0.02*111320,eta=0.5*Math.exp(-0.5*Math.pow((x-30000)/4000,2));
      return {eta,u:c*eta/(H+eta)};
    },dryTolerance:0.01,manning:0,coriolis:false,boundary:'radiation'});
  solver.advanceTo(32000);
  const snapshot=solver.getSnapshot(2);
  assert.ok(snapshot.maxEta<1.0,`open-boundary gyre must not develop, maxEta=${snapshot.maxEta}`);
  assert.ok(snapshot.maxVelocity<1.0,`open-boundary gyre must not develop, maxVelocity=${snapshot.maxVelocity}`);
});

test('second-order scheme stays stable in a closed sloshing basin', () => {
  // Regression: the unsplit 2-D MUSCL update needs a tighter CFL number than
  // the first-order flux; at 0.38 a closed-basin sloshing mode grew without
  // bound (maxEta > 100 m within hours). The MUSCL CFL is fixed at 0.15.
  const nx=102,ny=6,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(x>=100&&y>=4?5:-500);
  const grid={origin:[0,0],res:0.02,nx,ny,data,meta:{quality:'test'}};
  const H=500,c=Math.sqrt(9.80665*H);
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{
    initialState:cell=>{
      const x=cell.x*0.02*111320,eta=0.5*Math.exp(-0.5*Math.pow((x-30000)/4000,2));
      return {eta,u:c*eta/(H+eta)};
    },dryTolerance:0.01,manning:0,coriolis:false,boundary:'wall'});
  solver.advanceTo(32000);
  const snapshot=solver.getSnapshot(2);
  const diagnostics=solver.getDiagnostics();
  assert.ok(snapshot.maxEta<1.0,`closed-basin sloshing must stay bounded, maxEta=${snapshot.maxEta}`);
  assert.ok(snapshot.maxVelocity<1.0,`closed-basin sloshing must stay bounded, maxVelocity=${snapshot.maxVelocity}`);
  assert.ok(diagnostics.maxCfl<=diagnostics.cflLimit+1e-12);
});


test('seabed deformation does not fabricate water on dry land cells', () => {
  const nx=41,ny=21,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(x<20?-800:2);
  const grid={origin:[140,35],res:0.02,nx,ny,data,meta:{quality:'test'}};
  const source=Physics.createSourceModel({lat:35.2,lng:140.25,mw:8,depth:10,strike:0,dip:20,rake:90,sourceType:'interplate',generateSubSources:true});
  const solver=Physics.createNonlinearTsunamiSolver(grid,source,{dryTolerance:0.02,manning:0,dynamicDeformation:false});
  const snapshot=solver.getSnapshot(1);
  assert.ok(snapshot.maxSurfaceElevation>0.1,'source deformation should displace the water column');
  assert.ok(snapshot.cells.every(cell=>cell.terrain<0||cell.maxDepth===0),
    'uplifted land cells must start dry; wave-driven wetting handles flooding');
});

test('whole-fault DC3D fallback uses the full scaling-relation geometry', () => {
  const nx=101,ny=61;
  const grid={origin:[135,35],res:0.1,nx,ny,data:new Array(nx*ny).fill(-3000),meta:{quality:'test'}};
  const source=Physics.createSourceModel({lat:38,lng:143,mw:9,depth:20,strike:190,dip:12,rake:90,sourceType:'interplate'});
  const deformation=Physics.buildOkadaDeformation(grid,source);
  assert.strictEqual(deformation.patches,1);
  assert.ok(deformation.maxUplift>2,`whole-fault Mw9 uplift should reach metres, got ${deformation.maxUplift}`);
  let deformed=0;
  for(let i=0;i<nx*ny;i++)if(Math.abs(deformation.data[i])>0.05)deformed++;
  assert.ok(deformed>500,`deformation should span the full fault length, cells=${deformed}`);
});

test('coastal land cells receive a Green-law shoreline run-up estimate', () => {
  const nx=101,ny=5,length=5000,res=(length/(nx-1))/111320,H=400,data=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)data.push(y===0||y===ny-1?1:(x<nx-5?-H:0));
  const grid={origin:[0,0],res,nx,ny,data,meta:{quality:'test'}};
  const c=Math.sqrt(9.80665*H);
  const solver=Physics.createNonlinearTsunamiSolver(grid,null,{
    initialState:cell=>{
      const x=cell.x*length/(nx-1),eta=0.4*Math.exp(-0.5*Math.pow((x-1500)/250,2));
      return {eta,u:cell.terrain<0?c*eta/(H+eta):0};
    },dryTolerance:0.01,manning:0,coriolis:false,boundary:'wall'});
  solver.advanceTo(120);
  const snapshot=solver.getSnapshot(1);
  assert.ok(snapshot.cells.some(cell=>cell.terrain>=0&&(cell.estDepth||0)>0.1),
    'shoreline estimate should flood the z=0 coastal strip once the wave arrives');
  assert.ok(snapshot.inundationZones.length>0&&snapshot.maxInundation>0.1);
});

test('observed three-component analysis returns JMA intensity and component spectra', () => {
  const rate=50,n=500,x=[],y=[],z=[];
  for(let i=0;i<n;i++){const t=i/rate;x.push(80*Math.sin(2*Math.PI*t));y.push(40*Math.sin(3*Math.PI*t));z.push(20*Math.sin(5*Math.PI*t));}
  const result=Physics.analyzeObservedMotion3C({sampleRate:rate,components:{x,y,z},source:'unit-test'},[0.2,1]);
  assert.ok(result && result.intensity > 0 && result.pgaVectorGal > 0);
  assert.strictEqual(result.spectra.x.length,2);
  assert.strictEqual(result.source,'unit-test');
});

// ================================================================
//  wavePhaseEnvelope / waveSRampDur — P coda -> S ramp station envelope
// ================================================================

test('wavePhaseEnvelope — silent before P, weak during the P phase', () => {
  assert.strictEqual(Physics.wavePhaseEnvelope(9.9, 10, 30, 7), 0);
  const atP = Physics.wavePhaseEnvelope(10, 10, 30, 7);
  const midP = Physics.wavePhaseEnvelope(20, 10, 30, 7);
  const justBeforeS = Physics.wavePhaseEnvelope(29.99, 10, 30, 7);
  assert.ok(Math.abs(atP - 0.05) < 1e-9, 'P arrival starts at 5% of peak');
  assert.ok(atP < midP && midP < justBeforeS && justBeforeS <= 0.12 + 1e-9,
    'P coda grows slowly and never exceeds 12% of peak');
});

test('wavePhaseEnvelope — ramps to peak over waveSRampDur after S', () => {
  const ramp = Physics.waveSRampDur(7); // 4.5 s
  assert.ok(Math.abs(Physics.wavePhaseEnvelope(30, 10, 30, 7) - 0.12) < 1e-9, '0.12 at S arrival');
  const half = Physics.wavePhaseEnvelope(30 + ramp / 2, 10, 30, 7);
  assert.ok(half > 0.5 && half < 0.62, 'mid-ramp ~0.56, got ' + half);
  assert.strictEqual(Physics.wavePhaseEnvelope(30 + ramp, 10, 30, 7), 1);
  assert.strictEqual(Physics.wavePhaseEnvelope(30 + ramp + 30, 10, 30, 7), 1,
    'stays at peak (caller applies hold/decay)');
});

test('waveSRampDur — magnitude scaling and clamps', () => {
  assert.strictEqual(Physics.waveSRampDur(4), 2, 'small events: 2 s floor');
  assert.strictEqual(Physics.waveSRampDur(5), 2);
  assert.strictEqual(Physics.waveSRampDur(7), 4.5);
  assert.strictEqual(Physics.waveSRampDur(9), 7.5);
  assert.strictEqual(Physics.waveSRampDur(15), 12, '12 s cap');
});

test('P-phase ceiling constants map below the shindo 5- intensity threshold', () => {
  assert.ok(Physics.calcJmaIntensity(Physics.P_PHASE_MAX_PGA, 0) < 4.5, 'PGA cap 66 gal');
  assert.ok(Physics.calcJmaIntensity(0.02, Physics.P_PHASE_MAX_PGV) < 4.5, 'PGV cap 11 cm/s');
  assert.ok(Physics.calcJmaIntensity(Physics.P_PHASE_MAX_PGA, Physics.P_PHASE_MAX_PGV) < 4.5,
    'combined caps stay below I4.5');
});

test('wavePhaseEnvelope — M9 near-field scenario: no 5- reading at P arrival', () => {
  // The reported bug: 0.15 floor × a great-quake peak leaked 震度5-/6+ at P
  // arrival. With the new envelope + PGA ceiling the P-phase display must
  // stay at 震度4 or below even for a 2500 gal peak.
  const peakPga = 2500, peakPgv = 250;
  const env = Physics.wavePhaseEnvelope(12, 12, 26, 9); // P just arrived (pToS ~ 14 s at 100 km)
  const pga = Math.min(peakPga * env, Physics.P_PHASE_MAX_PGA);
  const pgv = Math.min(peakPgv * env, Physics.P_PHASE_MAX_PGV);
  const I = Physics.calcJmaIntensity(pga, pgv);
  assert.ok(I < 4.5, 'P-phase intensity ' + I.toFixed(2) + ' must stay below 4.5');
  // legacy envelope for contrast: 0.15 × 2500 gal = 375 gal -> I 6.24 (6-)
  const legacy = Physics.calcJmaIntensity(peakPga * 0.15, peakPgv * 0.15);
  assert.ok(legacy >= 5.5, 'documents the old bug magnitude: I ' + legacy.toFixed(2));
});

// ================================================================
//  Great-quake saturation (Zhao 2006 extrapolation guard)
// ================================================================

test('zhao2006 — intrinsic near-source saturation via the c·exp(d·M) pseudo-depth', () => {
  // The paper's distance term -ln(R + c·exp(d·M)) saturates on its own:
  // the per-magnitude PGA growth at fixed near-field distance decelerates
  // beyond ~M8 (no external magnitude compression exists any more).
  const p7 = Physics.pgaZhao2006(7.0, 30, 20, 'interplate', 400);
  const p8 = Physics.pgaZhao2006(8.0, 30, 20, 'interplate', 400);
  const p9 = Physics.pgaZhao2006(9.0, 30, 20, 'interplate', 400);
  assert.ok(p9 > p8 && p8 > p7, 'monotonic in magnitude');
  assert.ok(p8 / p7 > p9 / p8, `near-field growth should decelerate: M8/M7=${(p8/p7).toFixed(2)} vs M9/M8=${(p9/p8).toFixed(2)}`);
});

test('zhao2006 — M9 near field stays at physically plausible levels', () => {
  // The pre-paper implementation needed a tanh+magnitude-compression guard to
  // avoid 12,718 gal at M9@30km; the faithful model predicts ~600 gal there
  // (published regression predates M9 records) and never explodes anywhere.
  const pga = Physics.pgaZhao2006(9.0, 30, 20, 'interplate', 400);
  const pgv = Physics.pgvZhao2006(9.0, 30, 20, 'interplate', 400);
  assert.ok(pga > 300 && pga < 1200, 'M9@30km PGA ' + pga.toFixed(0) + ' gal in the paper-model range');
  assert.ok(pgv > 30 && pgv < 150, 'M9@30km PGV ' + pgv.toFixed(0) + ' cm/s in the paper-model range');
  const extreme = Physics.pgaZhao2006(9.5, 5, 10, 'crustal', 150);
  assert.ok(extreme < Physics.GMPE_PGA_SOFT_CAP, 'even M9.5@5km stays below the display soft cap');
});

// (Replaced by the intrinsic c·exp(d·M) pseudo-depth tests above — no
// external magnitude-compression guard exists in the faithful model.)

// (Replaced — the tanh display cap only matters beyond observed records.)

test('zhao2006 saturation — monotonic across the pivot', () => {
  const a = Physics.pgaZhao2006(8.0, 30, 20, 'interplate');
  const b = Physics.pgaZhao2006(8.5, 30, 20, 'interplate');
  const c = Physics.pgaZhao2006(9.0, 30, 20, 'interplate');
  const d = Physics.pgaZhao2006(9.3, 30, 20, 'interplate');
  assert.ok(a < b && b < c && c < d, 'PGA must keep growing with M (no flat/reversed spots)');
});

test('shindoUncertaintyRange — ±1σ symmetric around the prediction', () => {
  const r = Physics.shindoUncertaintyRange(5.2);
  assert.ok(Math.abs(Physics.GMPE_SHINDO_SIGMA - 2.23 * Physics.ZHAO2006_SIGMA.crustal.sigmaT) < 1e-12);
  assert.ok(r.sigma > 0.6 && r.sigma < 0.8, 'sigma in JMA-intensity units ~0.71, got ' + r.sigma);
  assert.ok(Math.abs(r.low - (5.2 - r.sigma)) < 1e-12 && Math.abs(r.high - (5.2 + r.sigma)) < 1e-12);
  assert.strictEqual(r.lowLabel, '5-');  // 5.2-0.65 = 4.55 -> 5弱
  assert.strictEqual(r.highLabel, '6-'); // 5.2+0.65 = 5.85 -> 6弱
});

test('shindoUncertaintyRange — clamps at zero and rejects invalid input', () => {
  const r = Physics.shindoUncertaintyRange(0.3);
  assert.strictEqual(r.low, 0);
  assert.ok(r.high > 0);
  assert.strictEqual(Physics.shindoUncertaintyRange(NaN), null);
  assert.strictEqual(Physics.shindoUncertaintyRange(-1), null);
  assert.strictEqual(Physics.shindoUncertaintyRange('x'), null);
});

test('shindoUncertaintyRange — labels follow the 10-step bands', () => {
  const r = Physics.shindoUncertaintyRange(6.3); // 6強
  assert.strictEqual(Physics.intensityToShindo(6.3), '6+');
  assert.ok(String(r.highLabel).startsWith('6') || String(r.highLabel) === '7', 'high label 6+~7, got ' + r.highLabel);
});

test('gmpe calibration — set/validate/apply by magnitude bin', () => {
  assert.strictEqual(Physics.calibrateIntensity(2.0, 3.0), 2.0, 'identity without a table');
  assert.strictEqual(Physics.setGmpeCalibration({ schema: 'wrong' }), false);
  assert.strictEqual(Physics.gmpeCalibration, null);
  const table = { schema: 'quake-sim-gmpe-calibration-v1', bins: [
    { minM: 0, maxM: 4.5, deltaI: -0.9 },
    { minM: 4.5, maxM: 5.5, deltaI: 0 },
    { minM: 5.5, maxM: 6.5, deltaI: 0 },
    { minM: 6.5, maxM: 99, deltaI: 0 }
  ] };
  assert.strictEqual(Physics.setGmpeCalibration(table), true);
  assert.strictEqual(Physics.calibrateIntensity(2.0, 3.1), 1.1, 'M3.1 uses bin 0');
  assert.strictEqual(Physics.calibrateIntensity(2.0, 5.0), 2.0, 'M5 bin is zero');
  assert.strictEqual(Physics.calibrateIntensity(0.5, 3.1), 0, 'clamped at zero');
  assert.ok(Number.isNaN(Physics.calibrateIntensity(NaN, 3.1)), 'NaN passthrough');
  Physics.setGmpeCalibration(null);
  assert.strictEqual(Physics.calibrateIntensity(2.0, 3.1), 2.0);
});

// ================================================================
//  LONG-PERIOD GROUND MOTION (JMA LPCM prediction)
// ================================================================

test('calcLongPeriodSv — invalid inputs return the zero class', () => {
  for (const [m, d, p] of [[0, 50, 100], [7, 50, 0], [7, 50, -1], [NaN, 50, 100], [7, 50, NaN]]) {
    const r = Physics.calcLongPeriodSv(m, d, p);
    assert.strictEqual(r.lpcClass, 0);
    assert.strictEqual(r.svCms, 0);
  }
});

test('calcLongPeriodSv — calibrated against JMA observation anchors', () => {
  // Tohoku 2011: class 4 observed across Kanto (soft sites, ~350 km)
  assert.strictEqual(Physics.calcLongPeriodSv(9.1, 350, 80).lpcClass, 4);
  // Noto 2024-11 (M6.6 西方沖): max observed class 2
  assert.strictEqual(Physics.calcLongPeriodSv(6.6, 50, 300).lpcClass, 2);
  // Hyuganada 2024 (M7.1): max observed class 3
  assert.strictEqual(Physics.calcLongPeriodSv(7.1, 50, 250).lpcClass, 3);
  // M5 events essentially never carry a JMA long-period class
  assert.strictEqual(Physics.calcLongPeriodSv(5.0, 20, 200).lpcClass, 0);
});

test('calcLongPeriodSv — sv scales linearly with PGA', () => {
  const a = Physics.calcLongPeriodSv(7.0, 100, 100);
  const b = Physics.calcLongPeriodSv(7.0, 100, 200);
  assert.ok(Math.abs(b.svCms / a.svCms - 2) < 1e-9);
});

test('calcLongPeriodSv — magnitude corner: great events hold the band', () => {
  // Same PGA and distance: an M9 keeps far more 1.6-7.8 s energy than an M5
  const m9 = Physics.calcLongPeriodSv(9.0, 100, 100);
  const m5 = Physics.calcLongPeriodSv(5.0, 100, 100);
  assert.ok(m9.svCms > 5 * m5.svCms, 'M9 sv ' + m9.svCms + ' vs M5 ' + m5.svCms);
});

test('calcLongPeriodSv — Q spares long periods PGA loses', () => {
  // Same PGA at the station: the far-field event is relatively richer in
  // the long-period band (high frequencies attenuated harder along the way)
  const far = Physics.calcLongPeriodSv(8.0, 400, 100);
  const near = Physics.calcLongPeriodSv(8.0, 30, 100);
  assert.ok(far.svCms > near.svCms, 'far ' + far.svCms + ' vs near ' + near.svCms);
});

test('calcLongPeriodSv — class follows the official 5/15/50/100 cm/s bounds', () => {
  // sv is linear in PGA, so steer PGA onto each side of every threshold
  const base = Physics.calcLongPeriodSv(7.5, 120, 100);
  for (let i = 0; i < Physics.LPCM_THRESHOLDS_CMS.length; i++) {
    const th = Physics.LPCM_THRESHOLDS_CMS[i];
    const above = Physics.calcLongPeriodSv(7.5, 120, 100 * (th * 1.02) / base.svCms);
    const below = Physics.calcLongPeriodSv(7.5, 120, 100 * (th * 0.98) / base.svCms);
    assert.strictEqual(above.lpcClass, i + 1, 'above ' + th);
    assert.strictEqual(below.lpcClass, i, 'below ' + th);
  }
});

test('calcLongPeriodSv — peak period stays inside the 1.6-7.8 s band', () => {
  for (const [m, d] of [[5.5, 20], [7.0, 100], [9.1, 350]]) {
    const r = Physics.calcLongPeriodSv(m, d, 150);
    assert.ok(r.peakPeriod >= 1.6 - 1e-9 && r.peakPeriod <= 7.8 + 1e-9);
  }
});

test('calcLPGM — delegates to the band-max Sv estimate', () => {
  for (const [m, d, p] of [[9.1, 350, 80], [6.6, 50, 300], [7.1, 50, 250]]) {
    assert.strictEqual(Physics.calcLPGM(m, d, p, 1.5), Physics.calcLongPeriodSv(m, d, p).lpcClass);
  }
});

// ================================================================
//  2026-08-23 audit regressions
// ================================================================

test('ETAS catalog — every child has finite lat/lng/depth (gauss NaN regression)', () => {
  // The ETAS gauss() used uninitialized u1/u2 so every child coordinate was
  // NaN (undefined === 0 is false — the loops never ran).
  const cat = Physics.generateAftershockCatalog(7.5, 36.0, 140.0, 20, 30, 25,
    150, 0.1, 1.1, 0.9, 30, 1, null, 200, null, 42);
  assert.ok(cat.length > 0, 'ETAS branch should produce children');
  for (const c of cat) {
    assert.ok(isFinite(c.lat) && isFinite(c.lng) && isFinite(c.depth), 'finite coords');
    assert.ok(c.lat > 24 && c.lat < 46 && c.lng > 122 && c.lng < 150, 'coords stay near Japan');
  }
});

test('layeredTravelTime — far stations get a first-arrival head wave (Pn) that beats the surface crawl', () => {
  // Shallow source: the old stack stopped at the source depth, so a 2000 km
  // station rode a degenerate direct ray at ~6.5 km/s instead of mantle Pn.
  const tFar = Physics.pTravelTime(2000, 30);
  const tSurf = 2000 / 8.04; // Moho head-wave floor
  assert.ok(tFar > 0 && isFinite(tFar));
  assert.ok(tFar <= tSurf + 60, 'far P arrival must not be slower than the Moho crawl');
  // near-field unaffected: still slower than a straight surface line
  const tNear = Physics.pTravelTime(100, 30);
  assert.ok(tNear > 100 / 8.04, 'near P arrival keeps the layered (slower) path');
});
