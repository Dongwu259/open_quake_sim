'use strict';
// =====================================================================
// psv-qd.js — extended-precision (BigInt bigfloat) port of the Schur
// compliance chain (2026-09-12, v15 batch — the v14 registered cure).
//
// WHY: the v14 DD batch measured the crest-band arithmetic budget
// precisely. The up-leg admittance step det(P22 - Y*P12) carries a
// STRUCTURAL cancellation of ~5e30-8e31 at k = 0.70-0.76/km and the
// output chaos scales as eps x stepCancel x O(1-40) — DD's eps ~ 1e-32
// is consumed exactly (the 1-ulp gate passes only at 0.80/km where the
// step cancellation drops to 2.8e26). The registered cure needs
// eps ~ 1e-64 or better.
//
// HOW: instead of a hand-rolled 4-double quad-double library (28-partial
// multiplication renormalization, intricate exp/log), this module
// implements a straightforward arbitrary-precision binary bigfloat on
// BigInt mantissas — {m: BigInt, e: int}, value = m * 2^e with the
// mantissa normalized to PBITS bits (default 256 -> eps ~ 1.7e-77,
// THIRTEEN orders beyond the measured 1e-64 requirement) — and ports
// the v14 DD chain onto it 1:1 (same functions, same guards, same
// conventions, same per-layer up-leg normalization). Every primitive
// is correctly rounded (mul/div/sqrt via exact integer products plus
// exact-remainder rounding; exp/log via adaptive series), so the chain
// output noise is eps x amplification with no hidden term growth. The
// 256-bit default costs ~nothing at this call volume and buys the
// margin; opts.pbits re-targets the mantissa per call (a gate failure
// at 256 whose error SHRINKS at 384/512 would mean precision-bound; a
// FLAT error would mean structure — the ladder is the diagnostic).
// expm4 runs an adaptive Taylor term count (the DD-era constant 24 was
// only enough for eps 1e-32; here the series runs until the term drops
// below 2^-(PBITS+10) of the partial sum).
//
// SCOPE: the full Schur path — nuOf, the eigenvector halfspace
// admittance, the expm propagator (with the mu* back-transform), the
// above-source jointly-scaled product, and C = -e^-sigma (Y*Q11-Q21)^-1.
// Two entries: schurComplianceQD (single depth, mirrors
// psv-dd.schurComplianceDD bit-shape for the gate/step-cancel arms) and
// complianceTripleQD (the complianceTriple plain-path helper — three
// independent single-depth chains; a shared-propagator variant was drafted
// and RETIRED in-design because prepare() splits the source layer at a
// different depth per target, so index-shared propagators would silently
// evaluate different physical layers).
// Results are rounded to doubles — everything downstream unchanged.
// =====================================================================
const P = require('./psv.js');

// ---- bigfloat core: {m: BigInt, e: int}, |m| in [2^(PBITS-1), 2^PBITS) --
let PBITS = 256;
let ZERO = { m: 0n, e: 0 };
let ONE = null, TWO = null, HALF = null, MONE = null;
let _consts = null; // { ln2, sqrt2, pbits }

function setPrecision(bits) {
  if (!Number.isInteger(bits) || bits < 64 || bits > 4096) throw new Error('psv-qd: pbits out of range');
  PBITS = bits;
  ONE = norm(1n, 0);
  TWO = norm(2n, 0);
  HALF = norm(1n, -1);
  MONE = norm(-1n, 0);
  _consts = null;
}
setPrecision(256);

function bitLen(a) { // a > 0n
  let n = 0;
  while (a >= 0x100000000n) { a >>= 32n; n += 32; }
  return n + (32 - Math.clz32(Number(a)));
}

/** Round-to-nearest-even normalize: |m| -> exactly PBITS bits. */
function norm(m, e) {
  if (m === 0n) return { m: 0n, e: 0 };
  const neg = m < 0n;
  let a = neg ? -m : m;
  const bl = bitLen(a);
  if (bl > PBITS) {
    const sh = bl - PBITS;
    const lo = a & ((1n << BigInt(sh)) - 1n);
    a >>= BigInt(sh);
    e += sh;
    if (sh > 1) {
      const half = 1n << BigInt(sh - 1);
      if (lo > half || (lo === half && (a & 1n) === 1n)) a += 1n;
    } else if (lo === 1n && (a & 1n) === 1n) a += 1n;
    if ((a >> BigInt(PBITS)) !== 0n) { a >>= 1n; e += 1; }
  } else if (bl < PBITS) {
    const sh = PBITS - bl;
    a <<= BigInt(sh);
    e -= sh;
  }
  return { m: neg ? -a : a, e: e };
}

