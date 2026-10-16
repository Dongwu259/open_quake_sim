#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the frozen ASK14 (Abrahamson, Silva & Kamai 2014, NGA-West2) GMPE
fixtures.

The physics.js `ask2014Ln`/`ask2014SigmaLn` implementation is asserted in
tests/gmpe-ask14.test.js against reference values produced by this script. The
functional form below is a scalar transcription of the OFFICIAL
openquake.hazardlib implementation (gem/oq-engine,
openquake/hazardlib/gsim/abrahamson_2014.py) — NOT of physics.js — so the two
implementations are independent: the coefficient table is embedded verbatim
from the hazardlib source and the equation structure follows the hazardlib
functions _get_basic_term / _get_faulting_style_term / _get_hanging_wall_term
(tapers 1-5) / _get_top_of_rupture_depth_term / _get_site_response_term /
_get_basin_term / _get_regional_term / _get_stddevs one for one.

Provenance of the transcription source (keep in sync when regenerating):
  repository: gem/oq-engine (master via api.github.com contents, pinned IP)
  path:       openquake/hazardlib/gsim/abrahamson_2014.py
  sha256:     386e496e65f3ad228df618bc2c399275686018ed432c7ba30a083ed2ef0f8f8c
  paper:      Abrahamson, Silva & Kamai (2014) Earthquake Spectra 30(3)
              1025-1055

Scope faithfully transcribed (class AbrahamsonEtAl2014, region=None):
  * Median model for pga/pgv + all 21 SA rows (0.01-10 s); no PGA floor in
    this model (unlike CY14/CB14).
  * region=None (California base — the CHN/JPN/TWN regional aliases are NOT
    exercised); aftershock f11 term off (mainshock use);
    sigma_mu_epsilon = 0; USGS basin scaling / CyberShake adjustments off.
  * Basin term: unmeasured z1pt0 -> z10 = z1ref(vs30) (non-JPN relation,
    eq. 18) -> factor = ln(1) = 0 -> EXACTLY 0.
  * Aleatory model: estimated-Vs30 pair s1e/s2e (vs30measured=False); the
    phi_amp = 0.99 * phi_al reduction when phi_al < 0.4 (hazardlib note).
  * Width: ASK14 publishes no width relation — point-source default uses the
    Wells & Coppersmith (1994) subsurface crustal width relation of the
    engine (min(80, max(8, 10^(-1.01 + 0.32*M))) km); explicit widthKm
    overrides it (hanging-wall grid).

Output units follow hazardlib: ln(PGA)/ln(SA) in g, ln(PGV) in cm/s.
physics.js pgaAsk2014 converts g -> gal with the standard gravity 980.665.

