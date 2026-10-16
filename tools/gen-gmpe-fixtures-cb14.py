#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the frozen CB14 (Campbell & Bozorgnia 2014, NGA-West2) GMPE
fixtures.

The physics.js `cb2014Ln`/`cb2014SigmaLn` implementation is asserted in
tests/gmpe-cb14.test.js against reference values produced by this script. The
functional form below is a scalar transcription of the OFFICIAL
openquake.hazardlib implementation (gem/oq-engine,
openquake/hazardlib/gsim/campbell_bozorgnia_2014.py) — NOT of physics.js — so
the two implementations are independent: the coefficient table is embedded
verbatim from the hazardlib source and the equation structure follows the
hazardlib functions _get_magnitude_term / _get_geometric_attenuation_term /
_get_style_of_faulting_term / _get_hanging_wall_term (Eqs. 7-16) /
_get_shallow_site_response_term (SJ=False) / _get_basin_term /
_get_hypocentral_depth_term / _get_fault_dip_term /
_get_anelastic_attenuation_term / compute_sigma one for one.

Provenance of the transcription source (keep in sync when regenerating):
  repository: gem/oq-engine (master via api.github.com contents, pinned IP)
  path:       openquake/hazardlib/gsim/campbell_bozorgnia_2014.py
  sha256:     c634814d0cd9582ab84ba3d52b71ce35a12da202f711646f943fa1e6000dd7fc
  paper:      Campbell & Bozorgnia (2014) Earthquake Spectra 30(3) 1087-1115

Scope faithfully transcribed (class CampbellBozorgnia2014, base table):
  * Median model for pga/pgv + all 21 SA rows (0.01-10 s; cav/ia rows not
    carried — the engine consumes no CAV/IA path); hazardlib soil-PGA floor
    for SA at T < 0.25 s applied per row.
  * SJ=False (global shallow-site response, no Japan c12/c13 term); base
    anelastic Dc20 = 0 (the HighQ/LowQ aliases are NOT exercised).
  * Basin term: unmeasured z2pt5 -> the paper's California Vs30->Z2.5
    relation (Eq. 33); nonzero only for stiff sites (z2pt5 < 1 km).
  * sigma_mu_epsilon = 0; USGS basin scaling / CyberShake adjustments off.
  * Point-source defaults: width estimated by the paper's Eq. 39 with the
    documented zbot = 20 km seismogenic default; hypo_depth by Eqs. 35-37;
    ztor carried explicitly (no ztor estimator).

Output units follow hazardlib: ln(PGA)/ln(SA) in g, ln(PGV) in cm/s.
physics.js pgaCb2014 converts g -> gal with the standard gravity 980.665.