/** Exact double -> bigfloat (IEEE decomposition; no rounding). */
function fromNumber(x) {
  if (x === 0) return ZERO;
  if (!isFinite(x)) throw new Error('psv-qd: fromNumber non-finite ' + x);
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const bits = buf.getBigUint64(0);
  const neg = (bits >> 63n) === 1n;
  const rawExp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let e2;
  if (rawExp === 0) { e2 = -1074; } // subnormal: value = mant * 2^-1074
  else { mant |= (1n << 52n); e2 = rawExp - 1075; }
  return norm(neg ? -mant : mant, e2);
}

/** Bigfloat -> nearest double (53-bit extraction with sticky rounding).
 *  Subnormal-corner accuracy is out of contract — chain guards null on
 *  magnitudes that small before any downstream consumer. */
function toNumber(x) {
  if (x.m === 0n) return 0;
  const neg = x.m < 0n;
  const a = neg ? -x.m : x.m;
  const bl = bitLen(a);
  let n, e;
  if (bl > 53) {
    const sh = bl - 53;
    const lo = a & ((1n << BigInt(sh)) - 1n);
    n = Number(a >> BigInt(sh));
    e = x.e + sh;
    if (sh > 1) {
      const half = 1n << BigInt(sh - 1);
      if (lo > half || (lo === half && (n % 2 === 1))) n += 1;
    } else if (lo === 1n && n % 2 === 1) n += 1;
    if (n === 9007199254740992) { n = 4503599627370496; e += 1; }
  } else { n = Number(a); e = x.e; }
  let d;
  if (e >= -1022) d = n * Math.pow(2, e);
  else d = n * Math.pow(2, e + 100) * Math.pow(2, -100); // split scaling into the subnormal range
  return neg ? -d : d;
}

function bcmp(a, b) {
  const sa = a.m < 0n ? -1 : (a.m > 0n ? 1 : 0);
  const sb = b.m < 0n ? -1 : (b.m > 0n ? 1 : 0);
  if (sa !== sb) return sa - sb;
  if (sa === 0) return 0;
  if (a.e !== b.e) return a.e > b.e ? sa : -sa;
  return a.m < b.m ? -1 : (a.m > b.m ? 1 : 0);
}
function babs(a) { return a.m < 0n ? { m: -a.m, e: a.e } : a; }
function bneg(a) { return a.m === 0n ? a : { m: -a.m, e: a.e }; }

function badd(a, b) {
  if (a.m === 0n) return b;
  if (b.m === 0n) return a;
  const d = a.e - b.e;
  // an addend more than PBITS+8 bits away cannot reach half an ulp of the
  // other — returning it unchanged IS the correctly rounded sum
  if (d > PBITS + 8) return a;
  if (d < -(PBITS + 8)) return b;
  if (d >= 0) return norm((a.m << BigInt(d)) + b.m, b.e);
  return norm(a.m + (b.m << BigInt(-d)), a.e);
}
function bsub(a, b) { return badd(a, bneg(b)); }
function bmul(a, b) {
  if (a.m === 0n || b.m === 0n) return ZERO;
  return norm(a.m * b.m, a.e + b.e);
}
function bdiv(a, b) {
  if (b.m === 0n) throw new Error('psv-qd: division by zero');
  if (a.m === 0n) return ZERO;
  const neg = (a.m < 0n) !== (b.m < 0n);
  const an = a.m < 0n ? -a.m : a.m;
  const bn = b.m < 0n ? -b.m : b.m;
  const s = PBITS + 8 - bitLen(an) + bitLen(bn);
  const num = an << BigInt(s);
  let q = num / bn;
  const rem = num - q * bn;
  const twice = rem * 2n;
  if (twice > bn || (twice === bn && (q & 1n) === 1n)) q += 1n;
  return norm(neg ? -q : q, a.e - b.e - s);
}

function isqrtBig(N) { // floor(sqrt(N)), N > 0n
  let x = 1n << BigInt(Math.ceil(bitLen(N) / 2) + 1);
  let y = (x + N / x) >> 1n;
  while (y < x) { x = y; y = (x + N / x) >> 1n; }
  while (x * x > N) x -= 1n;
  while ((x + 1n) * (x + 1n) <= N) x += 1n;
  return x;
}

