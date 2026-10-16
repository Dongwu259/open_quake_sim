#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the frozen NGA-Sub (Parker et al. 2020/2022) GMPE fixtures.

v6.8 NGA-Sub batch (2026-10-06). The physics.js `parker2022Ln` implementation
is asserted in tests/gmpe-ngasub.test.js against reference values produced by
this script. The functional form below is a scalar transcription of the
OFFICIAL openquake.hazardlib implementation (gem/oq-engine,
openquake/hazardlib/gsim/parker_2020.py) — NOT of physics.js — so the two
implementations are independent: the coefficient table is embedded verbatim
from the hazardlib source and the equation structure follows the hazardlib
functions _c0 / _magnitude_scaling / _path_term (+_path_term_h) /
_depth_scaling / _linear_amplification / _non_linear_term / get_stddevs one
for one (function names kept aligned for auditability).

Provenance of the transcription source (keep in sync when regenerating):
  repository: gem/oq-engine (master via jsDelivr)
  path:       openquake/hazardlib/gsim/parker_2020.py
  sha256:     32df333b97242449ad2de22f93ffd7d0bf5335b5c56a69c05e3142dcf568f322
  paper:      Parker, Stewart, Boore, Atkinson & Hassani (2020) PEER 2020/03;
              Parker et al. (2022) Earthquake Spectra 38(2) 845-870

Scope faithfully transcribed:
  * Median model for interface + intraslab, all 26 IMT rows (pgv, pga,
    SA 0.01..10.0 s), regional c0 / a0 / s1-s2 / m_b factors.
  * Ergodic aleatory variability (Tau, phi21/phi22/phi2V total-phi model).
  * Basin term OFF: no region pack carries z2.5 site data, so
    _get_basin_term returns 0 (the non-B class behaviour). J_e*/C_e*/del_*
    columns are carried in the table for completeness, unused.
  * Epistemic sigma_mu (EPI_ADJS) and the Alaska-2023 bias adjustment are
    NOT applied (hazardlib defaults sigma_mu_epsilon=0, ak23_bias_adj=False).
  * The non-ergodic sigma columns (VM/phi2S2S/a1/phi2SS/a2) are carried in
    the table but unused (get_stddevs is the base-class path).

Region/saturation configs exercised (production routing of the v6.8 batch):
  global   : region=None, sat=None       -> New Zealand / Italy / fallback
  cascadia : region='Cascadia', sat=None -> California (sat defaults to region)
  sa_s     : region='SA', sat='SA_S'     -> Chile. The report's split is
             tectonic (Caribbean vs Nazca): "the southern part of South
             America (namely, Chile)" — PEER 2020/03 §4.3.4 — so the whole
             bundled Chile strip (19-46S) is SA_S.
  tw_e     : region='TW', sat='TW_E'     -> Taiwan (TW_E/TW_W columns are
             identical in the frozen table; the report notes the northeast
             constant was applied to the full region).

Output units follow hazardlib: ln(PGA)/ln(SA) in g, ln(PGV) in cm/s.
physics.js pgaParker2022 converts g -> gal with the standard gravity 980.665.

