#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the frozen Zhao (2006) GMPE reference fixtures.

R0-3 (2026-08-24). The physics.js `zhao2006LnA` implementation is asserted in
tests/gmpe-benchmarks.test.js against reference values produced by this
script. The formula below is a scalar transcription of the OFFICIAL
openquake.hazardlib implementation (gem/oq-engine,
openquake/hazardlib/gsim/zhao_2006.py) — NOT of physics.js — so the two
implementations are independent: coefficients were transcribed from the
hazardlib source (itself an independent transcription of the paper's Tables
4/5/6) and the equation structure follows Zhao et al. (2006) Eq.(1) p.901 +
Eq.(5) p.909 exactly as hazardlib implements them.

Provenance of the transcription source (keep in sync when regenerating):
  repository: gem/oq-engine (master via jsDelivr)
  path:       openquake/hazardlib/gsim/zhao_2006.py
  sha256:     3322dd09d4064d917fce9c9b5ec11b571b0fd94f1a068a8982d6ccea5ac88ec9

Only the PGA and 1.0 s SA rows are frozen — the two rows physics.js uses
(PGV is derived from SA(1.0) via pseudo-velocity, which has no published
regression of its own).

Output units: lnA is the natural log of median ground motion in cm/s**2
(gal), i.e. hazardlib's `mean_i` BEFORE its cm/s**2 -> g conversion. This is
exactly what Physics.zhao2006LnA returns.

