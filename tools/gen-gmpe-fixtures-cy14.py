#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the frozen CY14 (Chiou & Youngs 2014, NGA-West2) GMPE fixtures.

The physics.js `cy2014Ln`/`cy2014SigmaLn` implementation is asserted in
tests/gmpe-cy14.test.js against reference values produced by this script. The
functional form below is a scalar transcription of the OFFICIAL
openquake.hazardlib implementation (gem/oq-engine,
openquake/hazardlib/gsim/chiou_youngs_2014.py) — NOT of physics.js — so the
two implementations are independent: the coefficient table is embedded
verbatim from the hazardlib source and the equation structure follows the
hazardlib functions get_magnitude_scaling / get_source_scaling_terms /
get_geometric_spreading / get_far_field_distance_scaling (region CAL) /
get_hanging_wall_term / get_linear_site_term / get_nonlinear_site_term /
get_tau / get_phi / get_stddevs one for one (names kept for auditability).

Provenance of the transcription source (keep in sync when regenerating):
  repository: gem/oq-engine (master via api.github.com contents, pinned IP)
  path:       openquake/hazardlib/gsim/chiou_youngs_2014.py
  sha256:     8ca60bceafe62b4c42d8339efd2c0bbe713c56dd72ccf59a4758d67606a2b4eb
  paper:      Chiou & Youngs (2014) Earthquake Spectra 30(3) 1117-1153,
              DOI 10.1193/072813EQS219M

Scope faithfully transcribed (class ChiouYoungs2014, region='CAL' defaults):
  * Median model for pga/pgv + all 24 SA rows (0.01-10 s); hazardlib PGA
    floor for SA at T <= 0.3 s applied per row.
  * use_hw=True (hanging-wall term active for rx >= 0); centered ztor via
    the paper's eqs. 4/5; alpha_nm = 1; directivity off (no rcdpp);
    Boore 2022 delta_c1/delta_g/delta_cm off; region CAL path (no gjpit/gwn).
  * Basin term: unmeasured z1pt0 -> z1 = z1mean(vs30) -> dz1pt0 = 0 ->
    EXACTLY 0 (global CAL/non-Japan relation).
  * Aleatory model: get_tau/get_phi/get_stddevs with vs30measured=False
    (estimated-Vs30 sig3 column); sigma_mu_epsilon = 0.
  * The JPN/ITA/WEN regional aliases are NOT exercised (base CAL only).

Output units follow hazardlib: ln(PGA)/ln(SA) in g, ln(PGV) in cm/s.
physics.js pgaCy2014 converts g -> gal with the standard gravity 980.665.