Usage: python tools/gen-gmpe-fixtures-cb14.py [--out=tools/data/gmpe-fixtures-cb14.json]
"""
import argparse
import datetime
import json
import math
import os

# --- hazardlib module constants (verbatim) ---------------------------------
CONSTS = {"h4": 1.0, "c": 1.88, "n": 1.18}
ZBOT_KM = 20.0  # documented seismogenic default for the Eq. 39 width cap

# --- hazardlib COEFFS table (verbatim from the frozen source) --------------
COEFFS_TEXT = """    IMT         c0     c1      c2      c3      c4      c5     c6     c7     c8      c9    c10     c11     c12    c13      c14     c15    c16      c17     c18      c19      c20  Dc20     a2     h1     h2      h3      h5      h6    k1      k2     k3   phi1   phi2   tau1   tau2  rho1pga  rho2pga      philnAF   phiC  rholny
    0.01    -4.365  0.977   0.533  -1.485  -0.499  -2.773  0.248  6.753      0  -0.214   0.72   1.094   2.191  1.416   -0.007  -0.207   0.39   0.0981  0.0334  0.00755  -0.0055     0  0.168  0.242  1.471  -0.714  -0.336   -0.27   865  -1.186  1.839  0.734  0.492  0.404  0.325        1        1          0.3   0.19       1
    0.02    -4.348  0.976   0.549  -1.488  -0.501  -2.772  0.247  6.502      0  -0.208   0.73   1.149   2.189  1.453  -0.0167  -0.199  0.387   0.1009  0.0327  0.00759  -0.0055     0  0.166  0.244  1.467  -0.711  -0.339  -0.263   865  -1.219   1.84  0.738  0.496  0.417  0.326    0.999    0.998          0.3  0.166   0.998
    0.03    -4.024  0.931   0.628  -1.494  -0.517  -2.782  0.246  6.291      0  -0.213  0.759    1.29   2.164  1.476  -0.0422  -0.202  0.378   0.1095  0.0331   0.0079  -0.0057     0  0.167  0.246  1.467  -0.713  -0.338  -0.259   908  -1.273  1.841  0.747  0.503  0.446  0.344    0.987    0.987          0.3  0.166   0.986
    0.05    -3.479  0.887   0.674  -1.388  -0.615  -2.791   0.24  6.317      0  -0.244  0.826   1.449   2.138  1.549  -0.0663  -0.339  0.295   0.1226   0.027  0.00803  -0.0063     0  0.173  0.251  1.449  -0.701  -0.338  -0.263  1054  -1.346  1.843  0.777   0.52  0.508  0.377    0.955    0.946          0.3  0.166   0.938
    0.075   -3.293  0.902   0.726  -1.469  -0.596  -2.745  0.227  6.861      0  -0.266  0.815   1.535   2.446  1.772  -0.0794  -0.404  0.322   0.1165  0.0288  0.00811   -0.007     0  0.198   0.26  1.435  -0.695  -0.347  -0.219  1086  -1.471  1.845  0.782  0.535  0.504  0.418    0.943    0.897          0.3  0.165   0.887
    0.1     -3.666  0.993   0.698  -1.572  -0.536  -2.633   0.21  7.294      0  -0.229  0.831   1.615   2.969  1.916  -0.0294  -0.416  0.384   0.0998  0.0325  0.00744  -0.0073     0  0.174  0.259  1.449  -0.708  -0.391  -0.201  1032  -1.624  1.847  0.769  0.543  0.445  0.426    0.942    0.883          0.3  0.162    0.87
    0.15    -4.866  1.267    0.51  -1.669   -0.49  -2.458  0.183  8.031      0  -0.211  0.749   1.877   3.544  2.161   0.0642  -0.407  0.417    0.076  0.0388  0.00716  -0.0069     0  0.198  0.254  1.461  -0.715  -0.449  -0.099   878  -1.931  1.852  0.769  0.543  0.382  0.387    0.921    0.891          0.3  0.158   0.876
    0.2     -5.411  1.366   0.447   -1.75  -0.451  -2.421  0.182  8.385      0  -0.163  0.764   2.069   3.707  2.465   0.0968  -0.311  0.404   0.0571  0.0437  0.00688   -0.006     0  0.204  0.237  1.484  -0.721  -0.393  -0.198   748  -2.188  1.856  0.761  0.552  0.339  0.338    0.874    0.881          0.3   0.17    0.87
    0.25    -5.962  1.458   0.274  -1.711  -0.404  -2.392  0.189  7.534      0   -0.15  0.716   2.205   3.343  2.766   0.1441  -0.172  0.466   0.0437  0.0463  0.00556  -0.0055     0  0.185  0.206  1.581  -0.787  -0.339   -0.21   654  -2.381  1.861  0.744  0.545   0.34  0.316    0.809    0.861          0.3   0.18    0.85
    0.3     -6.403  1.528   0.193   -1.77  -0.321  -2.376  0.195   6.99      0  -0.131  0.737   2.306   3.334  3.011   0.1597  -0.084  0.528   0.0323  0.0508  0.00458  -0.0049     0  0.164   0.21  1.586  -0.795  -0.447  -0.121   587  -2.518  1.865  0.727  0.568   0.34    0.3    0.741    0.824          0.3  0.186   0.819
    0.4     -7.566  1.739   -0.02  -1.594  -0.426  -2.303  0.185  7.012      0  -0.159  0.738   2.398   3.544  3.203    0.141   0.085   0.54   0.0209  0.0432  0.00401  -0.0037     0   0.16  0.226  1.544   -0.77  -0.525  -0.086   503  -2.657  1.874   0.69  0.593  0.356  0.264    0.635    0.738          0.3  0.191   0.743
    0.5     -8.379  1.872  -0.121  -1.577   -0.44  -2.296  0.186  6.902      0  -0.153  0.718   2.355   3.016  3.333   0.1474   0.233  0.638   0.0092  0.0405  0.00388  -0.0027     0  0.184  0.217  1.554   -0.77  -0.407  -0.281   457  -2.669  1.883  0.663  0.611  0.379  0.263    0.553    0.661          0.3  0.198   0.684
    0.75    -9.841  2.021  -0.042  -1.757  -0.443  -2.232  0.186  5.522      0   -0.09  0.795   1.995   2.616  3.054   0.1764   0.411  0.776  -0.0082   0.042   0.0042  -0.0016     0  0.216  0.154  1.626   -0.78  -0.371  -0.285   410  -2.401  1.906  0.606  0.633   0.43  0.326    0.393    0.526          0.3  0.206   0.562
    1      -11.011   2.18  -0.069  -1.707  -0.527  -2.158  0.169   5.65      0  -0.105  0.556   1.447    2.47  2.562   0.2593   0.479  0.771  -0.0131  0.0426  0.00409  -0.0006     0  0.596  0.117  1.616  -0.733  -0.128  -0.756   400  -1.955  1.929  0.579  0.628   0.47  0.353    0.313    0.438          0.3  0.208   0.467
    1.5    -12.469   2.27   0.047  -1.621   -0.63  -2.063  0.158  5.795      0  -0.058   0.48    0.33   2.108  1.453   0.2881   0.566  0.748  -0.0187   0.038  0.00424        0     0  0.596  0.117  1.616  -0.733  -0.128  -0.756   400  -1.025  1.974  0.541  0.603  0.497  0.399    0.242     0.36          0.3  0.221   0.364
    2      -12.969  2.271   0.149  -1.512  -0.768  -2.104  0.158  6.632      0  -0.028  0.401  -0.514   1.327  0.657   0.3112   0.562  0.763  -0.0258  0.0252  0.00448        0     0  0.596  0.117  1.616  -0.733  -0.128  -0.756   400  -0.299  2.019  0.529  0.588  0.499    0.4    0.234    0.318          0.3  0.225   0.298
    3      -13.306   2.15   0.368  -1.315   -0.89  -2.051  0.148  6.759      0       0  0.206  -0.848   0.601  0.367   0.3478   0.534  0.686  -0.0311  0.0236  0.00345        0     0  0.596  0.117  1.616  -0.733  -0.128  -0.756   400       0   2.11  0.527  0.578    0.5  0.417    0.236    0.295          0.3  0.222   0.234
    4       -14.02  2.132   0.726  -1.506  -0.885  -1.986  0.135  7.978      0       0  0.105  -0.793   0.568  0.306   0.3747   0.522  0.691  -0.0413  0.0102  0.00603        0     0  0.596  0.117  1.616  -0.733  -0.128  -0.756   400       0    2.2  0.521  0.559  0.543  0.393    0.232    0.274          0.3  0.226   0.202
    5      -14.558  2.116   1.027  -1.721  -0.878  -2.021  0.135  8.538      0       0      0  -0.748   0.356  0.268   0.3382   0.477   0.67  -0.0281  0.0034  0.00805        0     0  0.596  0.117  1.616  -0.733  -0.128  -0.756   400       0  2.291  0.502  0.551  0.534  0.421    0.182    0.247          0.3  0.229   0.184
    7.5    -15.509  2.223   0.169  -0.756  -1.077  -2.179  0.165  8.468      0       0      0  -0.664   0.075  0.374   0.3754   0.321  0.757  -0.0205   0.005   0.0028        0     0  0.596  0.117  1.616  -0.733  -0.128  -0.756   400       0  2.517  0.457  0.546  0.523  0.438    0.142    0.203          0.3  0.237   0.176
    10     -15.975  2.132   0.367    -0.8  -1.282  -2.244   0.18  6.564      0       0      0  -0.576  -0.027  0.297   0.3506   0.174  0.621   0.0009  0.0099  0.00458        0     0  0.596  0.117  1.616  -0.733  -0.128  -0.756   400       0  2.744  0.441  0.543  0.466  0.438    0.111    0.103          0.3  0.237   0.154
    pga     -4.416  0.984   0.537  -1.499  -0.496  -2.773  0.248  6.768      0  -0.212   0.72    1.09   2.186   1.42  -0.0064  -0.202  0.393   0.0977  0.0333  0.00757  -0.0055     0  0.167  0.241  1.474  -0.715  -0.337   -0.27   865  -1.186  1.839  0.734  0.492  0.409  0.322        1        1          0.3  0.271       1
    pgv     -2.895   1.51    0.27  -1.299  -0.453  -2.466  0.204  5.837      0  -0.168  0.305   1.713   2.602  2.457    0.106   0.332  0.585   0.0517  0.0327  0.00613  -0.0017     0  0.596  0.117  1.616  -0.733  -0.128  -0.756   400  -1.955  1.929  0.655  0.494  0.317  0.297    0.877    0.654          0.3   0.29   0.684
    cav      -4.75  1.397   0.282  -1.062   -0.17  -1.624  0.134  6.325  0.054    -0.1  0.469   1.015   1.208  1.777   0.1248  -0.191  1.087   0.0432  0.0127  0.00429  -0.0043     0  0.167  0.241  1.474  -0.715  -0.337   -0.27   400  -1.311      1  0.514  0.394  0.276  0.257    0.842     0.78          0.3      0       0
    ia     -10.272  2.318    0.88  -2.672  -0.837  -4.441  0.416  4.869  0.187  -0.196  1.165   1.596   2.829   2.76    0.108  -0.315  1.612   0.1311  0.0453  0.01242  -0.0103     0  0.167  0.241  1.474  -0.715  -0.337   -0.27   400  -1.982      1  1.174  0.809  0.614  0.435    0.948    0.911  0.615989848      0       0
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