/** Correctly rounded sqrt of a non-negative bigfloat. */
function bsqrt(a) {
  if (a.m === 0n) return ZERO;
  if (a.m < 0n) throw new Error('psv-qd: sqrt of negative');
  let m = a.m, e = a.e;
  if ((e & 1) !== 0) { m <<= 1n; e -= 1; } // make the exponent even, value preserved
  const bl = bitLen(m);
  const k = Math.max(0, Math.ceil((2 * PBITS + 8 - bl) / 2));
  const N = m << BigInt(2 * k);
  let s = isqrtBig(N);
  const r = N - s * s;
  if (2n * r > 2n * s + 1n) s += 1n; // no exact ties possible (2r even, 2s+1 odd)
  return norm(s, e / 2 - k);
}

function isTinyC(a, ref) { // |a| < |ref| * 2^-(PBITS+10)
  if (a.m === 0n) return true;
  if (ref.m === 0n) return false;
  const la = a.e + bitLen(a.m < 0n ? -a.m : a.m);
  const lr = ref.e + bitLen(ref.m < 0n ? -ref.m : ref.m);
  return la - lr < -(PBITS + 10);
}

function consts() {
  if (_consts && _consts.pbits === PBITS) return _consts;
  // ln2 = 2*atanh(1/3) (u = 1/3, u^2 = 1/9 — ~55 odd terms at 256 bits)
  const third = bdiv(ONE, fromNumber(3));
  let term = third, sum = ZERO;
  for (let k = 1; k < 400; k += 2) {
    const t = bdiv(term, fromNumber(k));
    sum = badd(sum, t);
    if (isTinyC(t, sum)) break;
    term = bmul(term, bmul(third, third));
  }
  const c = { ln2: badd(sum, sum), sqrt2: bsqrt(TWO), pbits: PBITS };
  _consts = c;
  return c;
}

function bexp(x) {
  if (x.m === 0n) return ONE;
  const c = consts();
  const n = Math.round(toNumber(bdiv(x, c.ln2)));
  if (!isFinite(n) || Math.abs(n) > 30000) throw new Error('psv-qd: exp over/underflow');
  const r = bsub(x, bmul(c.ln2, fromNumber(n)));
  let sum = ONE, term = ONE;
  for (let k = 1; k < 500; k++) {
    term = bmul(term, bdiv(r, fromNumber(k)));
    sum = badd(sum, term);
    if (isTinyC(term, sum)) break;
  }
  return norm(sum.m, sum.e + n); // exact power-of-two scaling
}

function blog(a) { // a > 0
  if (a.m <= 0n) throw new Error('psv-qd: log of non-positive');
  const c = consts();
  let j = a.e + PBITS - 1;
  let y = norm(a.m, a.e - j); // y in [1, 2)
  if (bcmp(y, c.sqrt2) >= 0) { y = norm(y.m, y.e - 1); j += 1; } // y in [sqrt2/2, sqrt2)
  const u = bdiv(bsub(y, ONE), badd(y, ONE)); // |u| <= (sqrt2-1)/(sqrt2+1) ~ 0.1716
  const u2 = bmul(u, u);
  let term = u, sum = ZERO;
  for (let k = 1; k < 500; k += 2) {
    const t = bdiv(term, fromNumber(k));
    sum = badd(sum, t);
    if (isTinyC(t, sum)) break;
    term = bmul(term, u2);
  }
  sum = badd(sum, sum); // 2*atanh(u)
  return badd(sum, bmul(fromNumber(j), c.ln2));
}

// ---- complex bigfloat ([re, im] bigfloat pairs) ------------------------
function C0() { return [ZERO, ZERO]; }
function C1() { return [ONE, ZERO]; }
const CI = () => [ZERO, ONE];
function cadd(a, b) { return [badd(a[0], b[0]), badd(a[1], b[1])]; }
function csub(a, b) { return [bsub(a[0], b[0]), bsub(a[1], b[1])]; }
function cneg(a) { return [bneg(a[0]), bneg(a[1])]; }
function cscale(a, s) { return [bmul(a[0], s), bmul(a[1], s)]; } // s real bigfloat
function cmul(a, b) {
  return [bsub(bmul(a[0], b[0]), bmul(a[1], b[1])),
          badd(bmul(a[0], b[1]), bmul(a[1], b[0]))];
}
function cdiv(a, b) {
  const den = badd(bmul(b[0], b[0]), bmul(b[1], b[1]));
  return [bdiv(badd(bmul(a[0], b[0]), bmul(a[1], b[1])), den),
          bdiv(bsub(bmul(a[1], b[0]), bmul(a[0], b[1])), den)];
}
function cabsB(a) { return bsqrt(badd(bmul(a[0], a[0]), bmul(a[1], a[1]))); }
function cFinite(a) { return true; } // bigfloats cannot be NaN/Inf — kept for port symmetry