Usage: python tools/gen-gmpe-fixtures-cy14.py [--out=tools/data/gmpe-fixtures-cy14.json]
"""
import argparse
import datetime
import json
import math
import os

# --- hazardlib module constants (verbatim) ---------------------------------
CONSTANTS = {"c2": 1.06, "c4": -2.1, "c4a": -0.5, "crb": 50.0,
             "c8a": 0.2695, "c11": 0.0, "phi6": 300.0, "phi6jp": 800.0}
REF_VS = 1130.

# --- hazardlib COEFFS table (verbatim from the frozen source) --------------
COEFFS_TEXT = """IMT     c1      c1a     c1b     c1c     c1d     cn      cm    c2      c3    c4     c4a  crb   c5      chm     c6      c7      c7b     c8     c8a    c8b       c9     c9a    c9b     c11      c11b        cg1        cg2       cg3     phi1       phi2      phi3     phi4     phi5   phi6  gjpit  gwn      phi1jp  phi5jp   phi6jp     tau1     tau2    sig1    sig2    sig3    sig2jp
pga   -1.5065  0.165  -0.255  -0.165  0.255  16.0875  4.9993  1.06  1.9636  -2.1  -0.5  50  6.4551  3.0956  0.4908  0.0352   0.0462  0.     0.2695  0.4833  0.9228  0.1202  6.8607  0.      -0.4536    -0.007146  -0.006758  4.2542  -0.521   -0.1417   -0.00701   0.102151  0.     300  1.5817  0.7594  -0.6846  0.459    800.        0.4     0.26    0.4912  0.3762  0.8     0.4528
pgv    2.3549  0.165  -0.0626 -0.165  0.0626  3.3024  5.423   1.06  2.3152  -2.1  -0.5  50  5.8096  3.0514  0.4407  0.0324   0.0097  0.2154 0.2695  5.      0.3079  0.1     6.5     0       -0.3834    -0.001852  -0.007403  4.3439  -0.7936  -0.0699   -0.008444  5.41      0.0202 300. 2.2306  0.335   -0.7966  0.9488   800.        0.3894  0.2578  0.4785  0.3629  0.7504  0.3918
0.01  -1.5065  0.165  -0.255  -0.165  0.255  16.0875  4.9993  1.06  1.9636  -2.1  -0.5  50  6.4551  3.0956  0.4908  0.0352   0.0462  0.     0.2695  0.4833  0.9228  0.1202  6.8607  0.      -0.4536    -0.007146  -0.006758  4.2542  -0.521   -0.1417   -0.00701   0.102151  0.     300  1.5817  0.7594  -0.6846  0.459    800.        0.4     0.26    0.4912  0.3762  0.8     0.4528
0.02  -1.4798  0.165  -0.255  -0.165  0.255  15.7118  4.9993  1.06  1.9636  -2.1  -0.5  50  6.4551  3.0963  0.4925  0.0352   0.0472  0.     0.2695  1.2144  0.9296  0.1217  6.8697  0.      -0.4536    -0.007249  -0.006758  4.2386  -0.5055  -0.1364   -0.007279  0.10836   0.     300  1.574   0.7606  -0.6681  0.458    800.        0.4026  0.2637  0.4904  0.3762  0.8     0.4551
0.03  -1.2972  0.165  -0.255  -0.165  0.255  15.8819  4.9993  1.06  1.9636  -2.1  -0.5  50  6.4551  3.0974  0.4992  0.0352   0.0533  0.     0.2695  1.6421  0.9396  0.1194  6.9113  0.      -0.4536    -0.007869  -0.006758  4.2519  -0.4368  -0.1403   -0.007354  0.119888  0.     300  1.5544  0.7642  -0.6314  0.462    800.        0.4063  0.2689  0.4988  0.3849  0.8     0.4571
0.04  -1.1007  0.165  -0.255  -0.165  0.255  16.4556  4.9993  1.06  1.9636  -2.1  -0.5  50  6.4551  3.0988  0.5037  0.0352   0.0596  0.     0.2695  1.9456  0.9661  0.1166  7.0271  0.      -0.4536    -0.008316  -0.006758  4.296   -0.3752  -0.1591   -0.006977  0.133641  0.     300  1.5502  0.7676  -0.5855  0.453    800.        0.4095  0.2736  0.5049  0.391   0.8     0.4642
0.05  -0.9292  0.165  -0.255  -0.165  0.255  17.6453  4.9993  1.06  1.9636  -2.1  -0.5  50  6.4551  3.1011  0.5048  0.0352   0.0639  0.     0.2695  2.181   0.9794  0.1176  7.0959  0.      -0.4536    -0.008743  -0.006758  4.3578  -0.3469  -0.1862   -0.006467  0.148927  0.     300  1.5391  0.7739  -0.5457  0.436    800.        0.4124  0.2777  0.5096  0.3957  0.8     0.4716
0.075 -0.658   0.165  -0.254  -0.165  0.254  20.1772  5.0031  1.06  1.9636  -2.1  -0.5  50  6.4551  3.1094  0.5048  0.0352   0.063   0.     0.2695  2.6087  1.026   0.1171  7.3298  0.      -0.4536    -0.009537  -0.00619   4.5455  -0.3747  -0.2538   -0.005734  0.190596  0.     300  1.4804  0.7956  -0.4685  0.383    800.        0.4179  0.2855  0.5179  0.4043  0.8     0.5022
0.1   -0.5613  0.165  -0.253  -0.165  0.253  19.9992  5.0172  1.06  1.9636  -2.1  -0.5  50  6.8305  3.2381  0.5048  0.0352   0.0532  0.     0.2695  2.9122  1.0177  0.1146  7.2588  0.      -0.4536    -0.00983   -0.005332  4.7603  -0.444   -0.2943   -0.005604  0.230662  0.     300  1.4094  0.7932  -0.4985  0.375    800.        0.4219  0.2913  0.5236  0.4104  0.8     0.523
0.12  -0.5342  0.165  -0.252  -0.165  0.252  18.7106  5.0315  1.06  1.9795  -2.1  -0.5  50  7.1333  3.3407  0.5048  0.0352   0.0452  0.     0.2695  3.1045  1.0008  0.1128  7.2372  0.      -0.4536    -0.009913  -0.004732  4.8963  -0.4895  -0.3077   -0.005696  0.253169  0.     300  1.3682  0.7768  -0.5603  0.377    800.        0.4244  0.2949  0.527   0.4143  0.8     0.5278
0.15  -0.5462  0.165  -0.25   -0.165  0.25   16.6246  5.0547  1.06  2.0362  -2.1  -0.5  50  7.3621  3.43    0.5045  0.0352   0.0345  0.     0.2695  3.3399  0.9801  0.1106  7.2109  0.      -0.4536    -0.009896  -0.003806  5.0644  -0.5477  -0.3113   -0.005845  0.266468  0.     300  1.3241  0.7437  -0.6451  0.379    800.        0.4275  0.2993  0.5308  0.4191  0.8     0.5304
0.17  -0.5858  0.165  -0.248  -0.165  0.248  15.3709  5.0704  1.06  2.0823  -2.1  -0.5  50  7.4365  3.4688  0.5036  0.0352   0.0283  0.     0.2695  3.4719  0.9652  0.115   7.2491  0.      -0.4536    -0.009787  -0.00328   5.1371  -0.5922  -0.3062   -0.005959  0.26506   0.     300  1.3071  0.7219  -0.6981  0.38     800.        0.4292  0.3017  0.5328  0.4217  0.8     0.531
0.2   -0.6798  0.165  -0.2449 -0.165  0.2449 13.7012  5.0939  1.06  2.1521  -2.1  -0.5  50  7.4972  3.5146  0.5016  0.0352   0.0202  0.     0.2695  3.6434  0.9459  0.1208  7.2988  0.      -0.444     -0.009505  -0.00269   5.188   -0.6693  -0.2927   -0.006141  0.255253  0.     300  1.2931  0.6922  -0.7653  0.384    800.        0.4313  0.3047  0.5351  0.4252  0.8     0.5312
0.25  -0.8663  0.165  -0.2382 -0.165  0.2382 11.2667  5.1315  1.06  2.2574  -2.1  -0.5  50  7.5416  3.5746  0.4971  0.0352   0.009   0.     0.2695  3.8787  0.9196  0.1208  7.3691  0.      -0.3539    -0.008918  -0.002128  5.2164  -0.7766  -0.2662   -0.006439  0.231541  0.     300  1.315   0.6579  -0.8469  0.393    800.        0.4341  0.3087  0.5377  0.4299  0.7999  0.5309
0.3   -1.0514  0.165  -0.2313 -0.165  0.2313  9.1908  5.167   1.06  2.344   -2.1  -0.5  50  7.56    3.6232  0.4919  0.0352  -0.0004  0.     0.2695  4.0711  0.8829  0.1175  6.8789  0.      -0.2688    -0.008251  -0.001812  5.1954  -0.8501  -0.2405   -0.006704  0.207277  0.001  300  1.3514  0.6362  -0.8999  0.408    800.        0.4363  0.3119  0.5395  0.4338  0.7997  0.5307
0.4   -1.3794  0.165  -0.2146 -0.165  0.2146  6.5459  5.2317  1.06  2.4709  -2.1  -0.5  50  7.5735  3.6945  0.4807  0.0352  -0.0155  0.     0.2695  4.3745  0.8302  0.106   6.5334  0.      -0.1793    -0.007267  -0.001274  5.0899  -0.9431  -0.1975   -0.007125  0.165464  0.004  300  1.4051  0.6049  -0.9618  0.462    800.        0.4396  0.3165  0.5422  0.4399  0.7988  0.531
0.5   -1.6508  0.165  -0.1972 -0.165  0.1972  5.2305  5.2893  1.06  2.5567  -2.1  -0.5  50  7.5778  3.7401  0.4707  0.0352  -0.0278  0.0991 0.2695  4.6099  0.7884  0.1061  6.526   0.      -0.1428    -0.006492  -0.001074  4.7854  -1.0044  -0.1633   -0.007435  0.133828  0.01   300  1.4402  0.5507  -0.9945  0.524    800.        0.4419  0.3199  0.5433  0.4446  0.7966  0.5313
0.75  -2.1511  0.165  -0.162  -0.165  0.162   3.7896  5.4109  1.06  2.6812  -2.1  -0.5  50  7.5808  3.7941  0.4575  0.0352  -0.0477  0.1982 0.2695  5.0376  0.6754  0.1     6.5     0.      -0.1138    -0.005147  -0.001115  4.3304  -1.0602  -0.1028   -0.00812   0.085153  0.034  300  1.528   0.3582  -1.0225  0.658    800.        0.4459  0.3255  0.5294  0.4533  0.7792  0.5309
1     -2.5365  0.165  -0.14   -0.165  0.14    3.3024  5.5106  1.06  2.7474  -2.1  -0.5  50  7.5814  3.8144  0.4522  0.0352  -0.0559  0.2154 0.2695  5.3411  0.6196  0.1     6.5     0.      -0.1062    -0.004277  -0.001197  4.1667  -1.0941  -0.0699   -0.008444  0.058595  0.067  300  1.6523  0.2003  -1.0002  0.78     800.        0.4484  0.3291  0.5105  0.4594  0.7504  0.5302
1.5   -3.0686  0.165  -0.1184 -0.165  0.1184  2.8498  5.6705  1.06  2.8161  -2.1  -0.5  50  7.5817  3.8284  0.4501  0.0352  -0.063   0.2154 0.2695  5.7688  0.5101  0.1     6.5     0.      -0.102     -0.002979  -0.001675  4.0029  -1.1142  -0.0425   -0.007707  0.031787  0.143  300  1.8872  0.0356  -0.9245  0.96     800.        0.4515  0.3335  0.4783  0.468   0.7136  0.5276
2     -3.4148  0.1645 -0.11   -0.1645 0.11    2.5417  5.7981  1.06  2.8514  -2.1  -0.5  50  7.5818  3.833   0.45    0.0352  -0.0665  0.2154 0.2695  6.0723  0.3917  0.1     6.5     0.      -0.1009    -0.002301  -0.002349  3.8949  -1.1154  -0.0302   -0.004792  0.019716  0.203  300  2.1348  0.      -0.8626  1.11     800.        0.4534  0.3363  0.4681  0.4681  0.7035  0.5167
3     -3.9013  0.1168 -0.104  -0.1168 0.104   2.1488  5.9983  1.06  2.8875  -2.1  -0.5  50  7.5818  3.8361  0.45    0.016   -0.0516  0.2154 0.2695  6.5     0.1244  0.1     6.5     0.      -0.1003    -0.001344  -0.003306  3.7928  -1.1081  -0.0129   -0.001828  0.009643  0.277  300  3.5752  0.      -0.7882  1.291    800.        0.4558  0.3398  0.4617  0.4617  0.7006  0.4917
4     -4.2466  0.0732 -0.102  -0.0732 0.102  1.8957   6.1552  1.06  2.9058  -2.1  -0.5  50  7.5818  3.8369  0.45    0.0062  -0.0448  0.2154 0.2695  6.8035  0.0086  0.1     6.5     0.      -0.1001    -0.001084  -0.003566  3.7443  -1.0603  -0.0016   -0.001523  0.005379  0.309  300  3.8646  0.      -0.7195  1.387    800.        0.4574  0.3419  0.4571  0.4571  0.7001  0.4682
5     -4.5143  0.0484 -0.101  -0.0484 0.101  1.7228   6.2856  1.06  2.9169  -2.1  -0.5  50  7.5818  3.8376  0.45    0.0029  -0.0424  0.2154 0.2695  7.0389  0.      0.1     6.5     0.      -0.1001    -0.00101   -0.00364   3.709   -0.9872   0.       -0.00144   0.003223  0.321  300  3.7292  0.      -0.656   1.433    800.        0.4584  0.3435  0.4535  0.4535  0.7     0.4517
7.5   -5.0009  0.022  -0.101  -0.022  0.101  1.5737   6.5428  1.06  2.932   -2.1  -0.5  50  7.5818  3.838   0.45    0.0007  -0.0348  0.2154 0.2695  7.4666  0.      0.1     6.5     0.      -0.1       -0.000964  -0.003686  3.6632  -0.8274   0.       -0.001369  0.001134  0.329  300  2.3763  0.      -0.5202  1.46     800.        0.4601  0.3459  0.4471  0.4471  0.7     0.4167
10    -5.3461  0.0124 -0.1    -0.0124 0.1    1.5265   6.7415  1.06  2.9396  -2.1  -0.5  50  7.5818  3.838   0.45    0.0003  -0.0253  0.2154 0.2695  7.77    0.      0.1     6.5     0.      -0.1       -0.00095   -0.0037    3.623   -0.7053   0.       -0.001361  0.000515  0.33   300  1.7679  0.      -0.4068  1.464    800.        0.4612  0.3474  0.4426  0.4426  0.7     0.3755"""


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

# --- scalar functional form (hazardlib function names kept) -----------------

def _get_centered_ztor(mag, rake, ztor):
    """hazardlib _get_centered_ztor (scalar)."""
    if 30. <= rake <= 150.:
        mean = max(2.704 - 1.226 * max(mag - 5.849, 0.0), 0.0) ** 2
    else:
        mean = max(2.673 - 1.136 * max(mag - 4.970, 0.0), 0.0) ** 2
    return ztor - mean


def get_magnitude_scaling(C, mag):
    """hazardlib get_magnitude_scaling with delta_cm = 0."""
    f_m = math.log(1.0 + math.exp(C["cn"] * (C["cm"] - mag)))
    return (CONSTANTS["c2"] * (mag - 6.0)
            + ((CONSTANTS["c2"] - C["c3"]) / C["cn"]) * f_m)


def get_source_scaling_terms(C, mag, rake, dip, delta_ztor):
    """hazardlib get_source_scaling_terms with alpha_nm = 1."""
    coshm = math.cosh(2.0 * max(mag - 4.5, 0.0))
    f_src = 0.0
    if 30. <= rake <= 150.:
        f_src += C["c1a"] + C["c1c"] / coshm
    if -120. <= rake <= -60.:
        f_src += (C["c1b"] + C["c1d"] / coshm) * 1.0
    f_src += (C["c7"] + C["c7b"] / coshm) * delta_ztor
    f_src += (CONSTANTS["c11"] + C["c11b"] / coshm) * math.cos(math.radians(dip)) ** 2
    return f_src


def get_geometric_spreading(C, mag, rrup):
    return CONSTANTS["c4"] * math.log(
        rrup + C["c5"] * math.cosh(C["c6"] * max(mag - C["chm"], 0.0)))


def get_far_field_distance_scaling(C, mag, rrup):
    """region CAL branch, delta_g = 0."""
    f_r = (CONSTANTS["c4a"] - CONSTANTS["c4"]) * math.log(
        math.sqrt(rrup ** 2 + CONSTANTS["crb"] ** 2))
    gamma = C["cg1"] + C["cg2"] / math.cosh(max(mag - C["cg3"], 0.0))
    return f_r + gamma * rrup


def get_hanging_wall_term(C, mag, rrup, rjb, rx, ztor, dip):
    """use_hw = True; rx < 0 (footwall) contributes 0."""
    if rx < 0.0:
        return 0.0
    fdist = 1.0 - math.sqrt(rjb ** 2 + ztor ** 2) / (rrup + 1.0)
    fdist *= C["c9a"] + (1.0 - C["c9a"]) * math.tanh(rx / C["c9b"])
    return C["c9"] * math.cos(math.radians(dip)) * fdist


def get_linear_site_term(C, vs30):
    return C["phi1"] * min(math.log(vs30 / REF_VS), 0.0)


def get_nonlinear_site_term(C, vs30, y_ref):
    vs = min(vs30, REF_VS)
    f_nl_scaling = C["phi2"] * (math.exp(C["phi3"] * (vs - 360.))
                                - math.exp(C["phi3"] * (REF_VS - 360.)))
    f_nl = math.log((y_ref + C["phi4"]) / C["phi4"]) * f_nl_scaling
    return f_nl, f_nl_scaling


def get_tau(C, mag):
    mag_test = min(max(mag - 5.0, 0.0), 1.5)
    return C["tau1"] + (C["tau2"] - C["tau1"]) / 1.5 * mag_test


def get_phi(C, mag, nl0):
    """vs30measured = False -> sig3 column."""
    phi = C["sig3"]
    phi = math.sqrt(phi + (1.0 + nl0) ** 2)
    mdep = C["sig1"] + (C["sig2"] - C["sig1"]) * min(max(mag - 5., 0.), 1.5) / 1.5
    return mdep * phi


def get_stddevs(C, mag, y_ref, f_nl_scaling):
    nl0 = f_nl_scaling * (y_ref / (y_ref + C["phi4"]))
    tau = get_tau(C, mag)
    phi_nl0 = get_phi(C, mag, nl0)
    sigma = math.sqrt(((1.0 + nl0) ** 2) * tau ** 2 + phi_nl0 ** 2)
    return sigma, abs((1.0 + nl0) * tau), phi_nl0


def _ln_y_ref(C, mag, rrup, rjb, rx, ztor, dip, rake):
    dz = _get_centered_ztor(mag, rake, ztor)
    return (C["c1"]
            + get_magnitude_scaling(C, mag)
            + get_source_scaling_terms(C, mag, rake, dip, dz)
            + get_geometric_spreading(C, mag, rrup)
            + get_far_field_distance_scaling(C, mag, rrup)
            + get_hanging_wall_term(C, mag, rrup, rjb, rx, ztor, dip))


def _mean_row(C, CP, period, mag, g):
    ln_y_ref = _ln_y_ref(C, mag, g["rrup"], g["rjb"], g["rx"], g["ztor"],
                         g["dip"], g["rake"])
    y_ref = math.exp(ln_y_ref)
    f_lin = get_linear_site_term(C, g["vs30"])
    f_nl, f_nl_scaling = get_nonlinear_site_term(C, g["vs30"], y_ref)
    mean = ln_y_ref + f_lin + f_nl  # basin = 0 (unmeasured z1pt0, CAL)
    if period is not None and period <= 0.3:
        # hazardlib compute(): SA at T <= 0.3 s raised to the PGA mean when
        # it falls below it (paper p.1144)
        ln_y_ref_p = _ln_y_ref(CP, mag, g["rrup"], g["rjb"], g["rx"], g["ztor"],
                               g["dip"], g["rake"])
        y_ref_p = math.exp(ln_y_ref_p)
        f_lin_p = get_linear_site_term(CP, g["vs30"])
        f_nl_p, _ = get_nonlinear_site_term(CP, g["vs30"], y_ref_p)
        pga_mean = ln_y_ref_p + f_lin_p + f_nl_p
        if mean < pga_mean:
            mean = pga_mean
    return mean, y_ref, f_nl_scaling


SA_KEYS = ["0.01", "0.02", "0.03", "0.04", "0.05", "0.075", "0.1", "0.12",
           "0.15", "0.17", "0.2", "0.25", "0.3", "0.4", "0.5", "0.75", "1",
           "1.5", "2", "3", "4", "5", "7.5", "10"]


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


def cy14_ln(imt, mag, geom):
    """Median ln ground motion. imt: 'pga' | 'pgv' | SA period string/number."""
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


def _sigma_row(C, mag, geom):
    ln_y_ref = _ln_y_ref(C, mag, geom["rrup"], geom["rjb"], geom["rx"],
                         geom["ztor"], geom["dip"], geom["rake"])
    y_ref = math.exp(ln_y_ref)
    _, f_nl_scaling = get_nonlinear_site_term(C, geom["vs30"], y_ref)
    return get_stddevs(C, mag, y_ref, f_nl_scaling)


def cy14_sigma(imt, mag, geom):
    """(sigma, tau, phi) in ln units."""
    if imt in ("pga", "pgv"):
        return _sigma_row(ROWS[imt], mag, geom)
    T = float(imt)
    key = _sa_key(T)
    if key:
        return _sigma_row(ROWS[key], mag, geom)
    br = _sa_bracket(T)
    if br is None:
        return None
    lo = _sigma_row(ROWS[br[0]], mag, geom)
    hi = _sigma_row(ROWS[br[1]], mag, geom)
    w = (math.log(T) - math.log(br[2])) / (math.log(br[3]) - math.log(br[2]))
    return tuple(a + w * (b - a) for a, b in zip(lo, hi))


# --- fixture grid ------------------------------------------------------------
# Point-source convention (documented on the physics.js model block): the
# caller distance reads as Rjb, Rrup = sqrt(Rjb^2 + ztor^2), Rx = Rjb,
# Ry0 = 0, dip from the grid, ztor = source depth.
def point_geom(rjb, ztor, vs30, dip, rake):
    rrup = math.sqrt(rjb * rjb + ztor * ztor)
    return {"rrup": rrup, "rjb": rjb, "rx": rjb, "ry0": 0.0,
            "ztor": ztor, "dip": dip, "rake": rake, "vs30": vs30,
            "widthKm": None, "hypoDepthKm": None}


M_GRID = [5.0, 5.5, 6.5, 7.0, 7.5, 8.0]
RJB_GRID = [0.1, 1, 10, 30, 80, 100, 300]
ZTOR_GRID = [0.5, 5, 12, 20]
V_GRID = [180, 400, 760, 1130, 1500]
DIP_GRID = [30, 60, 90]
RAKE_GRID = [-90, 0, 90]
# SA reduced grid
M_SA = [5.5, 6.5, 7.5]
RJB_SA = [1, 30, 100]
ZTOR_SA = [2, 12]
V_SA = [270, 760, 1500]
RAKE_SA = [0, 90]
# rake boundary pins (CY14 style windows are INCLUSIVE: 30<=rake<=150,
# -120<=rake<=-60; CB14/ASK14 use strict >/< — pinned here for all models)
RAKE_BND = [30, 150, -30, -150]
# hanging-wall free-geometry grid: explicit width, rx sweeps across the
# width-scaled tapers
HW_WIDTH = [8, 20]
HW_RX = [0, 2, 6, 15, 40]
HW_ZTOR = [2, 8]
HW_M = [6.0, 7.0]
HW_DIP = [45, 70]


def generate():
    points = []

    def emit(imt, mag, geom, grid):
        lnA = cy14_ln(imt, mag, geom)
        sig = cy14_sigma(imt, mag, geom)
        points.append([imt, mag, geom["rrup"], geom["rjb"], geom["rx"],
                       geom["ry0"], geom["ztor"], geom["dip"], geom["rake"],
                       geom["vs30"], geom["widthKm"], geom["hypoDepthKm"],
                       grid, lnA, sig[0], sig[1], sig[2]])

    for mag in M_GRID:
        for rjb in RJB_GRID:
            for ztor in ZTOR_GRID:
                for vs30 in V_GRID:
                    for dip in DIP_GRID:
                        for rake in RAKE_GRID:
                            g = point_geom(rjb, ztor, vs30, dip, rake)
                            for imt in ("pga", "pgv"):
                                emit(imt, mag, g, "core")
    for imt in SA_KEYS:
        T = float(imt)
        for mag in M_SA:
            for rjb in RJB_SA:
                for ztor in ZTOR_SA:
                    for vs30 in V_SA:
                        for rake in RAKE_SA:
                            g = point_geom(rjb, ztor, vs30, 60, rake)
                            emit(imt, mag, g, "sa")
    for rake in RAKE_BND:
        for mag in (6.0, 7.0):
            for rjb in (10, 30):
                for vs30 in (270, 760):
                    for dip in (60, 90):
                        g = point_geom(rjb, 5, vs30, dip, rake)
                        emit("pga", mag, g, "rakeBnd")
    for w in HW_WIDTH:
        for rx in HW_RX:
            for ztor in HW_ZTOR:
                for mag in HW_M:
                    for dip in HW_DIP:
                        rjb = rx
                        rrup = math.sqrt(rjb * rjb + ztor * ztor)
                        g = {"rrup": rrup, "rjb": rjb, "rx": rx, "ry0": 0.0,
                             "ztor": ztor, "dip": dip, "rake": 90, "vs30": 760,
                             "widthKm": w, "hypoDepthKm": None}
                        emit("pga", mag, g, "hw")
    return points


FIELDS = ["imt", "mag", "rrup", "rjb", "rx", "ry0", "ztor", "dip", "rake",
          "vs30", "widthKm", "hypoDepthKm", "grid", "lnA", "sigma", "tau", "phi"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join("tools", "data", "gmpe-fixtures-cy14.json"))
    args = ap.parse_args()
    points = generate()
    doc = {
        "schema": "quake-sim-gmpe-fixtures-cy14-v1",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00"),
        "source": {
            "repository": "gem/oq-engine (master via api.github.com contents, pinned IP 140.82.112.5)",
            "path": "openquake/hazardlib/gsim/chiou_youngs_2014.py",
            "sha256": "8ca60bceafe62b4c42d8339efd2c0bbe713c56dd72ccf59a4758d67606a2b4eb",
            "paper": "Chiou & Youngs (2014) Earthquake Spectra 30(3) 1117-1153, DOI 10.1193/072813EQS219M",
            "basis": "scalar transcription of the hazardlib implementation "
                     "(ChiouYoungs2014 region='CAL', use_hw=True, unmeasured "
                     "z1pt0 basin default = 0, vs30measured=False, no "
                     "directivity/Boore-2022/epistemic adjustments; "
                     "independent of physics.js)"
        },
        "units": "lnA: pga/SA = ln(median in g), pgv = ln(median in cm/s) — hazardlib "
                 "native; sigma/tau/phi in ln units. physics.js pgaCy2014 converts "
                 "g -> gal with 980.665",
        "constants": dict(CONSTANTS, refVs=REF_VS),
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