# --- estimators (hazardlib _update_ctx; ztor is carried, not estimated) ----

def est_width(mag, dip, ztor):
    """Eq. 39, capped by the seismogenic default zbot = ZBOT_KM."""
    w = math.sqrt(10 ** ((mag - 4.07) / 0.98))
    sd = abs(math.sin(math.radians(dip)))
    if sd > 0:
        w = min(w, (ZBOT_KM - ztor) / sd)
    return max(w, 0.1)


def est_hypo_depth(mag, dip, ztor, width):
    """Eqs. 35-37."""
    fdz_m = -4.317 + 0.984 * mag if mag < 6.75 else 2.325
    fdz_d = 0.0445 * (dip - 40) if dip <= 40 else 0.0
    zbor = ztor + width * math.sin(math.radians(dip))
    dz = 0.0
    if zbor > ztor:
        dz = math.exp(min(fdz_m + fdz_d, math.log(0.9 * (zbor - ztor))))
    return ztor + dz

# --- scalar functional form (hazardlib function names kept) -----------------

def _get_magnitude_term(C, mag):
    f_mag = C["c0"] + C["c1"] * mag
    if 4.5 < mag <= 5.5:
        f_mag += C["c2"] * (mag - 4.5)
    elif 5.5 < mag <= 6.5:
        f_mag += C["c2"] * (mag - 4.5) + C["c3"] * (mag - 5.5)
    elif mag > 6.5:
        f_mag += (C["c2"] * (mag - 4.5) + C["c3"] * (mag - 5.5)
                  + C["c4"] * (mag - 6.5))
    return f_mag