Usage: python tools/gen-gmpe-fixtures-ngasub.py [--out=tools/data/gmpe-fixtures-ngasub.json]
"""
import argparse
import datetime
import json
import math
import os

# --- hazardlib module constants (verbatim) ---------------------------------
CONSTANTS = {"b4": 0.1, "f3": 0.05, "Vb": 200,
             "vref_fnl": 760, "V1": 270, "vref": 760}

MB_INTERFACE = {"Aleutian": 8, "AK": 8.6, "Cascadia": 7.7,
                "CAM_S": 7.4, "CAM_N": 7.4, "JP_Pac": 8.5, "JP_Phi": 7.7,
                "SA_N": 8.5, "SA_S": 8.6, "TW_W": 7.1, "TW_E": 7.1,
                "default": 7.9}
MB_SLAB = {"Aleutian": 7.98, "AK": 7.2, "Cascadia": 7.2,
           "CAM_S": 7.6, "CAM_N": 7.4, "JP_Pac": 7.65, "JP_Phi": 7.55,
           "SA_N": 7.3, "SA_S": 7.25, "TW_W": 7.7, "TW_E": 7.7,
           "default": 7.6}

# --- hazardlib COEFFS table (verbatim from the frozen source) --------------
COEFFS_TEXT = """    IMT    c0    AK_c0        Aleutian_c0  Cascadia_c0 CAM_N_c0     CAM_S_c0    JP_Pac_c0    JP_Phi_c0    SA_N_c0     SA_S_c0      TW_E_c0      TW_W_c0     c0slab AK_c0slab Aleutian_c0slab Cascadia_c0slab CAM_c0slab JP_c0slab SA_N_c0slab SA_S_c0slab TW_c0slab  c1     c1slab b4   a0        AK_a0     CAM_a0    JP_a0     SA_a0     TW_a0     a0slab    AK_a0slab Cascadia_a0slab CAM_a0slab JP_a0slab SA_a0slab TW_a0slab c4     c5    c6    c4slab c5slab c6slab d      m      db   V2  JP_s1  TW_s1  s2     AK_s2  Cascadia_s2 JP_s2  SA_s2  TW_s2  f4       f4slab   f5       J_e1   J_e2   J_e3  C_e1   C_e2   C_e3   del_None del_Seattle Tau   phi21 phi22  phi2V  VM phi2S2S,0 a1    phi2SS,1 phi2SS,2 a2
    pgv    8.097 9.283796298  8.374796298  7.728       7.046899908  7.046899908 8.772125851  7.579125851  8.528671414 8.679671414  7.559846279  7.559846279 13.194 12.79     13.6            12.874          12.81      13.248    12.754      12.927      13.516    -1.661 -2.422  0.1 -0.00395  -0.00404  -0.00153  -0.00239  -0.000311 -0.00514  -0.0019   -0.00238  -0.00109        -0.00192   -0.00215  -0.00192   -0.00366  1.336 -0.039 1.844 1.84  -0.05   0.8    0.2693 0.0252 67  850 -0.738 -0.454 -0.601 -1.031 -0.671      -0.738 -0.681 -0.59  -0.31763 -0.31763 -0.0052  -0.137  0.137  0.091 0      0.115  0.068 -0.115    0           0.477 0.348 0.288 -0.179 423 0.142     0.047 0.153    0.166    0.011
    pga    4.082 4.458796298  3.652796298  3.856       2.875899908  2.875899908 5.373125851  4.309125851  5.064671414 5.198671414  3.032846279  3.032846279  9.907  9.404     9.912           9.6             9.58      10.145     9.254       9.991      10.071    -1.662 -2.543  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00227  -0.00354        -0.00238   -0.00335  -0.00238   -0.00362  1.246 -0.021 1.128 1.84  -0.05   0.4    0.3004 0.0314 67 1350 -0.586 -0.44  -0.498 -0.785 -0.572      -0.586 -0.333 -0.44  -0.44169 -0.44169 -0.0052   0      0      1     0      0      1      0        0           0.48  0.396 0.565 -0.18  423 0.221     0.093 0.149    0.327    0.068
    0.01   3.714 4.094796298  3.288796298  3.488       2.564899908  2.564899908 5.022125851  3.901125851  4.673671414 4.807671414  2.636846279  2.636846279  9.962  9.451     9.954           9.802           9.612     10.162     9.293       9.994      10.174    -1.587 -2.554  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.246 -0.021 1.128 1.84  -0.05   0.4    0.2839 0.0296 67 1300 -0.604 -0.44  -0.498 -0.803 -0.571      -0.604 -0.333 -0.44  -0.4859  -0.4859  -0.0052   0      0      1     0      0      1      0        0           0.476 0.397 0.56  -0.18  423 0.223     0.098 0.148    0.294    0.071
    0.02   3.762 4.132796298  3.338796298  3.536       2.636899908  2.636899908 5.066125851  3.935125851  4.694671414 4.827671414  2.698846279  2.698846279 10.099  9.587    10.086           9.933           9.771     10.306     9.403      10.152      10.273    -1.593 -2.566  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.227 -0.021 1.128 1.884 -0.05   0.415  0.2854 0.0298 67 1225 -0.593 -0.458 -0.478 -0.785 -0.575      -0.593 -0.345 -0.458 -0.4859  -0.4859  -0.00518  0      0      1     0      0      1      0        0           0.482 0.401 0.563 -0.181 423 0.227     0.105 0.149    0.294    0.073
    0.025  3.859 4.246796298  3.392796298  3.633       2.731899908  2.731899908 5.140125851  4.094125851  4.779671414 4.911671414  2.800846279  2.800846279 10.181  9.667    10.172          10.009           9.85      10.387     9.481      10.292      10.329    -1.607 -2.578  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.221 -0.021 1.128 1.884 -0.05   0.43   0.2891 0.0302 67 1200 -0.569 -0.454 -0.464 -0.745 -0.573      -0.579 -0.362 -0.459 -0.4859  -0.4859  -0.00515  0      0      1     0      0      1      0        0           0.49  0.405 0.575 -0.183 423 0.231     0.12  0.15     0.31     0.076
    0.03   4.014 4.386796298  3.535796298  3.788       2.890899908  2.890899908 5.317125851  4.278125851  4.935671414 5.066671414  2.926846279  2.926846279 10.311  9.808    10.302          10.133           9.993     10.498     9.592      10.459      10.451    -1.63  -2.594  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.215 -0.021 1.128 1.884 -0.05   0.445  0.2932 0.0306 67 1200 -0.539 -0.455 -0.446 -0.69  -0.565      -0.561 -0.38  -0.464 -0.4908  -0.4908  -0.00511  0      0      1     0      0      1      0        0           0.5   0.413 0.589 -0.188 423 0.239     0.145 0.153    0.313    0.077
    0.04   4.223 4.553796298  3.747796298  3.997       3.075899908  3.075899908 5.564125851  4.531125851  5.182671414 5.312671414  3.069846279  3.069846279 10.588 10.086    10.602          10.404          10.317     10.744     9.834      10.818      10.678    -1.657 -2.629  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.207 -0.021 1.128 1.884 -0.05   0.46   0.3004 0.0313 67 1200 -0.468 -0.453 -0.431 -0.636 -0.546      -0.508 -0.403 -0.466 -0.49569 -0.49569 -0.00505  0      0      1     0      0      1      0        0           0.515 0.439 0.616 -0.205 423 0.261     0.177 0.159    0.322    0.08
    0.05   4.456 4.745796298  3.959796298  4.23        3.287899908  3.287899908 5.843125851  4.816125851  5.457671414 5.586671414  3.236846279  3.236846279 10.824 10.379    10.862          10.634          10.563     10.981    10.027      11.102      10.86     -1.687 -2.649  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.201 -0.021 1.128 1.884 -0.05   0.475  0.3048 0.0316 67 1225 -0.403 -0.452 -0.42  -0.594 -0.519      -0.461 -0.427 -0.468 -0.49823 -0.49823 -0.00497  0      0      1     0.1   -0.1   -0.063 -0.05     0           0.528 0.473 0.653 -0.23  423 0.285     0.2   0.167    0.33     0.077
    0.075  4.742 4.972796298  4.231796298  4.516       3.560899908  3.560899908 6.146125851  5.126125851  5.788671414 5.917671414  3.446846279  3.446846279 11.084 10.65     11.184          10.888          10.785     11.25     10.265      11.424      11.093    -1.715 -2.65   0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.19  -0.021 1.128 1.884 -0.05   0.49   0.2992 0.0321 67 1350 -0.325 -0.456 -0.442 -0.586 -0.497      -0.452 -0.458 -0.473 -0.49724 -0.49724 -0.00489  0.05  -0.043 -0.025 0.3   -0.34  -0.2   -0.075    0.078       0.53  0.529 0.722 -0.262 423 0.339     0.205 0.184    0.299    0.063
    0.1    4.952 5.160796298  4.471796298  4.726       3.788899908  3.788899908 6.346125851  5.333125851  5.998671414 6.126671414  3.643846279  3.643846279 11.232 10.816    11.304          11.03           10.841     11.466    10.467      11.49       11.283    -1.737 -2.647  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.182 -0.021 1.128 1.884 -0.05   0.505  0.2854 0.032  67 1450 -0.264 -0.468 -0.485 -0.629 -0.486      -0.498 -0.49  -0.482 -0.49471 -0.49471 -0.00478  0.1   -0.085 -0.05  0.333 -0.377 -0.222 -0.081    0.075       0.524 0.517 0.712 -0.239 423 0.347     0.185 0.176    0.31     0.061
    0.15   5.08  5.285796298  4.665796298  4.848       3.945899908  3.945899908 6.425125851  5.420125851  6.103671414 6.230671414  3.798846279  3.798846279 11.311 10.883    11.402          11.103          10.809     11.619    10.566      11.32       11.503    -1.745 -2.634  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.171 -0.021 1.162 1.884 -0.06   0.52   0.2814 0.0325 67 1500 -0.25  -0.484 -0.546 -0.729 -0.499      -0.568 -0.536 -0.499 -0.48583 -0.48583 -0.0046   0.164 -0.139 -0.082 0.29  -0.29  -0.193 -0.091    0.064       0.51  0.457 0.644 -0.185 423 0.313     0.123 0.164    0.307    0.076
    0.2    5.035 5.277796298  4.661796298  4.798       3.943899908  3.943899908 6.288125851  5.289125851  6.013671414 6.140671414  3.827846279  3.827846279 11.055 10.633    11.183          10.841          10.519     11.351    10.33       10.927      11.32     -1.732 -2.583  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.163 -0.021 1.187 1.884 -0.068  0.535  0.291  0.0306 67 1425 -0.288 -0.498 -0.612 -0.867 -0.533      -0.667 -0.584 -0.522 -0.47383 -0.47383 -0.00434  0.164 -0.139 -0.082 0.177 -0.192 -0.148 -0.092    0.075       0.501 0.432 0.64  -0.138 423 0.277     0.11  0.163    0.301    0.07
    0.25   4.859 5.154796298  4.503796298  4.618       3.800899908  3.800899908 5.972125851  4.979125851  5.849671414 5.974671414  3.765846279  3.765846279 10.803 10.322    10.965          10.583          10.268     11.063    10.124      10.555      11.147    -1.696 -2.539  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.156 -0.021 1.204 1.884 -0.075  0.55   0.2758 0.0306 67 1350 -0.36  -0.511 -0.688 -1.011 -0.592      -0.781 -0.654 -0.555 -0.47696 -0.47696 -0.00402  0.08  -0.08  -0.053 0.1   -0.035 -0.054  0        0           0.492 0.45  0.633 -0.185 423 0.26      0.119 0.169    0.233    0.077
    0.3    4.583 4.910796298  4.276796298  4.34        3.491899908  3.491899908 5.582125851  4.592125851  5.603671414 5.728671414  3.602846279  3.602846279 10.669 10.116    10.87           10.443          10.134     10.878    10.077      10.328      11.079    -1.643 -2.528  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.151 -0.021 1.215 1.884 -0.082  0.565  0.2719 0.0323 67 1250 -0.455 -0.514 -0.748 -1.133 -0.681      -0.867 -0.725 -0.596 -0.4845  -0.4845  -0.0037   0      0      1     0      0      1      0        0           0.492 0.436 0.584 -0.158 423 0.254     0.092 0.159    0.22     0.065
    0.4    4.18  4.548796298  3.919796298  3.935       3.128899908  3.128899908 5.091125851  4.089125851  5.151671414 5.277671414  3.343846279  3.343846279 10.116  9.561    10.411           9.884           9.598     10.296     9.539       9.639      10.547    -1.58  -2.452  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.143 -0.022 1.227 1.884 -0.091  0.58   0.2539 0.0302 67 1150 -0.617 -0.51  -0.802 -1.238 -0.772      -0.947 -0.801 -0.643 -0.48105 -0.48105 -0.00342 -0.13   0.113  0.087 0      0.05   0.2    0        0           0.492 0.433 0.556 -0.19  423 0.23      0.044 0.158    0.222    0.064
    0.5    3.752 4.168796298  3.486796298  3.505       2.640899908  2.640899908 4.680125851  3.571125851  4.719671414 4.848671414  3.028846279  3.028846279  9.579  8.973     9.901           9.341           9.097      9.711     9.03        9.03       10.049    -1.519 -2.384  0.1 -0.00657  -0.00541  -0.00387  -0.00862  -0.00397  -0.00787  -0.00255  -0.00219  -0.00401        -0.00217   -0.00311  -0.00217   -0.00355  1.143 -0.023 1.234 1.884 -0.1    0.595  0.2482 0.0295 67 1025 -0.757 -0.506 -0.845 -1.321 -0.838      -1.003 -0.863 -0.689 -0.46492 -0.46492 -0.00322 -0.2    0.176  0.118 0      0.1    0.2    0        0           0.492 0.428 0.51  -0.186 423 0.225     0.038 0.16     0.243    0.044
    0.75   3.085 3.510796298  2.710796298  2.837       1.987899908  1.987899908 3.906125851  2.844125851  3.995671414 4.129671414  2.499846279  2.499846279  8.837  8.246     9.335           8.593           8.324      8.934     8.258       8.258       9.327    -1.44  -2.338  0.1 -0.00635  -0.00478  -0.00342  -0.00763  -0.00351  -0.0068   -0.00211  -0.00189  -0.00347        -0.00188   -0.00269  -0.00188   -0.00307  1.217 -0.026 1.24  1.884 -0.115  0.61   0.2227 0.0266 67  900 -0.966 -0.5   -0.911 -1.383 -0.922      -1.052 -0.942 -0.745 -0.43439 -0.43439 -0.00312 -0.401  0.284  0.167 0      0.2    0.125 -0.2      0.012       0.492 0.448 0.471 -0.177 422 0.218     0.04  0.175    0.241    0.04
    1.0    2.644 3.067796298  2.238796298  2.396       1.553899908  1.553899908 3.481125851  2.371125851  3.512671414 3.653671414  2.140846279  2.140846279  8.067  7.507     8.68            7.817           7.557      8.164     7.467       7.417       8.504    -1.419 -2.267  0.1 -0.0058   -0.00415  -0.00297  -0.00663  -0.00305  -0.00605  -0.00187  -0.00168  -0.00309        -0.00167   -0.00239  -0.00167   -0.00273  1.27  -0.028 1.24  1.884 -0.134  0.625  0.1969 0.0231 67  800 -0.986 -0.49  -0.926 -1.414 -0.932      -1.028 -0.96  -0.777 -0.38484 -0.38484 -0.0031  -0.488  0.346  0.203 0      0.245  0.153 -0.245    0.037       0.492 0.43  0.43  -0.166 422 0.227     0.015 0.195    0.195    0.043
    1.5    2.046 2.513796298  1.451796298  1.799       0.990899908  0.990899908 2.870125851  1.779125851  2.875671414 3.023671414  1.645846279  1.645846279  6.829  6.213     7.581           6.573           6.35       6.896     6.22        6.18        7.204    -1.4   -2.166  0.1 -0.00505  -0.00342  -0.00245  -0.00546  -0.00252  -0.00498  -0.00154  -0.00139  -0.00254        -0.00138   -0.00197  -0.00138   -0.00225  1.344 -0.031 1.237 1.884 -0.154  0.64   0.1452 0.0118 67  760 -0.966 -0.486 -0.888 -1.43  -0.814      -0.971 -0.942 -0.79  -0.32318 -0.32318 -0.0031  -0.578  0.48   0.24  0      0.32   0.2   -0.32     0.064       0.492 0.406 0.406 -0.111 422 0.244    -0.047 0.204    0.204   -0.034
    2.0    1.556 2.061796298  0.906796298  1.31        0.534899908  0.534899908 2.507125851  1.293125851  2.327671414 2.481671414  1.217846279  1.217846279  5.871  5.206     6.671           5.609           5.434      5.935     5.261       5.161       6.227    -1.391 -2.077  0.1 -0.00429  -0.0029   -0.00208  -0.00463  -0.00214  -0.00423  -0.00131  -0.00118  -0.00216        -0.00117   -0.00167  -0.00117   -0.00191  1.396 -0.034 1.232 1.884 -0.154  0.655  0.06   0.007  67  760 -0.901 -0.475 -0.808 -1.421 -0.725      -0.901 -0.891 -0.765 -0.26577 -0.26577 -0.0031  -0.645  0.579  0.254 0      0.37   0.239 -0.28     0.14        0.492 0.393 0.393  0     422 0.231    -0.036 0.196    0.196   -0.036
    2.5    1.167 1.709796298  0.392796298  0.922       0.186899908  0.186899908 2.160125851  0.895125851  1.950671414 2.111671414  0.871846279  0.871846279  5.2    4.594     6.047           4.932           4.773      5.234     4.567       4.517       5.517    -1.394 -2.015  0.1 -0.00369  -0.0025   -0.00179  -0.00399  -0.00184  -0.00364  -0.00113  -0.00101  -0.00186        -0.00101   -0.00144  -0.00101   -0.00164  1.437 -0.036 1.227 1.884 -0.154  0.67   0      0       0  760 -0.822 -0.453 -0.743 -1.391 -0.632      -0.822 -0.842 -0.724 -0.21236 -0.21236 -0.0031  -0.678  0.609  0.267 0      0.4    0.264 -0.313    0.19        0.492 0.381 0.381  0     421 0.222    -0.025 0.169    0.169   -0.029
    3.0    0.92  1.456796298  0.099796298  0.675      -0.087100092 -0.087100092 1.969125851  0.607125851  1.766671414 1.932671414  0.596846279  0.596846279  4.83   4.206     5.667           4.556           4.441      4.849     4.176       4.076       5.157    -1.416 -2.012  0.1 -0.00321  -0.00217  -0.00156  -0.00347  -0.0016   -0.00316  -0.000979 -0.00088  -0.00161        -0.000873  -0.00125  -0.000873  -0.00143  1.47  -0.038 1.223 1.949 -0.154  0.685  0      0       0  760 -0.751 -0.428 -0.669 -1.343 -0.57       -0.751 -0.787 -0.675  0       -0.17807 -0.0031  -0.772  0.635  0.265 0      0.43   0.287 -0.355    0.165       0.492 0.367 0.367  0     419 0.199    -0.03  0.177    0.177   -0.011
    4.0    0.595 1.207796298 -0.356203702  0.352      -0.353100092 -0.353100092 1.675125851  0.303125851  1.524671414 1.698671414  0.268846279  0.268846279  4.173  3.517     4.97            3.893           3.849      4.074     3.495       3.445       4.55     -1.452 -1.989  0.1 -0.00244  -0.00165  -0.00118  -0.00264  -0.00122  -0.00241  -0.000745 -0.00067  -0.00123        -0.000664  -0.000952 -0.000664  -0.00109  1.523 -0.044 1.216 2.031 -0.154  0.7    0      0       0  760 -0.68  -0.396 -0.585 -1.297 -0.489      -0.68  -0.706 -0.613  0       -0.13729 -0.0031  -0.699  0.709  0.259 0      0.44   0.303 -0.417    0.163       0.492 0.33  0.33   0     416 0.191    -0.042 0.158    0.158    0.033
    5.0    0.465 1.131796298 -0.601203702  0.223      -0.491100092 -0.491100092 1.601125851  0.183125851  1.483671414 1.665671414  0.014846279  0.014846279  3.833  3.142     4.592           3.547           3.502      3.814     3.038       3.038       4.229    -1.504 -1.998  0.1 -0.0016   -0.00125  -0.000895 -0.002    -0.000919 -0.00182  -0.000564 -0.000507 -0.000929       -0.000503  -0.00072  -0.000503  -0.000822 1.564 -0.048 1.21  2.131 -0.154  0.715  0      0       0  760 -0.592 -0.353 -0.506 -1.233 -0.421      -0.592 -0.621 -0.536  0       -0.07733 -0.0031  -0.642  0.63   0.215 0      0.45   0.321 -0.45     0.132       0.492 0.298 0.298  0     415 0.181     0.005 0.132    0.132    0.014
    7.5    0.078 0.758796298 -1.137203702 -0.162      -0.837100092 -0.837100092 1.270125851 -0.143874149  1.175671414 1.366671414 -0.446153721 -0.446153721  3.132  2.391     3.65            2.84            2.821      3.152     2.368       2.368       3.554    -1.569 -2.019  0.1 -0.000766 -0.000519 -0.000371 -0.000828 -0.000382 -0.000755 -0.000234 -0.00021  -0.000385       -0.000209  -0.000299 -0.000209  -0.000341 1.638 -0.059 1.2   2.185 -0.154  0.73   0      0       0  760 -0.494 -0.311 -0.418 -1.147 -0.357      -0.52  -0.52  -0.444  0       -0.05443 -0.0031  -0.524  0.306  0.175 0      0.406  0.312 -0.35     0.15        0.492 0.254 0.254  0     419 0.181    -0.016 0.113    0.113    0.016
    10.0   0.046 0.708796298 -1.290203702 -0.193      -0.864100092 -0.864100092 1.364125851 -0.195874149  1.271671414 1.462671414 -0.473153721 -0.473153721  2.72   2.031     2.95            2.422           2.408      2.791     1.939       1.939       3.166    -1.676 -2.047  0.1  0         0         0         0         0         0         0         0         0               0          0         0          0        1.69  -0.067 1.194 2.35  -0.154  0.745  0      0       0  760 -0.395 -0.261 -0.321 -1.06  -0.302      -0.395 -0.42  -0.352  0       -0.03313 -0.0031  -0.327  0.182  0.121 0      0.345  0.265 -0.331    0.117       0.492 0.231 0.231  0     427 0.181     0.04  0.11     0.11     0.017"""


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
def _c0(trt, region, saturation_region, C):
    if trt == "interface":
        col = "c0" if saturation_region is None else saturation_region + "_c0"
    else:
        if saturation_region is None:
            col = "c0slab"
        elif region in ("AK", "SA"):
            col = saturation_region + "_c0slab"
        else:
            col = region + "_c0slab"
    return C[col]


def _m_b(trt, saturation_region):
    mb = MB_INTERFACE if trt == "interface" else MB_SLAB
    return mb.get(saturation_region, mb["default"])


def _magnitude_scaling(sfx, C, mag, m_b):
    m_diff = mag - m_b
    if m_diff > 0:
        return C["c6" + sfx] * m_diff
    return C["c4" + sfx] * m_diff + C["c5" + sfx] * m_diff ** 2


def _path_term_h(trt, mag, m_b):
    if trt == "interface":
        return 10 ** (-0.82 + 0.252 * mag)
    m = (math.log10(35) - math.log10(3.12)) / (m_b - 4)
    return 10 ** (m * (mag - m_b) + math.log10(35)) if mag <= m_b else 35.0


def _a0(trt, region, C):
    if trt == "interface":
        return C["a0"] if region is None or region == "Cascadia" else C[region + "_a0"]
    return C["a0slab"] if region is None else C[region + "_a0slab"]


def _path_term(trt, region, suffix, C, mag, rrup, m_b):
    h = _path_term_h(trt, mag, m_b)
    r = math.sqrt(rrup ** 2 + h ** 2)
    r_rref = math.log(r / math.sqrt(1 + h ** 2))
    a0 = _a0(trt, region, C)
    return C["c1" + suffix] * math.log(r) + (CONSTANTS["b4"] * mag) * r_rref + a0 * r


def _depth_scaling(trt, C, hypo_depth):
    if trt == "interface":
        return 0.0
    res = C["m"] * (hypo_depth - C["db"]) + C["d"]
    if hypo_depth >= C["db"]:
        res = C["d"]
    if hypo_depth <= 20:
        res = C["m"] * (20 - C["db"]) + C["d"]
    return res


def _linear_amplification(region, C, vs30):
    v1 = CONSTANTS["V1"]
    vref = CONSTANTS["vref"]
    if region is None or region == "CAM":
        s2 = C["s2"]
        s1 = s2
    elif region in ("TW", "JP"):
        s2 = C[region + "_s2"]
        s1 = C[region + "_s1"]
    else:
        s2 = C[region + "_s2"]
        s1 = s2
    if vs30 <= v1:
        return s1 * math.log(vs30 / v1) + s2 * math.log(v1 / vref)
    if vs30 <= C["V2"]:
        return s2 * math.log(vs30 / vref)
    return s2 * math.log(C["V2"] / vref)


def _non_linear_term(C, period, vs30, fp, fm, c0, fd):
    # fd for slab only; pgar from the PGA row of the same class.
    pgar = math.exp(fp + fm + c0 + fd)
    if period is not None and period >= 3:
        return 0.0
    fnl = C["f4"] * (math.exp(C["f5"] * (min(vs30, CONSTANTS["vref_fnl"]) - CONSTANTS["Vb"]))
                     - math.exp(C["f5"] * (CONSTANTS["vref_fnl"] - CONSTANTS["Vb"])))
    fnl *= math.log((pgar + CONSTANTS["f3"]) / CONSTANTS["f3"])
    return fnl


def get_stddevs(C, rrup, vs30):
    v1, v2, r1, r2 = 200, 500, 200, 500
    if rrup <= r1:
        phi_rv = C["phi21"]
    elif rrup >= r2:
        phi_rv = C["phi22"]
    else:
        phi_rv = ((C["phi22"] - C["phi21"]) / (math.log(r2) - math.log(r1))) \
            * (math.log(rrup) - math.log(r1)) + C["phi21"]
    if vs30 <= v1:
        phi_rv += C["phi2V"] * (math.log(r2 / max(r1, min(r2, rrup))) / math.log(r2 / r1))
    elif vs30 < v2:
        phi_rv += C["phi2V"] * ((math.log(v2 / min(v2, vs30)) / math.log(v2 / v1))) \
            * (math.log(r2 / max(r1, min(r2, rrup))) / math.log(r2 / r1))
    phi_tot = math.sqrt(phi_rv)
    return math.sqrt(C["Tau"] ** 2 + phi_tot ** 2), C["Tau"], phi_tot


def parker_ln(imt_key, trt, region, sat_region, mag, rrup, vs30, hypo_depth):
    """Median ln ground motion. imt_key: 'pga' | 'pgv' | SA period string.
    region/sat_region: hazardlib names or None (global)."""
    C = ROWS[imt_key]
    C_PGA = ROWS["pga"]
    sfx = "" if trt == "interface" else "slab"
    # hazardlib __init__: saturation_region defaults to region
    sat = sat_region if sat_region is not None else region
    m_b = _m_b(trt, sat)
    c0 = _c0(trt, region, sat, C)
    fm = _magnitude_scaling(sfx, C, mag, m_b)
    fp = _path_term(trt, region, sfx, C, mag, rrup, m_b)
    fd = _depth_scaling(trt, C, hypo_depth)
    flin = _linear_amplification(region, C, vs30)
    c0_pga = _c0(trt, region, sat, C_PGA)
    fm_pga = _magnitude_scaling(sfx, C_PGA, mag, m_b)
    fp_pga = _path_term(trt, region, sfx, C_PGA, mag, rrup, m_b)
    fd_pga = _depth_scaling(trt, C_PGA, hypo_depth)
    period = None if imt_key in ("pga", "pgv") else float(imt_key)
    fnl = _non_linear_term(C, period, vs30, fp_pga, fm_pga, c0_pga, fd_pga)
    mean = fp + fnl + flin + fm + c0 + fd  # fb = 0 (no z2pt5 -> basin off)
    sig, tau, phi = get_stddevs(C, rrup, vs30)
    return mean, sig, tau, phi


# --- fixture grid ------------------------------------------------------------
CONFIGS = {
    "global":   {"region": None,       "sat": None},
    "cascadia": {"region": "Cascadia", "sat": None},
    "sa_s":     {"region": "SA",       "sat": "SA_S"},
    "tw_e":     {"region": "TW",       "sat": "TW_E"},
}

SA_PERIODS = ["0.01", "0.02", "0.025", "0.03", "0.04", "0.05", "0.075", "0.1",
              "0.15", "0.2", "0.25", "0.3", "0.4", "0.5", "0.75", "1.0", "1.5",
              "2.0", "2.5", "3.0", "4.0", "5.0", "7.5", "10.0"]

# core grid (pga/pgv)
M_IF = [5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5]
M_SLAB = [5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.3]
R_GRID = [1, 5, 10, 20, 30, 50, 100, 200, 300, 500, 1000]
V_GRID = [150, 270, 360, 760, 1100, 2000]
Z_GRID = [15, 20, 50, 67, 120, 200]
# SA grid (reduced)
M_IF_SA = [6.5, 7.5, 8.5, 9.0]
M_SLAB_SA = [6.5, 7.5, 8.3]
R_SA = [10, 100, 500]
V_SA = [270, 760, 1500]
Z_SA = [20, 120]


def generate():
    points = []
    for cfg_name, cfg in CONFIGS.items():
        region, sat = cfg["region"], cfg["sat"]
        for imt in ("pga", "pgv"):
            for mag in M_IF:
                for rrup in R_GRID:
                    for vs30 in V_GRID:
                        lnA, sig, tau, phi = parker_ln(imt, "interface", region, sat,
                                                       mag, rrup, vs30, 30.0)
                        points.append([imt, "interface", cfg_name, mag, rrup, vs30, 30.0,
                                       lnA, sig, tau, phi])
            for mag in M_SLAB:
                for rrup in R_GRID:
                    for vs30 in V_GRID:
                        for zhyp in Z_GRID:
                            lnA, sig, tau, phi = parker_ln(imt, "intraslab", region, sat,
                                                           mag, rrup, vs30, zhyp)
                            points.append([imt, "intraslab", cfg_name, mag, rrup, vs30, zhyp,
                                           lnA, sig, tau, phi])
        for imt in SA_PERIODS:
            for mag in M_IF_SA:
                for rrup in R_SA:
                    for vs30 in V_SA:
                        lnA, sig, tau, phi = parker_ln(imt, "interface", region, sat,
                                                       mag, rrup, vs30, 30.0)
                        points.append([imt, "interface", cfg_name, mag, rrup, vs30, 30.0,
                                       lnA, sig, tau, phi])
            for mag in M_SLAB_SA:
                for rrup in R_SA:
                    for vs30 in V_SA:
                        for zhyp in Z_SA:
                            lnA, sig, tau, phi = parker_ln(imt, "intraslab", region, sat,
                                                           mag, rrup, vs30, zhyp)
                            points.append([imt, "intraslab", cfg_name, mag, rrup, vs30, zhyp,
                                           lnA, sig, tau, phi])
    return points


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join("tools", "data", "gmpe-fixtures-ngasub.json"))
    args = ap.parse_args()
    points = generate()
    doc = {
        "schema": "quake-sim-gmpe-fixtures-ngasub-v1",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00"),
        "source": {
            "repository": "gem/oq-engine (master via jsDelivr)",
            "path": "openquake/hazardlib/gsim/parker_2020.py",
            "sha256": "32df333b97242449ad2de22f93ffd7d0bf5335b5c56a69c05e3142dcf568f322",
            "paper": "Parker, Stewart, Boore, Atkinson & Hassani (2020) PEER 2020/03; "
                     "Parker et al. (2022) Earthquake Spectra 38(2) 845-870",
            "basis": "scalar transcription of the hazardlib implementation "
                     "(ParkerEtAl2020SInter / ParkerEtAl2020SSlab, basin term off, "
                     "no epistemic sigma_mu, no AK23 bias adjustment; independent of "
                     "physics.js); regenerate by re-transcribing if hazardlib updates"
        },
        "units": "lnA: pga/SA = ln(median in g), pgv = ln(median in cm/s) — hazardlib "
                 "native; sigma/tau/phi in ln units. physics.js pgaParker2022 converts "
                 "g -> gal with 980.665",
        "constants": dict(CONSTANTS),
        "mb": {"interface": MB_INTERFACE, "intraslab": MB_SLAB},
        "table": {"columns": COLUMNS, "rows": ROWS},
        "configs": CONFIGS,
        "pointFields": ["imt", "trt", "config", "mag", "rrup", "vs30", "zhyp",
                        "lnA", "sigma", "tau", "phi"],
        "points": points
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print("wrote %s: %d points, %d table rows, %d columns" %
          (args.out, len(points), len(ROWS), len(COLUMNS)))


if __name__ == "__main__":
    main()