/** sqrt with Im(result) >= 0 — the exact csqrtPosIm convention (core.js). */
function csqrtPosIm(z) {
  const az = cabsB(z);
  let re, im;
  if (z[0].m >= 0n) {
    const t = bsqrt(bmul(badd(az, z[0]), HALF));
    re = t;
    im = bdiv(z[1], badd(t, t));
  } else {
    const t = bsqrt(bmul(bsub(az, z[0]), HALF));
    re = bdiv(babs(z[1]), badd(t, t));
    im = z[1].m < 0n ? bneg(t) : t;
  }
  if (z[1].m < 0n || (z[1].m === 0n && re.m < 0n)) return [bneg(re), bneg(im)];
  return [re, im];
}

// ---- 2x2 / 4x4 complex-bigfloat matrix helpers -------------------------
function m2mulBF(A, B) {
  return [[cadd(cmul(A[0][0], B[0][0]), cmul(A[0][1], B[1][0])),
           cadd(cmul(A[0][0], B[0][1]), cmul(A[0][1], B[1][1]))],
          [cadd(cmul(A[1][0], B[0][0]), cmul(A[1][1], B[1][0])),
           cadd(cmul(A[1][0], B[0][1]), cmul(A[1][1], B[1][1]))]];
}
function m2invBF(A) {
  const det = csub(cmul(A[0][0], A[1][1]), cmul(A[0][1], A[1][0]));
  if (bcmp(cabsB(det), fromNumber(1e-300)) < 0) throw new Error('psv-qd: singular 2x2');
  return [[cdiv(A[1][1], det), cscale(cdiv(A[0][1], det), MONE)],
          [cscale(cdiv(A[1][0], det), MONE), cdiv(A[0][0], det)]];
}
function m4mulBF(A, B) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const row = [];
    for (let j = 0; j < 4; j++) {
      let s = C0();
      for (let l = 0; l < 4; l++) s = cadd(s, cmul(A[i][l], B[l][j]));
      row.push(s);
    }
    out.push(row);
  }
  return out;
}
/** Max |entry| (true complex modulus). REAL zero start — a complex here
 *  would poison every bcmp (the v14 m4maxabsDD lesson). */
function m4maxabsBF(A) {
  let m = ZERO;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const a = cabsB(A[i][j]);
    if (bcmp(a, m) > 0) m = a;
  }
  return m;
}

// ---- bigfloat ports of the psv chain pieces ----------------------------
/** nu_c = sqrt(w^2/c*^2 - k^2), Im >= 0 — psv.nuOf / psv-dd.nuOfDD port. */
function nuOfBF(vKmS, omega, kInvM, q) {
  const b = fromNumber(vKmS * 1000);
  const b2re = bmul(b, b);
  const b2im = (q && q > 0) ? bneg(bdiv(b2re, fromNumber(q))) : ZERO;
  const om2 = bmul(fromNumber(omega), fromNumber(omega));
  const k = fromNumber(kInvM);
  const k2re = bmul(k, k);
  const den = badd(bmul(b2re, b2re), bmul(b2im, b2im));
  const val = csub([bdiv(bmul(om2, b2re), den), bneg(bdiv(bmul(om2, b2im), den))],
                   [k2re, ZERO]);
  return csqrtPosIm(val);
}

/** Eigenvector matrix (P down, P up, SV down, SV up) x (u_r, u_z, tau_rz,
 *  s_zz) — psv.psvEigenvectors / psv-dd.psvEigenvectorsDD port with the
 *  complex mu* traction rows. */