def _get_geometric_attenuation_term(C, mag, rrup):
    return (C["c5"] + C["c6"] * mag) * math.log(math.sqrt(rrup ** 2 + C["c7"] ** 2))


def _get_style_of_faulting_term(C, mag, rake):
    frv = 1.0 if (30. < rake < 150.) else 0.0
    fnm = 1.0 if (-150. < rake < -30.) else 0.0
    fflt_m = mag - 4.5
    if mag <= 4.5:
        fflt_m = 0.0
    elif mag > 5.5:
        fflt_m = 1.0
    return (C["c8"] * frv + C["c9"] * fnm) * fflt_m


def _get_f1rx(C, r_x, r_1):
    rxr1 = r_x / r_1
    return C["h1"] + C["h2"] * rxr1 + C["h3"] * rxr1 ** 2


def _get_f2rx(C, r_x, r_1, r_2):
    drx = (r_x - r_1) / (r_2 - r_1)
    return CONSTS["h4"] + C["h5"] * drx + C["h6"] * drx ** 2


def _get_hanging_wall_term(C, mag, rrup, rjb, rx, ztor, dip, width):
    r_1 = width * math.cos(math.radians(dip))
    r_2 = 62.0 * mag - 350.0
    if 0.0 <= rx < r_1:
        fhngrx = _get_f1rx(C, rx, r_1)
    elif rx >= r_1:
        fhngrx = max(_get_f2rx(C, rx, r_1, r_2), 0.0)
    else:
        fhngrx = 0.0
    fhngrrup = (rrup - rjb) / rrup if rrup > 0.0 else 1.0
    fhngrmag = (mag - 5.5) * (1.0 + C["a2"] * (mag - 6.5))
    if mag < 5.5:
        fhngrmag = 0.0
    elif mag > 6.5:
        fhngrmag = 1.0 + C["a2"] * (mag - 6.5)
    fhngrztor = 0.0 if ztor > 16.66 else 1.0 - 0.06 * ztor
    fhngrdip = (90.0 - dip) / 45.0
    return C["c10"] * fhngrx * fhngrrup * fhngrmag * fhngrztor * fhngrdip


