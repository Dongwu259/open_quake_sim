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
ASC = {
    'pga': dict(a=1.101, b=-0.00564, c=0.0055, d=1.080, e=0.01412, FR=0.251,
                site=[0.293, 1.111, 1.344, 1.355, 1.420], sigma=0.604,
                QC=0.0, WC=0.0, tauC=0.303),
    'sa1': dict(a=1.479, b=-0.00220, c=0.0020, d=1.115, e=0.01005, FR=0.211,
                site=[-2.451, -2.152, -1.776, -1.523, -1.084], sigma=0.657,
                QC=-0.0899, WC=0.0440, tauC=0.338),
}
# ZhaoEtAl2006SInter.COEFFS_SINTER: IMT SI QI WI tauI
SINTER = {
    'pga': dict(SI=0.000, QI=0.0, WI=0.0, tauI=0.308),
    'sa1': dict(SI=-0.239, QI=-0.0917, WI=0.0721, tauI=0.328),
}
# ZhaoEtAl2006SSlab.COEFFS_SSLAB: IMT SS SSL PS QS WS tauS
SSLAB = {
    'pga': dict(SS=2.607, SSL=-0.528, PS=0.1392, QS=0.1584, WS=-0.0529, tauS=0.321),
    'sa1': dict(SS=2.233, SSL=-0.509, PS=0.1060, QS=0.0314, WS=0.0498, tauS=0.286),
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

    points = []
    stddevs = {}
    for imt in ('pga', 'sa1'):
        for src_type, rake in cases:
            cls = {'crustal': 'crustal', 'interplate': 'interplate', 'intraslab': 'intraslab'}[src_type]
            ln, phi, tau = zhao_lnA(imt, src_type, 6.5, 60.0, 35.0, 400.0, rake)
            stddevs[f'{imt}.{cls}'] = {'phi_ln': phi, 'tau_ln': tau}
            for mag in mags:
                for rrup in rrups:
                    for depth in depths:
                        for vs30 in vs30s:
                            lnA, _, _ = zhao_lnA(imt, src_type, mag, rrup, depth, vs30, rake)
                            points.append({
                                'imt': imt, 'srcType': src_type,
                                'mw': mag, 'rrupKm': rrup, 'depthKm': depth,
                                'vs30': vs30, 'rake': rake,
                                'lnA': lnA,
                            })

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