function psvEigenvectorsBF(layer, omega, k, opts) {
  const qs = (opts && opts.qShear) || 0;
  const rho = fromNumber(layer.rhoGcm3 * 1000);
  const vs = fromNumber(layer.vsKmS * 1000);
  const muR = bmul(rho, bmul(vs, vs));
  const mu = qs > 0 ? [muR, bneg(bdiv(muR, fromNumber(qs)))] : [muR, ZERO];
  const nuA = nuOfBF(layer.vpKmS, omega, k, opts && opts.qP);
  const nuB = nuOfBF(layer.vsKmS, omega, k, qs);
  const kk = [fromNumber(k), ZERO];
  const ik = cmul(kk, CI());
  const iA = cmul(nuA, CI()), iB = cmul(nuB, CI());
  const szP = csub(cmul(cmul(cscale(mu, TWO), kk), kk), [bmul(rho, bmul(fromNumber(omega), fromNumber(omega))), ZERO]);
  const svs = cmul(mu, csub(cmul(kk, kk), cmul(nuB, nuB)));
  const m2kA = cscale(cmul(cmul(mu, nuA), kk), bneg(TWO)); // -2*mu*nuA*k
  const p2kA = cscale(cmul(cmul(mu, nuA), kk), TWO);       // +2*mu*nuA*k
  const m2kB = cscale(cmul(cmul(mu, nuB), kk), TWO);       // +2*mu*nuB*k
  return [
    [ik, ik, iB, cscale(iB, MONE)],
    [iA, cscale(iA, MONE), cscale(ik, MONE), cscale(ik, MONE)],
    [m2kA, p2kA, svs, svs],
    [szP, szP, m2kB, cscale(m2kB, MONE)]
  ];
}
/** Halfspace downgoing admittance tau = Y u. */
function hsAdmittanceBF(layer, omega, k, opts) {
  const E = psvEigenvectorsBF(layer, omega, k, opts);
  const M1 = [[E[0][0], E[0][2]], [E[1][0], E[1][2]]];
  const M2 = [[E[2][0], E[2][2]], [E[3][0], E[3][2]]];
  return m2mulBF(M2, m2invBF(M1));
}

/** exp(A*h) scaling-and-squaring with an ADAPTIVE Taylor term count (the
 *  psv.expm4 / psv-dd.expm4DD port; the scaling count comes from the
 *  double row-sum norm — the count only chooses a power-of-two split, it
 *  is not precision-bearing). */
function expm4BF(A, h) {
  let nrm = 0;
  for (let i = 0; i < 4; i++) {
    let rowSum = 0;
    for (let j = 0; j < 4; j++) rowSum += toNumber(cabsB(A[i][j]));
    if (rowSum > nrm) nrm = rowSum;
  }
  let s = 0;
  while (nrm * h > 0.25) { s++; nrm /= 2; }
  const hS = fromNumber(h / Math.pow(2, s)); // exact power-of-two scaling of h
  const B = A.map((row) => row.map((e) => cscale(e, hS)));
  const I4 = () => [[C1(), C0(), C0(), C0()], [C0(), C1(), C0(), C0()],
                    [C0(), C0(), C1(), C0()], [C0(), C0(), C0(), C1()]];
  let sum = I4();
  let term = sum.map((r) => r.slice());
  // cheap component max-norm (no sqrt) for the break test — with ||B|| <=
  // 0.25 the terms cannot reach 2^-(PBITS+10) of the sum before n ~ 40 at
  // 256 bits, so the test only runs past n = 30
  const cmaxCheap = (M) => {
    let mx = ZERO;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const c = M[i][j];
      const a0 = babs(c[0]), a1 = babs(c[1]);
      const a = bcmp(a0, a1) > 0 ? a0 : a1;
      if (bcmp(a, mx) > 0) mx = a;
    }
    return mx;
  };
  for (let n = 1; n <= 300; n++) {
    const inv = bdiv(ONE, fromNumber(n)); // hoisted per-term scalar
    const next = [];
    for (let i = 0; i < 4; i++) {
      const row = [];
      for (let j = 0; j < 4; j++) {
        let acc = C0();
        for (let l = 0; l < 4; l++) acc = cadd(acc, cmul(term[i][l], B[l][j]));
        row.push(cscale(acc, inv));
      }
      next.push(row);
    }
    term = next;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) sum[i][j] = cadd(sum[i][j], term[i][j]);
    if (n > 30 && isTinyC(cmaxCheap(term), cmaxCheap(sum))) break;
  }
  for (let q = 0; q < s; q++) sum = m4mulBF(sum, sum);
  return sum;
}

