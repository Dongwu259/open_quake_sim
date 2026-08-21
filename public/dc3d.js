// Okada DC3D finite rectangular dislocation, surface displacement subset.
//
// The equations are a direct JavaScript translation of the displacement
// terms in Y. Okada's DC3D.f (1992, revised 2002), distributed by
// okada_wrapper under the MIT license:
// https://github.com/tbenthompson/okada_wrapper
//
// Copyright (c) 2015 Thomas Ben Thompson
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to inclusion of this notice. THE SOFTWARE IS
// PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DC3D = factory();
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var PI2 = 2 * Math.PI;
  var EPS = 1e-6;

  function finite(value, fallback) {
    value = Number(value);
    return isFinite(value) ? value : fallback;
  }

  function material(alpha, dipDeg) {
    var dip = finite(dipDeg, 90) * Math.PI / 180;
    var sd = Math.sin(dip), cd = Math.cos(dip);
    if (Math.abs(cd) < EPS) { cd = 0; sd = sd >= 0 ? 1 : -1; }
    return {
      alpha: alpha,
      alp1: (1 - alpha) / 2,
      alp2: alpha / 2,
      alp3: (1 - alpha) / alpha,
      sd: sd, cd: cd, sd2: sd * sd, cd2: cd * cd, sdcd: sd * cd
    };
  }

  function geometry(xi, eta, q, c, kxi, ket) {
    if (Math.abs(xi) < EPS) xi = 0;
    if (Math.abs(eta) < EPS) eta = 0;
    if (Math.abs(q) < EPS) q = 0;
    var xi2 = xi * xi, et2 = eta * eta, q2 = q * q;
    var r2 = xi2 + et2 + q2, r = Math.sqrt(r2);
    if (r === 0) return null;
    var r3 = r * r2;
    var y = eta * c.cd + q * c.sd;
    var d = eta * c.sd - q * c.cd;
    var tt = q === 0 ? 0 : Math.atan(xi * eta / (q * r));
    var alx, x11, x32, ale, y11, y32;
    if (kxi) { alx = -Math.log(Math.max(Number.MIN_VALUE, r - xi)); x11 = 0; x32 = 0; }
    else {
      var rxi = r + xi;
      alx = Math.log(Math.max(Number.MIN_VALUE, rxi));
      x11 = 1 / (r * rxi);
      x32 = (r + rxi) * x11 * x11 / r;
    }
    if (ket) { ale = -Math.log(Math.max(Number.MIN_VALUE, r - eta)); y11 = 0; y32 = 0; }
    else {
      var ret = r + eta;
      ale = Math.log(Math.max(Number.MIN_VALUE, ret));
      y11 = 1 / (r * ret);
      y32 = (r + ret) * y11 * y11 / r;
    }
    return {xi:xi,eta:eta,q:q,xi2:xi2,et2:et2,q2:q2,r:r,r2:r2,r3:r3,
      y:y,d:d,tt:tt,alx:alx,ale:ale,x11:x11,y11:y11,x32:x32,y32:y32};
  }

  // DC3D part A, displacement terms only (UA entries 1..3).
  function ua(g, c, disl1, disl2, disl3) {
    var u0 = 0, u1 = 0, u2 = 0;
    var qx = g.q * g.x11, qy = g.q * g.y11;
    if (disl1) {
      u0 += disl1 / PI2 * (g.tt / 2 + c.alp2 * g.xi * qy);
      u1 += disl1 / PI2 * (c.alp2 * g.q / g.r);
      u2 += disl1 / PI2 * (c.alp1 * g.ale - c.alp2 * g.q * qy);
    }
    if (disl2) {
      u0 += disl2 / PI2 * (c.alp2 * g.q / g.r);
      u1 += disl2 / PI2 * (g.tt / 2 + c.alp2 * g.eta * qx);
      u2 += disl2 / PI2 * (c.alp1 * g.alx - c.alp2 * g.q * qx);
    }
    if (disl3) {
      u0 += disl3 / PI2 * (-c.alp1 * g.ale - c.alp2 * g.q * qy);
      u1 += disl3 / PI2 * (-c.alp1 * g.alx - c.alp2 * g.q * qx);
      u2 += disl3 / PI2 * (g.tt / 2 - c.alp2 * (g.eta * qx + g.xi * qy));
    }
    return [u0, u1, u2];
  }

  // DC3D part B, displacement terms only (UB entries 1..3).
  function ub(g, c, disl1, disl2, disl3) {
    var rd = g.r + g.d;
    var d11 = 1 / (g.r * rd);
    var ai3, ai4;
    if (c.cd !== 0) {
      if (g.xi === 0) ai4 = 0;
      else {
        var xx = Math.sqrt(g.xi2 + g.q2);
        var denominator = g.xi * (g.r + xx) * c.cd;
        var numerator = g.eta * (xx + g.q * c.cd) + xx * (g.r + xx) * c.sd;
        ai4 = (g.xi / rd * c.sdcd + 2 * Math.atan(numerator / denominator)) / c.cd2;
      }
      ai3 = (g.y * c.cd / rd - g.ale + c.sd * Math.log(Math.max(Number.MIN_VALUE, rd))) / c.cd2;
    } else {
      var rd2 = rd * rd;
      ai3 = (g.eta / rd + g.y * g.q / rd2 - g.ale) / 2;
      ai4 = g.xi * g.y / rd2 / 2;
    }
    var ai1 = -g.xi / rd * c.cd - ai4 * c.sd;
    var ai2 = Math.log(Math.max(Number.MIN_VALUE, rd)) + ai3 * c.sd;
    var qx = g.q * g.x11, qy = g.q * g.y11;
    var u0 = 0, u1 = 0, u2 = 0;
    if (disl1) {
      u0 += disl1 / PI2 * (-g.xi * qy - g.tt - c.alp3 * ai1 * c.sd);
      u1 += disl1 / PI2 * (-g.q / g.r + c.alp3 * g.y / rd * c.sd);
      u2 += disl1 / PI2 * (g.q * qy - c.alp3 * ai2 * c.sd);
    }
    if (disl2) {
      u0 += disl2 / PI2 * (-g.q / g.r + c.alp3 * ai3 * c.sdcd);
      u1 += disl2 / PI2 * (-g.eta * qx - g.tt - c.alp3 * g.xi / rd * c.sdcd);
      u2 += disl2 / PI2 * (g.q * qx + c.alp3 * ai4 * c.sdcd);
    }
    if (disl3) {
      u0 += disl3 / PI2 * (g.q * qy - c.alp3 * ai3 * c.sd2);
      u1 += disl3 / PI2 * (g.q * qx + c.alp3 * g.xi / rd * c.sd2);
      u2 += disl3 / PI2 * (g.eta * qx + g.xi * qy - g.tt - c.alp3 * ai4 * c.sd2);
    }
    return [u0, u1, u2];
  }

  /**
   * Analytical DC3D displacement at the free surface (z=0).
   * Coordinates and dimensions use one consistent length unit. x is along
   * strike; y is horizontal up-dip. Dislocations are strike, dip, tensile.
   */
  function surfaceDisplacement(options) {
    options = options || {};
    var alpha = finite(options.alpha, 2 / 3);
    if (!(alpha > 0 && alpha < 1)) throw new RangeError('DC3D alpha must be between 0 and 1');
    var x = finite(options.x, 0), y = finite(options.y, 0);
    var depth = Math.max(EPS, finite(options.depth, 1));
    var al1 = finite(options.al1, -0.5), al2 = finite(options.al2, 0.5);
    var aw1 = finite(options.aw1, -0.5), aw2 = finite(options.aw2, 0.5);
    var disl1 = finite(options.strikeSlip, 0), disl2 = finite(options.dipSlip, 0), disl3 = finite(options.tensile, 0);
    var c = material(alpha, options.dip);
    var xis = [x - al1, x - al2];
    for (var xiIndex = 0; xiIndex < 2; xiIndex++) if (Math.abs(xis[xiIndex]) < EPS) xis[xiIndex] = 0;
    var d = depth;
    var p = y * c.cd + d * c.sd;
    var q = y * c.sd - d * c.cd;
    var ets = [p - aw1, p - aw2];
    if (Math.abs(q) < EPS) q = 0;
    for (var etIndex = 0; etIndex < 2; etIndex++) if (Math.abs(ets[etIndex]) < EPS) ets[etIndex] = 0;
    if (q === 0 && ((xis[0] * xis[1] <= 0 && ets[0] * ets[1] === 0) ||
        (ets[0] * ets[1] <= 0 && xis[0] * xis[1] === 0))) {
      return {success:1, ux:0, uy:0, uz:0, singular:true};
    }
    var kxi = [0, 0], ket = [0, 0];
    var r12 = Math.sqrt(xis[0]*xis[0] + ets[1]*ets[1] + q*q);
    var r21 = Math.sqrt(xis[1]*xis[1] + ets[0]*ets[0] + q*q);
    var r22 = Math.sqrt(xis[1]*xis[1] + ets[1]*ets[1] + q*q);
    if (xis[0] < 0 && r21 + xis[1] < EPS) kxi[0] = 1;
    if (xis[0] < 0 && r22 + xis[1] < EPS) kxi[1] = 1;
    if (ets[0] < 0 && r12 + ets[1] < EPS) ket[0] = 1;
    if (ets[0] < 0 && r22 + ets[1] < EPS) ket[1] = 1;
    var out = [0, 0, 0];
    for (var k = 0; k < 2; k++) for (var j = 0; j < 2; j++) {
      var g = geometry(xis[j], ets[k], q, c, kxi[k], ket[j]);
      if (!g) return {success:1,ux:0,uy:0,uz:0,singular:true};
      var a = ua(g,c,disl1,disl2,disl3), b = ub(g,c,disl1,disl2,disl3);
      var real = [-a[0], -a[1]*c.cd+a[2]*c.sd, -a[1]*c.sd-a[2]*c.cd];
      var image = [a[0]+b[0], (a[1]+b[1])*c.cd-(a[2]+b[2])*c.sd,
        (a[1]+b[1])*c.sd+(a[2]+b[2])*c.cd];
      var sign = (j + k === 1) ? -1 : 1;
      for (var component=0;component<3;component++) out[component] += sign*(real[component]+image[component]);
    }
    if (!out.every(isFinite)) return {success:1,ux:0,uy:0,uz:0,singular:true};
    return {success:0,ux:out[0],uy:out[1],uz:out[2],singular:false};
  }

  function alphaFromPoisson(poissonRatio) {
    var nu = Math.max(0, Math.min(0.499999, finite(poissonRatio, 0.25)));
    return 1 / (2 * (1 - nu));
  }

  return {
    VERSION:'okada-dc3d-surface-1',
    surfaceDisplacement:surfaceDisplacement,
    alphaFromPoisson:alphaFromPoisson,
    conventions:{coordinates:'x along strike; y horizontal up-dip; z positive upward',units:'consistent linear units'}
  };
}));