Usage: python tools/gen-gmpe-fixtures-ask14.py [--out=tools/data/gmpe-fixtures-ask14.json]
"""
import argparse
import datetime
import json
import math
import os

# --- hazardlib module constants (verbatim) ---------------------------------
CONSTS = {"n": 1.5, "m2": 5.00, "h1": 0.25, "h2": 1.50, "h3": -0.75}
REF_VS = 1180.

# --- hazardlib COEFFS table (verbatim from the frozen source) --------------
COEFFS_TEXT = """IMT     m1      vlin    b       c       c4      a1      a2      a3      a4      a5      a6      a7   a8      a10     a11     a12     a13     a14     a15     a17     a43     a44     a45     a46     a25     a28     a29     a31     a36     a37     a38     a39     a40     a41     a42     s1e     s2e     s3      s4      s1m     s2m     s5      s6      
pga     6.75    660     -1.47   2.4     4.5     0.587   -0.79   0.275   -0.1    -0.41   2.154   0.0  -0.015  1.735   0       -0.1    0.6     -0.3    1.1     -0.0072 0.1     0.05    0       -0.05   -0.0015 0.0025  -0.0034 -0.1503 0.265   0.337   0.188   0       0.088   -0.196  0.044   0.754   0.52    0.47    0.36    0.741   0.501   0.54    0.6300
pgv     6.75    330     -2.02   2400    4.5     5.975   -0.919  0.275   -0.1    -0.41   2.366   0.0  -0.094  2.36    0       -0.1    0.25    0.22    0.3     -0.0005 0.28    0.15    0.09    0.07    -0.0001 0.0005  -0.0037 -0.1462 0.377   0.212   0.157   0       0.095   -0.038  0.065   0.662   0.51    0.38    0.38    0.66    0.51    0.58    0.5300
0.01    6.75    660     -1.47   2.4     4.5     0.587   -0.790  0.275   -0.1    -0.41   2.154   0.0  -0.015  1.735   0       -0.1    0.6     -0.3    1.1     -0.0072 0.1     0.05    0       -0.05   -0.0015 0.0025  -0.0034 -0.1503 0.265   0.337   0.188   0       0.088   -0.196  0.044   0.754   0.52    0.47    0.36    0.741   0.501   0.54    0.6300
0.02    6.75    680     -1.46   2.4     4.5     0.598   -0.790  0.275   -0.1    -0.41   2.146   0.0  -0.015  1.718   0       -0.1    0.6     -0.3    1.1     -0.0073 0.1     0.05    0       -0.05   -0.0015 0.0024  -0.0033 -0.1479 0.255   0.328   0.184   0       0.088   -0.194  0.061   0.76    0.52    0.47    0.36    0.747   0.501   0.54    0.6300
0.03    6.75    770     -1.39   2.4     4.5     0.602   -0.790  0.275   -0.1    -0.41   2.157   0.0  -0.015  1.615   0       -0.1    0.6     -0.3    1.1     -0.0075 0.1     0.05    0       -0.05   -0.0016 0.0023  -0.0034 -0.1447 0.249   0.32    0.18    0       0.093   -0.175  0.162   0.781   0.52    0.47    0.36    0.769   0.501   0.55    0.6300
0.05    6.75    915     -1.22   2.4     4.5     0.707   -0.790  0.275   -0.1    -0.41   2.085   0.0  -0.015  1.358   0       -0.1    0.6     -0.3    1.1     -0.008  0.1     0.05    0       -0.05   -0.002  0.0027  -0.0033 -0.1326 0.202   0.289   0.167   0       0.133   -0.09   0.451   0.81    0.53    0.47    0.36    0.798   0.512   0.56    0.6500
0.075   6.75    960     -1.15   2.4     4.5     0.973   -0.790  0.275   -0.1    -0.41   2.029   0.0  -0.015  1.258   0       -0.1    0.6     -0.3    1.1     -0.0089 0.1     0.05    0       -0.05   -0.0027 0.0032  -0.0029 -0.1353 0.126   0.275   0.173   0       0.186   0.09    0.506   0.81    0.54    0.47    0.36    0.798   0.522   0.57    0.6900
0.1     6.75    910     -1.23   2.4     4.5     1.169   -0.790  0.275   -0.1    -0.41   2.041   0.0  -0.015  1.31    0       -0.1    0.6     -0.3    1.1     -0.0095 0.1     0.05    0       -0.05   -0.0033 0.0036  -0.0025 -0.1128 0.022   0.256   0.189   0       0.16    0.006   0.335   0.81    0.55    0.47    0.36    0.795   0.527   0.57    0.7000
0.15    6.75    740     -1.59   2.4     4.5     1.442   -0.790  0.275   -0.1    -0.41   2.121   0.0  -0.022  1.66    0       -0.1    0.6     -0.3    1.1     -0.0095 0.1     0.05    0       -0.05   -0.0035 0.0033  -0.0025 0.0383  -0.136  0.162   0.108   0       0.068   -0.156  -0.084  0.801   0.56    0.47    0.36    0.773   0.519   0.58    0.7000
0.2     6.75    590     -2.01   2.4     4.5     1.637   -0.790  0.275   -0.1    -0.41   2.224   0.0  -0.03   2.22    0       -0.1    0.6     -0.3    1.1     -0.0086 0.1     0.05    0       -0.03   -0.0033 0.0027  -0.0031 0.0775  -0.078  0.224   0.115   0       0.048   -0.274  -0.178  0.789   0.565   0.47    0.36    0.753   0.514   0.59    0.7000
0.25    6.75    495     -2.41   2.4     4.5     1.701   -0.790  0.275   -0.1    -0.41   2.312   0.0  -0.038  2.77    0       -0.1    0.6     -0.24   1.1     -0.0074 0.1     0.05    0       0       -0.0029 0.0024  -0.0036 0.0741  0.037   0.248   0.122   0       0.055   -0.248  -0.187  0.77    0.57    0.47    0.36    0.729   0.513   0.61    0.7000
0.3     6.75    430     -2.76   2.4     4.5     1.712   -0.790  0.275   -0.1    -0.41   2.338   0.0  -0.045  3.25    0       -0.1    0.6     -0.19   1.03    -0.0064 0.1     0.05    0.03    0.03    -0.0027 0.002   -0.0039 0.2548  -0.091  0.203   0.096   0       0.073   -0.203  -0.159  0.74    0.58    0.47    0.36    0.693   0.519   0.63    0.7000
0.4     6.75    360     -3.28   2.4     4.5     1.662   -0.790  0.275   -0.1    -0.41   2.469   0.0  -0.055  3.99    0       -0.1    0.58    -0.11   0.92    -0.0043 0.1     0.07    0.06    0.06    -0.0023 0.001   -0.0048 0.2136  0.129   0.232   0.123   0       0.143   -0.154  -0.023  0.699   0.59    0.47    0.36    0.644   0.524   0.66    0.7000
0.5     6.75    340     -3.6    2.4     4.5     1.571   -0.790  0.275   -0.1    -0.41   2.559   0.0  -0.065  4.45    0       -0.1    0.56    -0.04   0.84    -0.0032 0.1     0.1     0.1     0.09    -0.002  0.0008  -0.005  0.1542  0.31    0.252   0.134   0       0.16    -0.159  -0.029  0.676   0.6     0.47    0.36    0.616   0.532   0.69    0.7000
0.75    6.75    330     -3.8    2.4     4.5     1.299   -0.790  0.275   -0.1    -0.41   2.682   0.0  -0.095  4.75    0       -0.1    0.53    0.07    0.68    -0.0025 0.14    0.14    0.14    0.13    -0.001  0.0007  -0.0041 0.0787  0.505   0.208   0.129   0       0.158   -0.141  0.061   0.631   0.615   0.47    0.36    0.566   0.548   0.73    0.6900
1       6.75    330     -3.5    2.4     4.5     1.043   -0.790  0.275   -0.1    -0.41   2.763   0.0  -0.11   4.3     0       -0.1    0.5     0.15    0.57    -0.0025 0.17    0.17    0.17    0.14    -0.0005 0.0007  -0.0032 0.0476  0.358   0.208   0.152   0       0.145   -0.144  0.062   0.609   0.63    0.47    0.36    0.541   0.565   0.77    0.6800
1.5     6.75    330     -2.4    2.4     4.5     0.665   -0.790  0.275   -0.1    -0.41   2.836   0.0  -0.124  2.6     0       -0.1    0.42    0.27    0.42    -0.0022 0.22    0.21    0.2     0.16    -0.0004 0.0006  -0.002  -0.0163 0.131   0.108   0.118   0       0.131   -0.126  0.037   0.578   0.64    0.47    0.36    0.506   0.576   0.8     0.6600
2       6.75    330     -1      2.4     4.5     0.329   -0.790  0.275   -0.1    -0.41   2.897   0.0  -0.138  0.55    0       -0.1    0.35    0.35    0.31    -0.0019 0.26    0.25    0.22    0.16    -0.0002 0.0003  -0.0017 -0.1203 0.123   0.068   0.119   0       0.083   -0.075  -0.143  0.555   0.65    0.47    0.36    0.48    0.587   0.8     0.6200
3       6.82    330     0       2.4     4.5     -0.060  -0.790  0.275   -0.1    -0.41   2.906   0.0  -0.172  -0.95   0       -0.1    0.2     0.46    0.16    -0.0015 0.34    0.3     0.23    0.16    0       0       -0.002  -0.2719 0.109   -0.023  0.093   0       0.07    -0.021  -0.028  0.548   0.64    0.47    0.36    0.472   0.576   0.8     0.5500
4       6.92    330     0       2.4     4.5     -0.299  -0.790  0.275   -0.1    -0.41   2.889   0.0  -0.197  -0.95   0       -0.1    0       0.54    0.05    -0.001  0.41    0.32    0.23    0.14    0       0       -0.002  -0.2958 0.135   0.028   0.084   0       0.101   0.072   -0.097  0.527   0.63    0.47    0.36    0.447   0.565   0.76    0.5200
5       7       330     0       2.4     4.5     -0.562  -0.765  0.275   -0.1    -0.41   2.898   0.0  -0.218  -0.93   0       -0.1    0       0.61    -0.04   -0.001  0.51    0.32    0.22    0.13    0       0       -0.002  -0.2718 0.189   0.031   0.058   0       0.095   0.205   0.015   0.505   0.63    0.47    0.36    0.425   0.568   0.72    0.5000
6       7.06    330     0       2.4     4.5     -0.875  -0.711  0.275   -0.1    -0.41   2.896   0.0  -0.235  -0.91   0       -0.2    0       0.65    -0.11   -0.001  0.55    0.32    0.2     0.1     0       0       -0.002  -0.2517 0.215   0.024   0.065   0       0.133   0.285   0.104   0.477   0.63    0.47    0.36    0.395   0.571   0.7     0.5000
7.5     7.15    330     0       2.4     4.5     -1.303  -0.634  0.275   -0.1    -0.41   2.870   0.0  -0.255  -0.87   0       -0.2    0       0.72    -0.19   -0.001  0.49    0.28    0.17    0.09    0       0       -0.002  -0.14   0.15    -0.07   0       0       0.151   0.329   0.299   0.457   0.63    0.47    0.36    0.378   0.575   0.67    0.5000
10      7.25    330     0       2.4     4.5     -1.928  -0.529  0.275   -0.1    -0.41   2.843   0.0  -0.285  -0.8    0       -0.2    0       0.8     -0.3    -0.001  0.42    0.22    0.14    0.08    0       0       -0.002  -0.0216 0.092   -0.159  -0.05   0       0.124   0.301   0.243   0.429   0.63    0.47    0.36    0.359   0.585   0.64    0.5000
    """


def _parse_table():
    lines = [ln for ln in COEFFS_TEXT.strip("\n").split("\n")]
    header = lines[0].split()
    assert header[0] == "IMT", header[:3]
    cols = header[1:]
    rows = {}
    for ln in lines[1:]:
        toks = ln.split()
        if not toks:
            continue
        imt = toks[0]
        vals = [float(t) for t in toks[1:]]
        assert len(vals) == len(cols), (imt, len(vals), len(cols))
        rows[imt] = dict(zip(cols, vals))
    return cols, rows


COLUMNS, ROWS = _parse_table()

# --- engine default width (documented: ASK14 publishes none) ----------------

def default_width(mag):
    """Wells & Coppersmith (1994) subsurface crustal width, engine caps."""
    return min(80.0, max(8.0, 10 ** (-1.01 + 0.32 * mag)))

# --- scalar functional form (hazardlib function names kept) -----------------

def _get_basic_term(C, mag, rrup):
    c4m = C["c4"] - (C["c4"] - 1.) * (5. - mag)
    if mag > 5.:
        c4m = C["c4"]
    if mag < 4:
        c4m = 1.
    R = math.sqrt(rrup ** 2. + c4m ** 2.)
    base = C["a1"] + C["a17"] * rrup
    if mag >= C["m1"]:
        base += (C["a5"] * (mag - C["m1"]) + C["a8"] * (8.5 - mag) ** 2.
                 + (C["a2"] + C["a3"] * (mag - C["m1"])) * math.log(R))
    elif mag >= CONSTS["m2"]:
        base += (C["a4"] * (mag - C["m1"]) + C["a8"] * (8.5 - mag) ** 2.
                 + (C["a2"] + C["a3"] * (mag - C["m1"])) * math.log(R))
    else:
        base += (C["a4"] * (CONSTS["m2"] - C["m1"]) + C["a8"] * (8.5 - CONSTS["m2"]) ** 2.
                 + C["a6"] * (mag - CONSTS["m2"]) + C["a7"] * (mag - CONSTS["m2"]) ** 2.
                 + (C["a2"] + C["a3"] * (CONSTS["m2"] - C["m1"])) * math.log(R))
    return base


def _get_faulting_style_term(C, mag, rake):
    f7 = C["a11"] * min(max(mag - 4., 0.), 1.)
    f8 = C["a12"] * min(max(mag - 4., 0.), 1.)
    return (f7 * (1.0 if (30 < rake < 150) else 0.0)
            + f8 * (1.0 if (-150 < rake < -30) else 0.0))


def _hw_taper1(dip):
    T1 = (90. - dip) / 45.0
    if dip <= 30.:
        T1 = 60. / 45.
    return T1


def _hw_taper2(mag):
    a2hw = 0.2
    T2 = 1. + a2hw * (mag - 6.5) - (1. - a2hw) * (mag - 6.5) ** 2
    if mag > 6.5:
        T2 = 1. + a2hw * (mag - 6.5)
    if mag <= 5.5:
        T2 = 0.
    return T2


def _hw_taper3(rx, dip, width):
    r1 = width * math.cos(math.radians(dip))
    r2 = 3. * r1
    if rx < r1:
        return CONSTS["h1"] + CONSTS["h2"] * (rx / r1) + CONSTS["h3"] * (rx / r1) ** 2
    if r1 <= rx <= r2:
        return 1. - (rx - r1) / (r2 - r1)
    return 0.


def _hw_taper4(ztor):
    return 1. - ztor ** 2. / 100. if ztor <= 10. else 0.


def _hw_taper5(rx, ry0):
    ry1 = rx * math.tan(math.radians(20.))
    if (ry0 - ry1) <= 0.0:
        return 1.
    if (ry0 - ry1) < 5.0:
        return 1. - (ry0 - ry1) / 5.0
    return 0.


def _get_hanging_wall_term(C, mag, rx, ry0, ztor, dip, width):
    if not (rx > 0):
        return 0.
    if dip == 90.:
        return 0.
    return (C["a13"] * _hw_taper1(dip) * _hw_taper2(mag)
            * _hw_taper3(rx, dip, width) * _hw_taper4(ztor) * _hw_taper5(rx, ry0))


def _get_vs30star(vs30, period):
    if period is not None:
        if period <= 0.50:
            v1 = 1500.0
        elif period < 3.0:
            v1 = math.exp(-0.35 * math.log(period / 0.5) + math.log(1500.))
        else:
            v1 = 800.0
    else:
        v1 = 1500.0  # PGA and PGV
    return min(vs30, v1)


def _get_site_response_term(C, period, vs30, sa1180):
    vs30_star = _get_vs30star(vs30, period)
    rat = vs30_star / C["vlin"]
    if vs30 >= C["vlin"]:
        return (C["a10"] + C["b"] * CONSTS["n"]) * math.log(rat)
    return (C["a10"] * math.log(rat)
            - C["b"] * math.log(sa1180 + C["c"])
            + C["b"] * math.log(sa1180 + C["c"] * rat ** CONSTS["n"]))


def _get_z1pt0ref(vs30):
    """eq. 18 (region != JPN), km."""
    return math.exp((-7.67 / 4.) * math.log(
        (vs30 ** 4 + 610. ** 4) / (1360. ** 4 + 610. ** 4))) / 1000.


def _get_basin_term(C, vs30):
    """Unmeasured z1pt0 -> z10 = z1ref(vs30) -> factor = ln(1) = 0 exactly."""
    z1ref = _get_z1pt0ref(vs30)
    factor = math.log((z1ref + 0.01) / (z1ref + 0.01))
    return 0.0 * factor  # f2(vs30) * factor + adj(0); f2 irrelevant at factor 0


def _get_top_of_rupture_depth_term(C, ztor):
    return C["a15"] * min(ztor / 20.0, 1.)


def _get_mean(C, period, mag, g, vs30_eval, sa1180_arg):
    return (_get_basic_term(C, mag, g["rrup"])
            + _get_hanging_wall_term(C, mag, g["rx"], g["ry0"], g["ztor"],
                                     g["dip"], g["widthKm"])
            + _get_site_response_term(C, period, vs30_eval, sa1180_arg)
            + _get_top_of_rupture_depth_term(C, g["ztor"])
            + _get_faulting_style_term(C, mag, g["rake"])
            + 0.0  # aftershock f11: off (mainshock use)
            + _get_basin_term(C, vs30_eval)
            + 0.0)  # regional term: None (California base)


def _get_sa1180(C, period, mag, g):
    """Mean at the rock reference (Vs30 = 1180, reference shaking 0)."""
    return math.exp(_get_mean(C, period, mag, g, REF_VS, 0.0))


def _get_derivative(C, sa1180, vs30):
    if not (vs30 < C["vlin"]):
        return 0.0
    return (C["b"] * sa1180 * (-1. / (sa1180 + C["c"])
            + 1. / (sa1180 + C["c"] * (vs30 / C["vlin"]) ** CONSTS["n"])))


def _get_stddevs(C, mag, rrup, vs30, sa1180):
    """region None branch; vs30measured=False -> s1e/s2e."""
    phi_al = C["s1e"] + (C["s2e"] - C["s1e"]) / 2. * (mag - 4.)
    if mag < 4:
        phi_al = C["s1e"]
    if mag >= 6:
        phi_al = C["s2e"]
    tau_al = C["s3"] + (C["s4"] - C["s3"]) / 2. * (mag - 5.)
    if mag < 5.:
        tau_al = C["s3"]
    if mag >= 7.:
        tau_al = C["s4"]
    derAmp = _get_derivative(C, sa1180, vs30)
    phi_amp = 0.4
    if phi_al < phi_amp:
        phi_amp = 0.99 * phi_al
    phi_b = math.sqrt(phi_al ** 2 - phi_amp ** 2)
    phi = math.sqrt(phi_b ** 2 * (1 + derAmp) ** 2 + phi_amp ** 2)
    tau = tau_al * (1 + derAmp)
    return math.sqrt(phi ** 2 + tau ** 2), tau, phi


SA_KEYS = ["0.01", "0.02", "0.03", "0.05", "0.075", "0.1", "0.15", "0.2",
           "0.25", "0.3", "0.4", "0.5", "0.75", "1", "1.5", "2", "3", "4",
           "5", "6", "7.5", "10"]


def _sa_key(T):
    for k in SA_KEYS:
        if abs(float(k) - T) < 1e-12:
            return k
    return None


def _sa_bracket(T):
    nums = [float(k) for k in SA_KEYS]
    if not (nums[0] < T < nums[-1]):
        return None
    for i in range(len(nums) - 1):
        if nums[i] < T < nums[i + 1]:
            return SA_KEYS[i], SA_KEYS[i + 1], nums[i], nums[i + 1]
    return None


def _resolve_geom(mag, geom):
    """physics.js _ask2014Geom mirror: null width -> the engine default."""
    g = dict(geom)
    if g["widthKm"] is None:
        g["widthKm"] = default_width(mag)
    return g


def ask14_ln(imt, mag, geom):
    geom = _resolve_geom(mag, geom)
    if imt in ("pga", "pgv"):
        C = ROWS[imt]
        sa1180 = _get_sa1180(C, None, mag, geom)
        return _get_mean(C, None, mag, geom, geom["vs30"], sa1180)
    T = float(imt)
    key = _sa_key(T)
    if key is None:
        br = _sa_bracket(T)
        if br is None:
            return None
        loC, hiC = ROWS[br[0]], ROWS[br[1]]
        lo = _get_mean(loC, br[2], mag, geom, geom["vs30"], _get_sa1180(loC, br[2], mag, geom))
        hi = _get_mean(hiC, br[3], mag, geom, geom["vs30"], _get_sa1180(hiC, br[3], mag, geom))
        w = (math.log(T) - math.log(br[2])) / (math.log(br[3]) - math.log(br[2]))
        return lo + w * (hi - lo)
    C = ROWS[key]
    sa1180 = _get_sa1180(C, T, mag, geom)
    return _get_mean(C, T, mag, geom, geom["vs30"], sa1180)


def ask14_sigma(imt, mag, geom):
    geom = _resolve_geom(mag, geom)

    def row_sig(C, period):
        sa1180 = _get_sa1180(C, period, mag, geom)
        return _get_stddevs(C, mag, geom["rrup"], geom["vs30"], sa1180)

    if imt in ("pga", "pgv"):
        return row_sig(ROWS[imt], None)
    T = float(imt)
    key = _sa_key(T)
    if key:
        return row_sig(ROWS[key], T)
    br = _sa_bracket(T)
    if br is None:
        return None
    lo = row_sig(ROWS[br[0]], br[2])
    hi = row_sig(ROWS[br[1]], br[3])
    w = (math.log(T) - math.log(br[2])) / (math.log(br[3]) - math.log(br[2]))
    return tuple(a + w * (b - a) for a, b in zip(lo, hi))


# --- fixture grid ------------------------------------------------------------
def point_geom(rjb, ztor, vs30, dip, rake, ry0=0.0, width=None):
    rrup = math.sqrt(rjb * rjb + ztor * ztor)
    return {"rrup": rrup, "rjb": rjb, "rx": rjb, "ry0": ry0,
            "ztor": ztor, "dip": dip, "rake": rake, "vs30": vs30,
            "widthKm": width, "hypoDepthKm": None}


M_GRID = [5.0, 5.5, 6.5, 7.0, 7.5, 8.0]
RJB_GRID = [0.1, 1, 10, 30, 80, 100, 300]
ZTOR_GRID = [0.5, 5, 12, 20]
V_GRID = [180, 400, 760, 1130, 1500]
DIP_GRID = [30, 60, 90]
RAKE_GRID = [-90, 0, 90]
M_SA = [5.5, 6.5, 7.5]
RJB_SA = [1, 30, 100]
ZTOR_SA = [2, 12]
V_SA = [270, 760, 1500]
RAKE_SA = [0, 90]
RAKE_BND = [30, 150, -30, -150]
HW_WIDTH = [8, 20]
HW_RX = [0, 2, 6, 15, 40]
HW_ZTOR = [2, 8]
HW_M = [6.0, 7.0]
HW_DIP = [45, 70]
RY0_GRID = [0, 3, 8]  # pin the T5 along-strike taper


def generate():
    points = []

    def emit(imt, mag, geom, grid, width_in):
        lnA = ask14_ln(imt, mag, geom)
        sig = ask14_sigma(imt, mag, geom)
        points.append([imt, mag, geom["rrup"], geom["rjb"], geom["rx"],
                       geom["ry0"], geom["ztor"], geom["dip"], geom["rake"],
                       geom["vs30"], width_in, geom["hypoDepthKm"],
                       grid, lnA, sig[0], sig[1], sig[2]])

    for mag in M_GRID:
        for rjb in RJB_GRID:
            for ztor in ZTOR_GRID:
                for vs30 in V_GRID:
                    for dip in DIP_GRID:
                        for rake in RAKE_GRID:
                            g = point_geom(rjb, ztor, vs30, dip, rake)
                            for imt in ("pga", "pgv"):
                                emit(imt, mag, g, "core", None)
    for imt in SA_KEYS:
        for mag in M_SA:
            for rjb in RJB_SA:
                for ztor in ZTOR_SA:
                    for vs30 in V_SA:
                        for rake in RAKE_SA:
                            g = point_geom(rjb, ztor, vs30, 60, rake)
                            emit(imt, mag, g, "sa", None)
    for rake in RAKE_BND:
        for mag in (6.0, 7.0):
            for rjb in (10, 30):
                for vs30 in (270, 760):
                    for dip in (60, 90):
                        g = point_geom(rjb, 5, vs30, dip, rake)
                        emit("pga", mag, g, "rakeBnd", None)
    for w in HW_WIDTH:
        for rx in HW_RX:
            for ztor in HW_ZTOR:
                for mag in HW_M:
                    for dip in HW_DIP:
                        for ry0 in RY0_GRID:
                            g = point_geom(rx, ztor, 760, dip, 90, ry0=ry0, width=w)
                            emit("pga", mag, g, "hw", w)
    return points


FIELDS = ["imt", "mag", "rrup", "rjb", "rx", "ry0", "ztor", "dip", "rake",
          "vs30", "widthKm", "hypoDepthKm", "grid", "lnA", "sigma", "tau", "phi"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join("tools", "data", "gmpe-fixtures-ask14.json"))
    args = ap.parse_args()
    points = generate()
    doc = {
        "schema": "quake-sim-gmpe-fixtures-ask14-v1",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00"),
        "source": {
            "repository": "gem/oq-engine (master via api.github.com contents, pinned IP 140.82.112.5)",
            "path": "openquake/hazardlib/gsim/abrahamson_2014.py",
            "sha256": "386e496e65f3ad228df618bc2c399275686018ed432c7ba30a083ed2ef0f8f8c",
            "paper": "Abrahamson, Silva & Kamai (2014) Earthquake Spectra 30(3) 1025-1055",
            "basis": "scalar transcription of the hazardlib implementation "
                     "(AbrahamsonEtAl2014 region=None, unmeasured z1pt0 basin "
                     "default = 0, vs30measured=False, no aftershock/regional/"
                     "epistemic adjustments, W&C default width; independent of "
                     "physics.js)"
        },
        "units": "lnA: pga/SA = ln(median in g), pgv = ln(median in cm/s) — hazardlib "
                 "native; sigma/tau/phi in ln units. physics.js pgaAsk2014 converts "
                 "g -> gal with 980.665",
        "constants": dict(CONSTS, refVs=REF_VS),
        "table": {"columns": COLUMNS, "rows": ROWS},
        "pointFields": FIELDS,
        "points": points
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print("wrote %s: %d points, %d table rows, %d columns" %
          (args.out, len(points), len(ROWS), len(COLUMNS)))


if __name__ == "__main__":
    main()