/** Layer propagator P = exp(A h) with the mu* traction back-transform —
 *  psv.psvPropagator / psv-dd.propagatorDD port (same A construction,
 *  same conventions). */
function propagatorBF(layer, omega, k, opts) {
  const h = (layer.bottomKm - layer.topKm) * 1000;
  const rho = fromNumber(layer.rhoGcm3 * 1000);
  const vsSi = fromNumber(layer.vsKmS * 1000), vpSi = fromNumber(layer.vpKmS * 1000);
  const qs = (opts && opts.qShear) || 0, qp = (opts && opts.qP) || 0;
  const muR = bmul(rho, bmul(vsSi, vsSi));
  const muC = qs > 0 ? [muR, bneg(bdiv(muR, fromNumber(qs)))] : [muR, ZERO];
  const lam2R = bmul(rho, bmul(vpSi, vpSi));
  const lamC = [bsub(lam2R, bmul(muR, TWO)),
                bsub(qs > 0 ? bmul(muR, bdiv(TWO, fromNumber(qs))) : ZERO,
                     qp > 0 ? bdiv(lam2R, fromNumber(qp)) : ZERO)];
  const lamMu = cadd(lamC, cscale(muC, TWO));
  const kk = [fromNumber(k), ZERO];
  const ik = cmul(kk, CI());
  const ikLam = cmul(ik, cdiv(lamC, lamMu));
  const rom2 = bmul(rho, bmul(fromNumber(omega), fromNumber(omega))); // rho*omega^2 (the DD source subtracts rho*omega^2, NOT bare omega^2)
  const c1s = cdiv(csub(cmul(cmul(kk, kk), csub(lamMu, cdiv(cmul(lamC, lamC), lamMu))),
                        [rom2, ZERO]), muC);
  const w2vs2 = cdiv([bneg(rom2), ZERO], muC);
  const A = [
    [C0(), cscale(ik, MONE), C1(), C0()],
    [cscale(ikLam, MONE), C0(), C0(), cdiv(muC, lamMu)],
    [c1s, C0(), C0(), cscale(ikLam, MONE)],
    [C0(), w2vs2, cscale(ik, MONE), C0()]
  ];
  const Pm = expm4BF(A, h);
  const muCinv = cdiv(C1(), muC);
  const out = [];
  for (let i = 0; i < 4; i++) {
    const row = [];
    for (let j = 0; j < 4; j++) {
      let v = Pm[i][j];
      if (i >= 2) v = cmul(v, muC);
      if (j >= 2) v = cmul(v, muCinv);
      row.push(v);
    }
    out.push(row);
  }
  return out;
}

function roundC(c) { return [toNumber(c[0]), toNumber(c[1])]; }
function roundM2(M) { return [[roundC(M[0][0]), roundC(M[0][1])], [roundC(M[1][0]), roundC(M[1][1])]]; }

// ---- the Schur chain ----------------------------------------------------
function dbgOn() { return typeof process !== 'undefined' && process.env.PSV_QD_DBG; }

/** One up-leg admittance recursion STEP with the production per-layer
 *  normalization (shared by the single and triple entries). Returns the
 *  new Y or null on a guard. */
function upLegStep(Y, Pd, tag, trace) {
  const pmax = m4maxabsBF(Pd);
  if (!(pmax.m > 0n)) { trace('up-leg P scale bad at ' + tag); return null; }
  const pinv = bdiv(ONE, pmax);
  Pd = Pd.map((row) => row.map((e) => cscale(e, pinv)));
  const P22 = [[Pd[2][2], Pd[2][3]], [Pd[3][2], Pd[3][3]]];
  const P12 = [[Pd[0][2], Pd[0][3]], [Pd[1][2], Pd[1][3]]];
  const P11 = [[Pd[0][0], Pd[0][1]], [Pd[1][0], Pd[1][1]]];
  const P21 = [[Pd[2][0], Pd[2][1]], [Pd[3][0], Pd[3][1]]];
  const YP12 = m2mulBF(Y, P12), YP11 = m2mulBF(Y, P11);
  let S;
  try {
    S = m2invBF([[csub(P22[0][0], YP12[0][0]), csub(P22[0][1], YP12[0][1])],
                 [csub(P22[1][0], YP12[1][0]), csub(P22[1][1], YP12[1][1])]]);
  } catch (e) { trace('up-leg S singular at ' + tag); return null; }
  const rhs = [[csub(YP11[0][0], P21[0][0]), csub(YP11[0][1], P21[0][1])],
               [csub(YP11[1][0], P21[1][0]), csub(YP11[1][1], P21[1][1])]];
  const Y2 = m2mulBF(S, rhs);
  if (!Y2 || !cFinite(Y2[0][0]) || !cFinite(Y2[1][1])) { trace('up-leg Y non-finite at ' + tag); return null; }
  return Y2;
}