def _get_shallow_site_response_term(C, vs30, pga_rock):
    """SJ = False (global form only)."""
    vs_mod = vs30 / C["k1"]
    f_site_g = C["c11"] * math.log(vs_mod)
    if vs30 > C["k1"]:
        f_site_g += C["k2"] * CONSTS["n"] * math.log(vs_mod)
    else:
        f_site_g += C["k2"] * (math.log(pga_rock + CONSTS["c"] * (vs_mod ** CONSTS["n"]))
                               - math.log(pga_rock + CONSTS["c"]))
    return f_site_g


def _get_z2pt5_ref(vs30):
    """California basin model, Eq. 33 (SJ=False)."""
    return math.exp(7.089 - 1.144 * math.log(vs30))


def _get_basin_term(C, vs30):
    """Default (unmeasured) z2pt5 = the California reference at the site Vs30."""
    z2pt5 = _get_z2pt5_ref(vs30)
    if z2pt5 < 1.0:
        return C["c14"] * (z2pt5 - 1.0)  # SJ=False -> c15*SJ = 0
    if z2pt5 > 3.0:
        return C["c16"] * C["k3"] * math.exp(-0.75) * (1.0 - math.exp(-0.25 * (z2pt5 - 3.0)))
    return 0.0


def _get_hypocentral_depth_term(C, mag, hypo_depth):
    fhyp_h = min(max(hypo_depth - 7.0, 0.0), 13.0)
    fhyp_m = C["c17"] + (C["c18"] - C["c17"]) * (mag - 5.5)
    if mag <= 5.5:
        fhyp_m = C["c17"]
    elif mag > 6.5:
        fhyp_m = C["c18"]
    return fhyp_h * fhyp_m


def _get_fault_dip_term(C, mag, dip):
    if mag < 4.5:
        return C["c19"] * dip
    if mag > 5.5:
        return 0.0
    return C["c19"] * (5.5 - mag) * dip


def _get_anelastic_attenuation_term(C, rrup):
    return (C["c20"] + C["Dc20"]) * (rrup - 80.0) if rrup >= 80.0 else 0.0


def _mean(C, mag, g, vs30_eval, pga_rock):
    """get_mean_values: vs30_eval drives the site + basin terms (1100 for the
    rock reference; the site Vs30 otherwise)."""
    site_vs = vs30_eval if vs30_eval is not None else g["vs30"]
    return (_get_magnitude_term(C, mag)
            + _get_geometric_attenuation_term(C, mag, g["rrup"])
            + _get_style_of_faulting_term(C, mag, g["rake"])
            + _get_hanging_wall_term(C, mag, g["rrup"], g["rjb"], g["rx"],
                                     g["ztor"], g["dip"], g["widthKm"])
            + _get_shallow_site_response_term(C, site_vs, pga_rock)
            + _get_basin_term(C, site_vs)
            + _get_hypocentral_depth_term(C, mag, g["hypoDepthKm"])
            + _get_fault_dip_term(C, mag, g["dip"])
            + _get_anelastic_attenuation_term(C, g["rrup"]))


def _pga1100(CP, mag, g):
    return math.exp(_mean(CP, mag, g, 1100.0, None))


