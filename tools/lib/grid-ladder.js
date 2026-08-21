'use strict';
// Pure grid helpers shared by tools/export-geoclaw-case.js and
// tests/geoclaw-case.test.js — no I/O, no side effects.

/** Aggregate K x K cells (plain mean) -> a K*res grid. Mean-of-cell-means:
 *  coastal cells inherit land into the average, matching GeoClaw's
 *  cell-average bathymetry convention. Residual edge cells are dropped. */
function coarsenGrid(g, K) {
  if (!(K > 1)) return g;
  const nx = Math.floor(g.nx / K), ny = Math.floor(g.ny / K);
  if (nx < 4 || ny < 4) throw new Error('coarsen=' + K + ' leaves a ' + nx + 'x' + ny + ' grid — too small');
  const data = new Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let s = 0;
      for (let dy = 0; dy < K; dy++) {
        for (let dx = 0; dx < K; dx++) s += g.data[(y * K + dy) * g.nx + (x * K + dx)];
      }
      data[y * nx + x] = s / (K * K);
    }
  }
  return {
    origin: g.origin.slice(), res: g.res * K, nx, ny, data,
    meta: Object.assign({}, g.meta, {
      coarsenFactor: K,
      dataset: (g.meta && g.meta.dataset || 'grid') + ' (K=' + K + ' mean-of-cell-means coarsen)'
    })
  };
}

/** True when the full 3x3 node stencil around (j,i) is wet. A node with any
 *  dry neighbor still lands in a GeoClaw CELL that averages that land in
 *  (cell-average bathymetry) — the gauge cell then goes dry and eta reads
 *  the land elevation instead of the wave. A fully-wet stencil keeps a gauge
 *  wet under both conventions (node sampling and cell averaging). */
function wet9(g, j, i) {
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const jj = j + dj, ii = i + di;
      if (jj < 0 || jj >= g.ny || ii < 0 || ii >= g.nx) return false;
      if (g.data[jj * g.nx + ii] >= 0) return false;
    }
  }
  return true;
}

function nodeOf(g, lat, lng) {
  return {
    i: Math.round((lng - g.origin[0]) / g.res),
    j: Math.round((lat - g.origin[1]) / g.res)
  };
}

/** Snap a gauge to the nearest node whose 3x3 stencil is wet on EVERY grid
 *  in `grids` (case grid + optional coarser ladder level), expanding ring
 *  search. Grids must share the origin of grids[0]. */
function snapGaugeMulti(def, grids) {
  const g0 = grids[0];
  const start = nodeOf(g0, def.lat, def.lng);
  const allWet = (j, i) => grids.every(g => {
    const n = nodeOf(g, g0.origin[1] + j * g0.res, g0.origin[0] + i * g0.res);
    return n.i >= 1 && n.i < g.nx - 1 && n.j >= 1 && n.j < g.ny - 1 && wet9(g, n.j, n.i);
  });
  if (allWet(start.j, start.i)) return Object.assign({}, def);
  for (let r = 1; r <= 40; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        if (allWet(start.j + dj, start.i + di)) {
          return Object.assign({}, def, {
            lat: +(g0.origin[1] + (start.j + dj) * g0.res).toFixed(5),
            lng: +(g0.origin[0] + (start.i + di) * g0.res).toFixed(5),
            snapped: true,
            snappedFrom: { lat: def.lat, lng: def.lng }
          });
        }
      }
    }
  }
  throw new Error('no fully-wet stencil near gauge ' + def.name + ' at all requested levels');
}

module.exports = { coarsenGrid, wet9, nodeOf, snapGaugeMulti };