/** psv.psvSchurCompliance in extended precision — same structure, same
 *  guards, no subdivision (expm4's adaptive scaling handles any layer
 *  thickness), same return shapes ([re,im] doubles; _wantDet adds the
 *  rounded detM). opts.pbits re-targets the mantissa for this call. */
function schurComplianceQD(stack, omega, kInvM, zKm, opts) {
  if (opts && opts.pbits) setPrecision(opts.pbits);
  const dbg = dbgOn();
  const trace = (msg) => { if (dbg) console.error('PSV_QD_DBG ' + msg); };
  const st = P.prepare(stack, zKm);
  const lay = st.layers;
  // ---- up-leg: admittance from the halfspace top to the source depth ----
  let Y = hsAdmittanceBF(lay[st.halfIndex], omega, kInvM, opts);
  if (!Y) { trace('halfspace admittance null'); return null; }
  for (let i = st.halfIndex - 1; i >= st.iS; i--) {
    Y = upLegStep(Y, propagatorBF(lay[i], omega, kInvM, opts), 'layer ' + i, trace);
    if (!Y) return null;
  }
  // ---- above-source propagator product with joint scalar scaling --------
  let Q = [[C1(), C0(), C0(), C0()], [C0(), C1(), C0(), C0()],
           [C0(), C0(), C1(), C0()], [C0(), C0(), C0(), C1()]];
  let sigma = ZERO;
  for (let i2 = 0; i2 < st.iS; i2++) {
    Q = m4mulBF(propagatorBF(lay[i2], omega, kInvM, opts), Q);
    const s = m4maxabsBF(Q);
    if (!(s.m > 0n)) { trace('Q scale bad at layer ' + i2); return null; }
    const inv = bdiv(ONE, s);
    for (let r2 = 0; r2 < 4; r2++) for (let c2 = 0; c2 < 4; c2++) Q[r2][c2] = cscale(Q[r2][c2], inv);
    sigma = badd(sigma, blog(s));
  }
  const sig = toNumber(sigma);
  if (!(sig > -650) || !(sig < 650)) { trace('sigma out of range: ' + sig); return null; }
  const Q11 = [[Q[0][0], Q[0][1]], [Q[1][0], Q[1][1]]];
  const Q21 = [[Q[2][0], Q[2][1]], [Q[3][0], Q[3][1]]];
  let M = m2mulBF(Y, Q11);
  M = [[csub(M[0][0], Q21[0][0]), csub(M[0][1], Q21[0][1])],
       [csub(M[1][0], Q21[1][0]), csub(M[1][1], Q21[1][1])]];
  const detM = csub(cmul(M[0][0], M[1][1]), cmul(M[0][1], M[1][0]));
  let C;
  try { C = m2invBF(M); } catch (e) { trace('M inversion failed: |detM| ' + toNumber(cabsB(detM))); return opts && opts._wantDet ? { C: null, detM: roundC(detM) } : null; }
  const fac = bexp(bneg(sigma));
  const out = roundM2([[cscale(C[0][0], fac), cscale(C[0][1], fac)],
                       [cscale(C[1][0], fac), cscale(C[1][1], fac)]]);
  for (let i3 = 0; i3 < 2; i3++) for (let j3 = 0; j3 < 2; j3++) {
    if (!isFinite(out[i3][j3][0] + out[i3][j3][1])) {
      trace('C non-finite [' + i3 + '][' + j3 + ']');
      return opts && opts._wantDet ? { C: out, detM: roundC(detM) } : null;
    }
  }
  if (opts && opts._wantDet) return { C: out, detM: roundC(detM) };
  return out;
}

/** complianceTriple plain-path helper: the THREE depth evaluations
 *  (zUp = zs-dh, zs, zDn = zs+dh) as three independent chains. A shared-
 *  propagator variant was drafted and RETIRED in-design: prepare() splits
 *  the source layer at a different depth per target, so the layer arrays
 *  (and their indices) diverge around the source — index-shared propagators
 *  would silently evaluate DIFFERENT physical layers for the three depths.
 *  Three independent chains are the exact mirror of the double path. */