def _mean_row(C, CP, period, mag, g):
    pga1100 = _pga1100(CP, mag, g)
    mean = _mean(C, mag, g, None, pga1100)
    if period is not None and period < 0.25:
        # hazardlib compute(): SA at T < 0.25 s raised to the soil PGA when
        # lower (Campbell & Bozorgnia 2013 NGA-West2 report)
        pga_soil = _mean(CP, mag, g, None, pga1100)
        if mean <= pga_soil:
            mean = pga_soil
    return mean, pga1100


def _get_taulny(C, mag):
    res = C["tau2"] + (C["tau1"] - C["tau2"]) * (5.5 - mag)
    if mag <= 4.5:
        res = C["tau1"]
    elif mag >= 5.5:
        res = C["tau2"]
    return res


def _get_philny(C, mag):
    res = C["phi2"] + (C["phi1"] - C["phi2"]) * (5.5 - mag)
    if mag <= 4.5:
        res = C["phi1"]
    elif mag >= 5.5:
        res = C["phi2"]
    return res


def _get_alpha(C, vs30, pga_rock):
    if not (vs30 < C["k1"]):
        return 0.0
    vsk1 = vs30 / C["k1"]
    af1 = pga_rock + CONSTS["c"] * (vsk1 ** CONSTS["n"])
    af2 = pga_rock + CONSTS["c"]
    return C["k2"] * pga_rock * ((1.0 / af1) - (1.0 / af2))


def compute_sigma(C, CP, mag, vs30, pga1100):
    tau_lny_b = _get_taulny(C, mag)
    phi_lny_b = math.sqrt(_get_philny(C, mag) ** 2 - C["philnAF"] ** 2)
    alpha = _get_alpha(C, vs30, pga1100)
    tau_lnpga_b = _get_taulny(CP, mag)
    phi_lnpga_b = math.sqrt(_get_philny(CP, mag) ** 2 - CP["philnAF"] ** 2)
    rho = C["rholny"]
    t = math.sqrt(tau_lny_b ** 2 + alpha ** 2 * tau_lnpga_b ** 2
                  + 2.0 * alpha * rho * tau_lny_b * tau_lnpga_b)
    p = math.sqrt(phi_lny_b ** 2 + C["philnAF"] ** 2
                  + alpha ** 2 * phi_lnpga_b ** 2
                  + 2.0 * alpha * rho * phi_lny_b * phi_lnpga_b)
    return math.sqrt(t ** 2 + p ** 2), t, p


SA_KEYS = ["0.01", "0.02", "0.03", "0.05", "0.075", "0.1", "0.15", "0.2",
           "0.25", "0.3", "0.4", "0.5", "0.75", "1", "1.5", "2", "3", "4",
           "5", "7.5", "10"]


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


def cb14_ln(imt, mag, geom):
    geom = _resolve_geom(mag, geom)
    CP = ROWS["pga"]
    if imt in ("pga", "pgv"):
        return _mean_row(ROWS[imt], CP, None, mag, geom)[0]
    T = float(imt)
    key = _sa_key(T)
    if key:
        return _mean_row(ROWS[key], CP, T, mag, geom)[0]
    br = _sa_bracket(T)
    if br is None:
        return None
    lo = _mean_row(ROWS[br[0]], CP, br[2], mag, geom)[0]
    hi = _mean_row(ROWS[br[1]], CP, br[3], mag, geom)[0]
    w = (math.log(T) - math.log(br[2])) / (math.log(br[3]) - math.log(br[2]))
    return lo + w * (hi - lo)


def cb14_sigma(imt, mag, geom):
    geom = _resolve_geom(mag, geom)
    CP = ROWS["pga"]
    pga1100 = _pga1100(CP, mag, geom)
    if imt in ("pga", "pgv"):
        return compute_sigma(ROWS[imt], CP, mag, geom["vs30"], pga1100)
    T = float(imt)
    key = _sa_key(T)
    if key:
        return compute_sigma(ROWS[key], CP, mag, geom["vs30"], pga1100)
    br = _sa_bracket(T)
    if br is None:
        return None
    lo = compute_sigma(ROWS[br[0]], CP, mag, geom["vs30"], pga1100)
    hi = compute_sigma(ROWS[br[1]], CP, mag, geom["vs30"], pga1100)
    w = (math.log(T) - math.log(br[2])) / (math.log(br[3]) - math.log(br[2]))
    return tuple(a + w * (b - a) for a, b in zip(lo, hi))


