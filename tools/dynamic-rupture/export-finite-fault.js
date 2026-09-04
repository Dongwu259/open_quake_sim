// Export an offline dynamic-rupture run (2D fault line) to the browser's
// finite-fault-v1 contract (R6-2 re-import path).
//
// The solver models an along-strike-uniform 2D fault (a line in the
// (fault-normal, depth) plane). The exporter represents each fault node as
// one patch with an EXPLICIT along-strike extent (`alongStrikeKm`, default
// 30 km = the SCEC fault length) so the model's seismic moment corresponds
// to a finite rupture; the along-strike uniformity is stated in the
// provenance block and must not be read as a 3D dynamic result.
'use strict';

function exportFiniteFault(state, opts) {
  opts = opts || {};
  if (!state || !state.slip) throw new TypeError('solver state required');
  const strike = opts.strikeDeg != null ? opts.strikeDeg : 90;
  const dip = opts.dipDeg != null ? opts.dipDeg : 90;
  const rake = opts.rakeDeg != null ? opts.rakeDeg : 180; // right-lateral
  const alongStrikeKm = opts.alongStrikeKm || 30;
  const lat0 = opts.hypoLat != null ? opts.hypoLat : 38.0;
  const lng0 = opts.hypoLng != null ? opts.hypoLng : 142.0;
  const mu = state.mu;
  const rigidityGPa = mu / 1e9;
  const patches = [];
  // v6.2 tier-2 pipeline: dip-aware patch placement. The solver models the
  // down-dip line through (lat0, lng0); for a dipping plane the patch centre
  // at depth z lies at horizontal offset z/tan(dip) along the dip direction
  // (bearing = strike + 90°). dip = 90 keeps the legacy vertical placement
  // (zero offset) byte-identical.
  const dipRad = dip * Math.PI / 180;
  const downdipHorizFactor = Math.cos(dipRad) / Math.max(Math.sin(dipRad), 1e-6);
  const dipDirRad = (strike + 90) * Math.PI / 180;
  const cosLat0 = Math.max(1e-4, Math.cos(lat0 * Math.PI / 180));
  function placeAt(depthM) {
    const offKm = (depthM / 1000) * downdipHorizFactor;
    if (offKm === 0) return { lat: lat0, lng: lng0 };
    return {
      lat: lat0 + offKm * Math.cos(dipDirRad) / 111.32,
      lng: lng0 + offKm * Math.sin(dipDirRad) / (111.32 * cosLat0)
    };
  }
  let idx = 0;
  for (let j = 0; j < state.nz; j++) {
    const depth = state.zOf(j);
    if (depth < state.dx / 2) continue;                 // skip mirror/air rows
    const slip = state.slip[j];
    if (!(slip > 0)) continue;
    if (state.rupTime[j] == null || state.rupTime[j] < 0) continue;
    idx++;
    const at = placeAt(depth);
    patches.push({
      id: String(idx),
      lat: at.lat, lng: at.lng,
      depthKm: depth / 1000,
      strikeDeg: strike, dipDeg: dip, rakeDeg: rake,
      slipM: slip,
      lengthKm: alongStrikeKm,
      widthKm: state.dx / 1000,
      rigidityGPa,
      ruptureTime: state.rupTime[j],
      riseTime: (state.riseTime && state.riseTime[j] > 0) ? state.riseTime[j] : 1
    });
  }
  if (!patches.length) throw new Error('no ruptured fault nodes to export');
  const totalMoment = patches.reduce((v, p) => v + mu * p.lengthKm * 1e3 * p.widthKm * 1e3 * p.slipM, 0);
  return {
    schema: 'quake-sim-finite-fault-v1',
    id: opts.eventId || ('dynamic-rupture-' + (opts.label || 'run')),
    event: {
      id: opts.eventId || 'dynrup-2d',
      lat: lat0, lng: lng0,
      depthKm: opts.hypoDepthKm != null ? opts.hypoDepthKm : (patches.reduce((v, p) => v + p.depthKm * p.slipM, 0) / patches.reduce((v, p) => v + p.slipM, 0)),
      mw: (Math.log10(totalMoment) - 9.1) / 1.5,
      momentNm: totalMoment
    },
    patches,
    defaults: { rigidityGPa, sourceTimeFunction: 'half-cosine' },
    provenance: {
      source: opts.sourceLabel || 'quake_sim offline dynamic-rupture solver (2D velocity-stress FD + TSN slip-weakening)',
      format: 'dynamic-rupture-export-v1',
      url: opts.provenanceUrl || '',
      license: 'MIT (this repository)',
      notes: '2D along-strike-uniform rupture (anti-plane reduction); along-strike extent '
        + alongStrikeKm + ' km is a geometric assumption of the export, not a computed result'
    }
  };
}

module.exports = { exportFiniteFault };
