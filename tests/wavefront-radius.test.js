// ================================================================
//  Physics.wavefrontRadiusKm — layered wavefront radius (ring clock)
//  The ring radii must ride the SAME layered-IASP91 clock as station
//  activations (preComputeArrivals -> pTravelTime/sTravelTime). These
//  tests lock the inversion identity, monotonicity, the shallow/deep
//  regimes and the cache behaviour.
//  Run with:  node --test tests/wavefront-radius.test.js
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const Physics = require('../public/physics.js');

// The core invariant: radius(travel(X)) must land back on X (2 km table +
// linear interpolation -> a few-km tolerance; the head-wave crossover kink
// gets a wider band).
function identityCase(phase, depthKm, v, xs, tolKm, label) {
  const fn = phase === 'S' ? Physics.sTravelTime : Physics.pTravelTime;
  for (const X of xs) {
    const t = fn(X, depthKm, v);
    const r = Physics.wavefrontRadiusKm(phase, t, depthKm, v);
    assert.ok(
      Math.abs(r - X) <= tolKm,
      `${label}: X=${X}km t=${t.toFixed(2)}s -> radius ${r.toFixed(1)}km (tol ${tolKm})`
    );
  }
}

test('identity — shallow P (depth 30, v 5.8) inverts the layered clock', () => {
  identityCase('P', 30, 5.8, [0, 50, 100, 200, 300, 400, 500, 700, 1000, 1500, 2500], 3, 'P d30');
});

test('identity — shallow S (depth 10, v 3.4)', () => {
  identityCase('S', 10, 3.4, [0, 40, 120, 250, 420, 600, 900, 1400], 3, 'S d10');
});

test('identity — deep source rides the head wave without losing the inverse', () => {
  identityCase('P', 400, 5.8, [0, 100, 300, 600, 1000, 1800, 2500], 4, 'P d400');
});

test('identity — depth 0 linear branch is exact', () => {
  const v = 5.8;
  for (const t of [1, 5, 20, 100]) {
    const r = Physics.wavefrontRadiusKm('P', t, 0, v);
    assert.ok(Math.abs(r - t * v) < 1e-6, `depth0 t=${t} -> ${r}`);
  }
});

test('radius is 0 before the surface is reached and monotone afterwards', () => {
  const d = 30, v = 5.8;
  const tSurf = Physics.pTravelTime(0, d, v); // vertical one-way time
  assert.equal(Physics.wavefrontRadiusKm('P', 0, d, v), 0);
  assert.equal(Physics.wavefrontRadiusKm('P', -3, d, v), 0);
  assert.equal(Physics.wavefrontRadiusKm('P', tSurf * 0.5, d, v), 0);
  let prev = 0;
  for (let t = tSurf; t <= tSurf + 120; t += 2) {
    const r = Physics.wavefrontRadiusKm('P', t, d, v);
    assert.ok(r >= prev, `monotone at t=${t}: ${r} < ${prev}`);
    prev = r;
  }
});

test('the ring now reaches the layered activation front (regression: discs lit up ahead)', () => {
  // Straight-ray ring at 50 s / depth 30 / v 5.8 was sqrt(290^2-30^2) ≈ 288 km,
  // while layered first arrivals lit stations near 300+ km. The layered radius
  // must sit at the layered front, strictly outside the old straight-ray one.
  const d = 30, v = 5.8, t = 50;
  const straight = Math.sqrt((t * v) ** 2 - d * d);
  const layeredAt300 = Physics.pTravelTime(300, d, v);
  assert.ok(layeredAt300 < t, `layered travel to 300km (${layeredAt300.toFixed(2)}s) should beat 50s`);
  const r = Physics.wavefrontRadiusKm('P', t, d, v);
  assert.ok(r > straight, `layered radius ${r.toFixed(1)} must exceed straight-ray ${straight.toFixed(1)}`);
  assert.ok(r > 300, `radius passes the 300 km station line at 50 s (got ${r.toFixed(1)})`);
  // Self-consistent inversion: travel(radius) must land back on the elapsed time.
  const tBack = Physics.pTravelTime(r, d, v);
  assert.ok(Math.abs(tBack - t) < 0.05, `travel(radius=${r.toFixed(1)})=${tBack.toFixed(3)}s should equal ${t}s`);
});

test('beyond-table extrapolation keeps growing with the tail slope', () => {
  const d = 30, v = 5.8;
  const tMax = Physics.pTravelTime(Physics.WAVEFRONT_RADIUS_MAX_KM, d, v);
  const r1 = Physics.wavefrontRadiusKm('P', tMax + 10, d, v);
  const r2 = Physics.wavefrontRadiusKm('P', tMax + 20, d, v);
  assert.ok(r1 > Physics.WAVEFRONT_RADIUS_MAX_KM, `r1=${r1}`);
  assert.ok(r2 > r1, 'monotone past the table');
  assert.ok(r2 - r1 > 0 && r2 - r1 < 500, `sane slope past the table (${(r2 - r1).toFixed(1)}km/10s)`);
});

test('memo table is reused and evicted (cache stays bounded)', () => {
  const r = Physics.wavefrontRadiusKm('P', 50, 30, 5.8); // warms a table
  assert.equal(Physics.wavefrontRadiusKm('P', 50, 30, 5.8), r);
  assert.ok(Object.keys(Physics._wavefrontTables).length >= 1);
  // More than 96 distinct (phase,depth,v) keys resets the cache wholesale.
  for (let d = 1; d <= 130; d += 1) Physics.wavefrontRadiusKm('P', 60, d, 5.8);
  assert.ok(Object.keys(Physics._wavefrontTables).length <= 96, 'cache bounded after eviction');
  // And the physics is still exact after the reset (rebuild is transparent).
  identityCase('P', 30, 5.8, [120, 450], 3, 'post-eviction P d30');
});