function complianceTripleQD(stack, omega, kInvM, zUpKm, zSKm, zDnKm, opts) {
  return {
    Cup: schurComplianceQD(stack, omega, kInvM, zUpKm, opts),
    C: schurComplianceQD(stack, omega, kInvM, zSKm, opts),
    Cdn: schurComplianceQD(stack, omega, kInvM, zDnKm, opts)
  };
}

/** Diagnostic: the max cancellation |terms|/|det| over the up-leg admittance
 *  step dets det(P22 - Y*P12), with the production per-layer normalization
 *  (psv-dd.upLegStepCancellation port). This is the cross-precision
 *  arithmetic budget: a property of the MATH, so the bigfloat measurement
 *  must reproduce the DD table (5e30-8e31 at the crest) to its own accuracy. */
function upLegStepCancellationQD(stack, omega, kInvM, zKm, opts) {
  if (opts && opts.pbits) setPrecision(opts.pbits);
  const st = P.prepare(stack, zKm);
  let Y = hsAdmittanceBF(st.layers[st.halfIndex], omega, kInvM, opts);
  if (!Y) return null;
  let worst = 0;
  for (let i = st.halfIndex - 1; i >= st.iS; i--) {
    let Pd = propagatorBF(st.layers[i], omega, kInvM, opts);
    const pmax = m4maxabsBF(Pd);
    const pinv = bdiv(ONE, pmax);
    Pd = Pd.map((row) => row.map((e) => cscale(e, pinv)));
    const P22 = [[Pd[2][2], Pd[2][3]], [Pd[3][2], Pd[3][3]]];
    const P12 = [[Pd[0][2], Pd[0][3]], [Pd[1][2], Pd[1][3]]];
    const P11 = [[Pd[0][0], Pd[0][1]], [Pd[1][0], Pd[1][1]]];
    const P21 = [[Pd[2][0], Pd[2][1]], [Pd[3][0], Pd[3][1]]];
    const YP12 = m2mulBF(Y, P12);
    const D = [[csub(P22[0][0], YP12[0][0]), csub(P22[0][1], YP12[0][1])],
               [csub(P22[1][0], YP12[1][0]), csub(P22[1][1], YP12[1][1])]];
    const t1 = cabsB(cmul(D[0][0], D[1][1])), t2 = cabsB(cmul(D[0][1], D[1][0]));
    const det = csub(cmul(D[0][0], D[1][1]), cmul(D[0][1], D[1][0]));
    const scale = Math.max(toNumber(t1), toNumber(t2));
    const cancel = scale / (toNumber(cabsB(det)) || 1e-300);
    if (cancel > worst) worst = cancel;
    let S;
    try { S = m2invBF(D); } catch (e) { return { worst: worst, brokeAt: i }; }
    const YP11 = m2mulBF(Y, P11);
    const rhs = [[csub(YP11[0][0], P21[0][0]), csub(YP11[0][1], P21[0][1])],
                 [csub(YP11[1][0], P21[1][0]), csub(YP11[1][1], P21[1][1])]];
    Y = m2mulBF(S, rhs);
    if (!Y || !cFinite(Y[0][0]) || !cFinite(Y[1][1])) return { worst: worst, brokeAt: i };
  }
  return { worst: worst, brokeAt: null };
}

module.exports = {
  schurComplianceQD: schurComplianceQD,
  complianceTripleQD: complianceTripleQD,
  upLegStepCancellationQD: upLegStepCancellationQD,
  // internals exported for the test anchors and cross-checks
  propagatorBF: propagatorBF, hsAdmittanceBF: hsAdmittanceBF,
  psvEigenvectorsBF: psvEigenvectorsBF, expm4BF: expm4BF,
  setPrecision: setPrecision, getPrecision: function () { return PBITS; },
  // primitives exported for the test anchors
  bf: {
    fromNumber: fromNumber, toNumber: toNumber, badd: badd, bsub: bsub, bmul: bmul,
    bdiv: bdiv, bsqrt: bsqrt, bexp: bexp, blog: blog, bneg: bneg, bcmp: bcmp,
    cadd: cadd, csub: csub, cmul: cmul, cdiv: cdiv, cscale: cscale, cabs: cabsB,
    csqrtPosIm: csqrtPosIm, nuOf: nuOfBF, one: function () { return ONE; }
  }
};