Usage: python tools/gen-gmpe-fixtures.py [--out=tools/data/gmpe-fixtures-zhao2006.json]
"""
import argparse
import datetime
import hashlib
import json
import math
import os

# --- hazardlib coefficient rows (verbatim transcription) -----------------
# ZhaoEtAl2006Asc.COEFFS_ASC: IMT a b c d e FR CH C1 C2 C3 C4 sigma QC WC tauC
# (v6.1 P2, 2026-09-01: extended from {pga, sa1} to ALL 20 SA periods
#  0.05-5.00 s, transcribed from the same frozen hazardlib source sha256)
ASC = {
    'pga': dict(a=1.101, b=-0.00564, c=0.0055, d=1.08, e=0.01412, FR=0.251,
                site=[0.293, 1.111, 1.344, 1.355, 1.42], sigma=0.604,
                QC=0.0, WC=0.0, tauC=0.303),
    '0.05': dict(a=1.076, b=-0.00671, c=0.0075, d=1.06, e=0.01463, FR=0.251,
                site=[0.939, 1.684, 1.793, 1.747, 1.814], sigma=0.64,
                QC=0.0, WC=0.0, tauC=0.326),
    '0.10': dict(a=1.118, b=-0.00787, c=0.009, d=1.083, e=0.01423, FR=0.24,
                site=[1.499, 2.061, 2.135, 2.031, 2.082], sigma=0.694,
                QC=0.0, WC=0.0, tauC=0.342),
    '0.15': dict(a=1.134, b=-0.00722, c=0.01, d=1.053, e=0.01509, FR=0.251,
                site=[1.462, 1.916, 2.168, 2.052, 2.113], sigma=0.702,
                QC=0.0, WC=0.0, tauC=0.331),
    '0.20': dict(a=1.147, b=-0.00659, c=0.012, d=1.014, e=0.01462, FR=0.26,
                site=[1.28, 1.669, 2.085, 2.001, 2.03], sigma=0.692,
                QC=0.0, WC=0.0, tauC=0.312),
    '0.25': dict(a=1.149, b=-0.0059, c=0.014, d=0.966, e=0.01459, FR=0.269,
                site=[1.121, 1.468, 1.942, 1.941, 1.937], sigma=0.682,
                QC=0.0, WC=0.0, tauC=0.298),
    '0.30': dict(a=1.163, b=-0.0052, c=0.015, d=0.934, e=0.01458, FR=0.259,
                site=[0.852, 1.172, 1.683, 1.808, 1.77], sigma=0.67,
                QC=0.0, WC=0.0, tauC=0.3),
    '0.40': dict(a=1.2, b=-0.00422, c=0.01, d=0.959, e=0.01257, FR=0.248,
                site=[0.365, 0.655, 1.127, 1.482, 1.397], sigma=0.659,
                QC=0.0, WC=0.0, tauC=0.346),
    '0.50': dict(a=1.25, b=-0.00338, c=0.006, d=1.008, e=0.01114, FR=0.247,
                site=[-0.207, 0.071, 0.515, 0.934, 0.955], sigma=0.653,
                QC=-0.0126, WC=0.0116, tauC=0.338),
    '0.60': dict(a=1.293, b=-0.00282, c=0.003, d=1.088, e=0.01019, FR=0.233,
                site=[-0.705, -0.429, -0.003, 0.394, 0.559], sigma=0.653,
                QC=-0.0329, WC=0.0202, tauC=0.349),
    '0.70': dict(a=1.336, b=-0.00258, c=0.0025, d=1.084, e=0.00979, FR=0.22,
                site=[-1.144, -0.866, -0.449, -0.111, 0.188], sigma=0.652,
                QC=-0.0501, WC=0.0274, tauC=0.351),
    '0.80': dict(a=1.386, b=-0.00242, c=0.0022, d=1.088, e=0.00944, FR=0.232,
                site=[-1.609, -1.325, -0.928, -0.62, -0.246], sigma=0.647,
                QC=-0.065, WC=0.0336, tauC=0.356),
    '0.90': dict(a=1.433, b=-0.00232, c=0.002, d=1.109, e=0.00972, FR=0.22,
                site=[-2.023, -1.732, -1.349, -1.066, -0.643], sigma=0.653,
                QC=-0.0781, WC=0.0391, tauC=0.348),
    '1.00': dict(a=1.479, b=-0.0022, c=0.002, d=1.115, e=0.01005, FR=0.211,
                site=[-2.451, -2.152, -1.776, -1.523, -1.084], sigma=0.657,
                QC=-0.0899, WC=0.044, tauC=0.338),
    '1.25': dict(a=1.551, b=-0.00207, c=0.002, d=1.083, e=0.01003, FR=0.251,
                site=[-3.243, -2.923, -2.542, -2.327, -1.936], sigma=0.66,
                QC=-0.1148, WC=0.0545, tauC=0.313),
    '1.50': dict(a=1.621, b=-0.00224, c=0.002, d=1.091, e=0.00928, FR=0.248,
                site=[-3.888, -3.548, -3.169, -2.979, -2.661], sigma=0.664,
                QC=-0.1351, WC=0.063, tauC=0.306),
    '2.00': dict(a=1.694, b=-0.00201, c=0.0025, d=1.055, e=0.00833, FR=0.263,
                site=[-4.783, -4.41, -4.039, -3.871, -3.64], sigma=0.669,
                QC=-0.1672, WC=0.0764, tauC=0.283),
    '2.50': dict(a=1.748, b=-0.00187, c=0.0028, d=1.052, e=0.00776, FR=0.262,
                site=[-5.444, -5.049, -4.698, -4.496, -4.341], sigma=0.671,
                QC=-0.1921, WC=0.0869, tauC=0.287),
    '3.00': dict(a=1.759, b=-0.00147, c=0.0032, d=1.025, e=0.00644, FR=0.307,
                site=[-5.839, -5.431, -5.089, -4.893, -4.758], sigma=0.667,
                QC=-0.2124, WC=0.0954, tauC=0.278),
    '4.00': dict(a=1.826, b=-0.00195, c=0.004, d=1.044, e=0.0059, FR=0.353,
                site=[-6.598, -6.181, -5.882, -5.698, -5.588], sigma=0.647,
                QC=-0.2445, WC=0.1088, tauC=0.273),
    '5.00': dict(a=1.825, b=-0.00237, c=0.005, d=1.065, e=0.0051, FR=0.248,
                site=[-6.752, -6.347, -6.051, -5.873, -5.798], sigma=0.643,
                QC=-0.2694, WC=0.1193, tauC=0.275),
}
# ZhaoEtAl2006SInter.COEFFS_SINTER: IMT SI QI WI tauI
SINTER = {
    'pga': dict(SI=0.0, QI=0.0, WI=0.0, tauI=0.308),
    '0.05': dict(SI=0.0, QI=0.0, WI=0.0, tauI=0.343),
    '0.10': dict(SI=0.0, QI=0.0, WI=0.0, tauI=0.403),
    '0.15': dict(SI=0.0, QI=-0.0138, WI=0.0286, tauI=0.367),
    '0.20': dict(SI=0.0, QI=-0.0256, WI=0.0352, tauI=0.328),
    '0.25': dict(SI=0.0, QI=-0.0348, WI=0.0403, tauI=0.289),
    '0.30': dict(SI=0.0, QI=-0.0423, WI=0.0445, tauI=0.28),
    '0.40': dict(SI=-0.041, QI=-0.0541, WI=0.0511, tauI=0.271),
    '0.50': dict(SI=-0.053, QI=-0.0632, WI=0.0562, tauI=0.277),
    '0.60': dict(SI=-0.103, QI=-0.0707, WI=0.0604, tauI=0.296),
    '0.70': dict(SI=-0.146, QI=-0.0771, WI=0.0639, tauI=0.313),
    '0.80': dict(SI=-0.164, QI=-0.0825, WI=0.067, tauI=0.329),
    '0.90': dict(SI=-0.206, QI=-0.0874, WI=0.0697, tauI=0.324),
    '1.00': dict(SI=-0.239, QI=-0.0917, WI=0.0721, tauI=0.328),
    '1.25': dict(SI=-0.256, QI=-0.1009, WI=0.0772, tauI=0.339),
    '1.50': dict(SI=-0.306, QI=-0.1083, WI=0.0814, tauI=0.352),
    '2.00': dict(SI=-0.321, QI=-0.1202, WI=0.088, tauI=0.36),
    '2.50': dict(SI=-0.337, QI=-0.1293, WI=0.0931, tauI=0.356),
    '3.00': dict(SI=-0.331, QI=-0.1368, WI=0.0972, tauI=0.338),
    '4.00': dict(SI=-0.39, QI=-0.1486, WI=0.1038, tauI=0.307),
    '5.00': dict(SI=-0.498, QI=-0.1578, WI=0.109, tauI=0.272),
}
# ZhaoEtAl2006SSlab.COEFFS_SSLAB: IMT SS SSL PS QS WS tauS
SSLAB = {
    'pga': dict(SS=2.607, SSL=-0.528, PS=0.1392, QS=0.1584, WS=-0.0529, tauS=0.321),
    '0.05': dict(SS=2.764, SSL=-0.551, PS=0.1636, QS=0.1932, WS=-0.0841, tauS=0.378),
    '0.10': dict(SS=2.156, SSL=-0.42, PS=0.169, QS=0.2057, WS=-0.0877, tauS=0.42),
    '0.15': dict(SS=2.161, SSL=-0.431, PS=0.1669, QS=0.1984, WS=-0.0773, tauS=0.372),
    '0.20': dict(SS=1.901, SSL=-0.372, PS=0.1631, QS=0.1856, WS=-0.0644, tauS=0.324),
    '0.25': dict(SS=1.814, SSL=-0.36, PS=0.1588, QS=0.1714, WS=-0.0515, tauS=0.294),
    '0.30': dict(SS=2.181, SSL=-0.45, PS=0.1544, QS=0.1573, WS=-0.0395, tauS=0.284),
    '0.40': dict(SS=2.432, SSL=-0.506, PS=0.146, QS=0.1309, WS=-0.0183, tauS=0.278),
    '0.50': dict(SS=2.629, SSL=-0.554, PS=0.1381, QS=0.1078, WS=-0.0008, tauS=0.272),
    '0.60': dict(SS=2.702, SSL=-0.575, PS=0.1307, QS=0.0878, WS=0.0136, tauS=0.285),
    '0.70': dict(SS=2.654, SSL=-0.572, PS=0.1239, QS=0.0705, WS=0.0254, tauS=0.29),
    '0.80': dict(SS=2.48, SSL=-0.54, PS=0.1176, QS=0.0556, WS=0.0352, tauS=0.299),
    '0.90': dict(SS=2.332, SSL=-0.522, PS=0.1116, QS=0.0426, WS=0.0432, tauS=0.289),
    '1.00': dict(SS=2.233, SSL=-0.509, PS=0.106, QS=0.0314, WS=0.0498, tauS=0.286),
    '1.25': dict(SS=2.029, SSL=-0.469, PS=0.0933, QS=0.0093, WS=0.0612, tauS=0.277),
    '1.50': dict(SS=1.589, SSL=-0.379, PS=0.0821, QS=-0.0062, WS=0.0674, tauS=0.282),
    '2.00': dict(SS=0.966, SSL=-0.248, PS=0.0628, QS=-0.0235, WS=0.0692, tauS=0.3),
    '2.50': dict(SS=0.789, SSL=-0.221, PS=0.0465, QS=-0.0287, WS=0.0622, tauS=0.292),
    '3.00': dict(SS=1.037, SSL=-0.263, PS=0.0322, QS=-0.0261, WS=0.0496, tauS=0.274),
    '4.00': dict(SS=0.561, SSL=-0.169, PS=0.0083, QS=-0.0065, WS=0.015, tauS=0.281),
    '5.00': dict(SS=0.225, SSL=-0.12, PS=-0.0117, QS=0.0246, WS=-0.0268, tauS=0.296),
}

HC = 15.0  # p. 902 depth coefficient


# --- hazardlib formula functions, scalar-port ---------------------------
def _compute_magnitude_term(C, mag):
    return C['a'] * mag


def _compute_distance_term(C, mag, rrup):
    term1 = C['b'] * rrup
    term2 = -math.log(rrup + C['c'] * math.exp(C['d'] * mag))
    return term1 + term2


def _compute_focal_depth_term(C, hypo_depth):
    focal_depth = min(max(hypo_depth, 0.0), 125.0)
    return (1.0 if focal_depth >= HC else 0.0) * C['e'] * (focal_depth - HC)


def _compute_faulting_style_term(C, rake):
    return (1.0 if (rake is not None and 45.0 < rake < 135.0) else 0.0) * C['FR']


def _compute_site_class_term(C, vs30):
    if vs30 > 1100.0:
        return C['site'][0]
    if vs30 > 600.0:
        return C['site'][1]
    if vs30 > 300.0:
        return C['site'][2]
    if vs30 > 200.0:
        return C['site'][3]
    return C['site'][4]


def _compute_magnitude_squared_term(P, M, Q, W, mag):
    return P * (mag - M) + Q * (mag - M) ** 2 + W


def _compute_slab_correction_term(CS, rrup):
    return CS['SSL'] * math.log(rrup)


def zhao_lnA(imt, src_type, mag, rrup, hypo_depth, vs30, rake):
    """ln(median) in cm/s**2, replicating the class dispatch of hazardlib."""
    C = ASC[imt]
    r = 0.1 if rrup == 0.0 else rrup  # slab ln(r) singularity guard
    lnA = (_compute_magnitude_term(C, mag)
           + _compute_distance_term(C, mag, r)
           + _compute_focal_depth_term(C, hypo_depth)
           + _compute_site_class_term(C, vs30))
    if src_type == 'crustal':            # ZhaoEtAl2006Asc
        lnA += (_compute_faulting_style_term(C, rake)
                + _compute_magnitude_squared_term(0.0, 6.3, C['QC'], C['WC'], mag))
        tau = C['tauC']
    elif src_type == 'interplate':       # ZhaoEtAl2006SInter (no faulting-style term)
        CI = SINTER[imt]
        lnA += _compute_magnitude_squared_term(0.0, 6.3, CI['QI'], CI['WI'], mag) + CI['SI']
        tau = CI['tauI']
    else:                                # ZhaoEtAl2006SSlab
        CS = SSLAB[imt]
        lnA += (_compute_magnitude_squared_term(CS['PS'], 6.5, CS['QS'], CS['WS'], mag)
                + CS['SS'] + _compute_slab_correction_term(CS, r))
        tau = CS['tauS']
    return lnA, C['sigma'], tau


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='tools/data/gmpe-fixtures-zhao2006.json')
    args = ap.parse_args()

    mags = [5.5, 6.5, 7.5, 8.5]
    rrups = [10.0, 30.0, 60.0, 120.0, 250.0]
    depths = [12.0, 35.0, 80.0]
    vs30s = [150.0, 250.0, 400.0, 800.0, 1500.0]
    cases = [('crustal', 0.0), ('crustal', 90.0), ('interplate', None), ('intraslab', None)]

    # v6.1 P2 (2026-09-01): the full 1,200-point grid stays for pga and the
    # 1.0 s row (fixture label 'sa1', back-compat with the frozen v1 fixture);
    # the other 19 SA periods each get a stratified 96-point grid
    # (2 mags x 3 rrups x 2 depths x 2 vs30 x 4 mechanism cases).
    reduced = dict(mags=[6.5, 7.5], rrups=[10.0, 60.0, 250.0], depths=[12.0, 80.0], vs30s=[250.0, 800.0])
    SA_PERIODS = ['0.05', '0.10', '0.15', '0.20', '0.25', '0.30', '0.40', '0.50', '0.60',
                  '0.70', '0.80', '0.90', '1.25', '1.50', '2.00', '2.50', '3.00', '4.00', '5.00']

    points = []
    stddevs = {}

    def emit(imt, label, grid):
        for src_type, rake in cases:
            ln, phi, tau = zhao_lnA(imt, src_type, 6.5, 60.0, 35.0, 400.0, rake)
            stddevs[f'{label}.{src_type}'] = {'phi_ln': phi, 'tau_ln': tau}
            for mag in grid['mags']:
                for rrup in grid['rrups']:
                    for depth in grid['depths']:
                        for vs30 in grid['vs30s']:
                            lnA, _, _ = zhao_lnA(imt, src_type, mag, rrup, depth, vs30, rake)
                            points.append({
                                'imt': label, 'srcType': src_type,
                                'mw': mag, 'rrupKm': rrup, 'depthKm': depth,
                                'vs30': vs30, 'rake': rake,
                                'lnA': lnA,
                            })

    full = dict(mags=mags, rrups=rrups, depths=depths, vs30s=vs30s)
    emit('pga', 'pga', full)
    emit('1.00', 'sa1', full)
    for p in SA_PERIODS:
        emit(p, p, reduced)

    out = {
        'schema': 'quake-sim-gmpe-fixtures-zhao2006-v1',
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'source': {
            'repository': 'gem/oq-engine (master via jsDelivr)',
            'path': 'openquake/hazardlib/gsim/zhao_2006.py',
            'sha256': '3322dd09d4064d917fce9c9b5ec11b571b0fd94f1a068a8982d6ccea5ac88ec9',
            'paper': 'Zhao et al. (2006) BSSA 96(3) pp.898-913, Eq.(1) p.901 + Eq.(5) p.909',
            'basis': 'scalar transcription of the hazardlib implementation (independent of physics.js); regenerate by re-transcribing if hazardlib updates',
        },
        'units': 'lnA = ln(median ground motion in cm/s**2), i.e. hazardlib mean_i before the cm/s**2 -> g conversion',
        'rows': {'asc': ASC, 'sinter': SINTER, 'sslab': SSLAB},
        'stddevs_ln': stddevs,
        'points': points,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=1)
        fh.write('\n')
    digest = hashlib.sha256(open(args.out, 'rb').read()).hexdigest()[:16]
    print(f'wrote {args.out}: {len(points)} points, sha256[:16]={digest}')


if __name__ == '__main__':
    main()