def _resolve_geom(mag, geom):
    """physics.js _cb2014Geom mirror: null width/hypo run the estimators."""
    g = dict(geom)
    if g["widthKm"] is None:
        g["widthKm"] = est_width(mag, g["dip"], g["ztor"])
    if g["hypoDepthKm"] is None:
        g["hypoDepthKm"] = est_hypo_depth(mag, g["dip"], g["ztor"], g["widthKm"])
    return g


# --- fixture grid ------------------------------------------------------------
def point_geom(rjb, ztor, vs30, dip, rake, width=None, hypo=None):
    rrup = math.sqrt(rjb * rjb + ztor * ztor)
    return {"rrup": rrup, "rjb": rjb, "rx": rjb, "ry0": 0.0,
            "ztor": ztor, "dip": dip, "rake": rake, "vs30": vs30,
            "widthKm": width, "hypoDepthKm": hypo}


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


def generate():
    points = []

    def emit(imt, mag, geom, grid, width_in, hypo_in):
        lnA = cb14_ln(imt, mag, geom)
        sig = cb14_sigma(imt, mag, geom)
        points.append([imt, mag, geom["rrup"], geom["rjb"], geom["rx"],
                       geom["ry0"], geom["ztor"], geom["dip"], geom["rake"],
                       geom["vs30"], width_in, hypo_in,
                       grid, lnA, sig[0], sig[1], sig[2]])

    for mag in M_GRID:
        for rjb in RJB_GRID:
            for ztor in ZTOR_GRID:
                for vs30 in V_GRID:
                    for dip in DIP_GRID:
                        for rake in RAKE_GRID:
                            # null width/hypo -> the paper estimators run in
                            # BOTH implementations (recorded as null)
                            g = point_geom(rjb, ztor, vs30, dip, rake)
                            for imt in ("pga", "pgv"):
                                emit(imt, mag, g, "core", None, None)
    for imt in SA_KEYS:
        for mag in M_SA:
            for rjb in RJB_SA:
                for ztor in ZTOR_SA:
                    for vs30 in V_SA:
                        for rake in RAKE_SA:
                            g = point_geom(rjb, ztor, vs30, 60, rake)
                            emit(imt, mag, g, "sa", None, None)
    for rake in RAKE_BND:
        for mag in (6.0, 7.0):
            for rjb in (10, 30):
                for vs30 in (270, 760):
                    for dip in (60, 90):
                        g = point_geom(rjb, 5, vs30, dip, rake)
                        emit("pga", mag, g, "rakeBnd", None, None)
    for w in HW_WIDTH:
        for rx in HW_RX:
            for ztor in HW_ZTOR:
                for mag in HW_M:
                    for dip in HW_DIP:
                        g = point_geom(rx, ztor, 760, dip, 90, width=w)
                        emit("pga", mag, g, "hw", w, None)
    return points


FIELDS = ["imt", "mag", "rrup", "rjb", "rx", "ry0", "ztor", "dip", "rake",
          "vs30", "widthKm", "hypoDepthKm", "grid", "lnA", "sigma", "tau", "phi"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join("tools", "data", "gmpe-fixtures-cb14.json"))
    args = ap.parse_args()
    points = generate()
    doc = {
        "schema": "quake-sim-gmpe-fixtures-cb14-v1",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00"),
        "source": {
            "repository": "gem/oq-engine (master via api.github.com contents, pinned IP 140.82.112.5)",
            "path": "openquake/hazardlib/gsim/campbell_bozorgnia_2014.py",
            "sha256": "c634814d0cd9582ab84ba3d52b71ce35a12da202f711646f943fa1e6000dd7fc",
            "paper": "Campbell & Bozorgnia (2014) Earthquake Spectra 30(3) 1087-1115",
            "basis": "scalar transcription of the hazardlib implementation "
                     "(CampbellBozorgnia2014 base table, SJ=False, default CA "
                     "basin relation, Eq.39/35-37 width/hypo estimators with "
                     "zbot=20 km; independent of physics.js)"
        },
        "units": "lnA: pga/SA = ln(median in g), pgv = ln(median in cm/s) — hazardlib "
                 "native; sigma/tau/phi in ln units. physics.js pgaCb2014 converts "
                 "g -> gal with 980.665",
        "constants": dict(CONSTS, zbotKm=ZBOT_KM),
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
