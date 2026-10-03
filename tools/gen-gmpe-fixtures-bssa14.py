#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the frozen BSSA14 (Boore et al. 2014, NGA-West2) GMPE fixtures.

v6.7 NGA-West2 batch (2026-10-01). The physics.js `bssa2014Ln` implementation
is asserted in tests/gmpe-bssa14.test.js against reference values produced by
this script. The formula below is a scalar transcription of the OFFICIAL
openquake.hazardlib implementation (gem/oq-engine,
openquake/hazardlib/gsim/boore_2014.py) — NOT of physics.js — so the two
implementations are independent: coefficients were transcribed from the
hazardlib source and the equation structure follows Boore et al. (2014)
Eq.(2)-(8) + (13)-(17) exactly as hazardlib implements them (class
BooreEtAl2014 with region='nobasin', sof=True; the basin term is OFF because
no region pack carries z1.0 site data).

Provenance of the transcription source (keep in sync when regenerating):
  repository: gem/oq-engine (master via jsDelivr)
  path:       openquake/hazardlib/gsim/boore_2014.py
  sha256:     c12315ff4c3d7c84ef39433348285ead4999032ec3ada0b4ccd09238cf3b4422

Only the PGA and PGV rows are frozen — the two rows physics.js uses (the SA
period rows can be transcribed from the same frozen source if a future batch
needs BSSA14 response spectra). The hazardlib HighQ (China/Turkey) and LowQ
(Italy/Japan) subclasses differ from the base table ONLY in the Dc3 column;
all three variants are exercised here through the Dc3 override map.

hazardlib boundary quirk, replicated faithfully and pinned by the 225.0 m/s
grid point: at vs30 == v1 exactly BOTH the vs30<=v1 phi adjustment (-DfV) and
the v1<=vs30<=v2 taper branch (-DfV * ln(v2/vs30)/ln(v2/v1) = -DfV) fire,
subtracting 2*DfV. Keep the two `if` blocks separate in every port.

Output units follow hazardlib: ln(PGA) in g, ln(PGV) in cm/s. physics.js
pgaBssa2014 converts g -> gal with the standard gravity 980.665.

Usage: python tools/gen-gmpe-fixtures-bssa14.py [--out=tools/data/gmpe-fixtures-bssa14.json]
"""
import argparse
import datetime
import hashlib
import json
import math
import os

# --- hazardlib constants + coefficient rows (verbatim transcription) -------
# Module CONSTS (IMT-independent): Mref Rref Vref f1 f3 v1 v2.
CONSTS = dict(Mref=4.5, Rref=1.0, Vref=760.0, f1=0.0, f3=0.1, v1=225.0, v2=300.0)

# BooreEtAl2014.COEFFS base table, IMT rows: e0 e1 e2 e3 e4 e5 e6 Mh c1 c2 c3
# h Dc3 c Vc f4 f5 f6 f7 R1 R2 DfR DfV f1 f2 tau1 tau2
# NOTE: the table's f1/f2 columns are the phi magnitude ramp (Eq. 17) and are
# NOT the CONSTS.f1 of the nonlinear site term. f6/f7 (basin) transcribed for
# completeness; unused with region='nobasin'.
ROWS = {
    'pga': dict(e0=0.4473, e1=0.4856, e2=0.2459, e3=0.4539, e4=1.431,
                e5=0.05053, e6=-0.1662, Mh=5.5, c1=-1.134, c2=0.1917,
                c3=-0.008088, h=4.5, Dc3=0.0, c=-0.6, Vc=1500.0, f4=-0.15,
                f5=-0.00701, f6=-9.9, f7=-9.9, R1=110.0, R2=270.0, DfR=0.1,
                DfV=0.07, f1=0.695, f2=0.495, tau1=0.398, tau2=0.348),
    'pgv': dict(e0=5.037, e1=5.078, e2=4.849, e3=5.033, e4=1.073,
                e5=-0.1536, e6=0.2252, Mh=6.2, c1=-1.243, c2=0.1489,
                c3=-0.00344, h=5.3, Dc3=0.0, c=-0.84, Vc=1300.0, f4=-0.1,
                f5=-0.00844, f6=-9.9, f7=-9.9, R1=105.0, R2=272.0, DfR=0.082,
                DfV=0.08, f1=0.644, f2=0.552, tau1=0.401, tau2=0.346),
}
# Dc3 column of the regional subclasses (the only column that differs).
DC3 = {
    'base':  {'pga': 0.0,      'pgv': 0.0},
    'lowQ':  {'pga': -0.00255, 'pgv': -0.00033},   # Italy / Japan
    'highQ': {'pga': 0.002858, 'pgv': 0.004345},   # China / Turkey
}


# --- hazardlib formula functions, scalar-port ------------------------------
def _style_term(C, rake):
    """_get_style_of_faulting_term: default normal e2; SS e1; reverse e3."""
    if rake is None:
        return C['e0']  # NoSOF alias (unspecified style-of-faulting)
    a = abs(rake)
    if a <= 30.0 or (180.0 - a) <= 30.0:
        return C['e1']  # strike-slip
    if 30.0 < rake < 150.0:
        return C['e3']  # reverse (signed rake, like hazardlib)
    return C['e2']      # normal


def _mag_term(C, mag):
    """Eq.(2) magnitude ramp around the Mh hinge."""
    d = mag - C['Mh']
    return C['e4'] * d + C['e5'] * d ** 2 if mag <= C['Mh'] else C['e6'] * d


def _path_term(C, mag, rjb, dc3):
    """Eq.(3)-(4) path term, base kind with regional Dc3."""
    R = math.sqrt(rjb ** 2 + C['h'] ** 2)
    return ((C['c1'] + C['c2'] * (mag - CONSTS['Mref'])) * math.log(R / CONSTS['Rref'])
            + (C['c3'] + dc3) * (R - CONSTS['Rref']))


def _site_term(C, vs30, pga_rock):
    """Eq.(5): Eq.(6) linear + Eq.(7)-(8) nonlinear; basin term OFF."""
    flin = C['c'] * math.log(min(vs30, C['Vc']) / CONSTS['Vref'])
    v_s = min(vs30, CONSTS['Vref'])
    f_2 = C['f4'] * (math.exp(C['f5'] * (v_s - 360.0)) - math.exp(C['f5'] * 400.0))
    fnl = CONSTS['f1'] + f_2 * math.log((pga_rock + CONSTS['f3']) / CONSTS['f3'])
    return flin + fnl


def _pga_on_rock(mag, rjb, rake, variant):
    """Median PGA on rock (g), PGA row — drives the nonlinear site term."""
    C = ROWS['pga']
    return math.exp(_style_term(C, rake) + _mag_term(C, mag)
                    + _path_term(C, mag, rjb, DC3[variant]['pga']))


def bssa_ln(imt, variant, mag, rjb, vs30, rake):
    """ln(median): pga -> ln g, pgv -> ln cm/s (hazardlib native units)."""
    C = ROWS[imt]
    return (_style_term(C, rake) + _mag_term(C, mag)
            + _path_term(C, mag, rjb, DC3[variant][imt])
            + _site_term(C, vs30, _pga_on_rock(mag, rjb, rake, variant)))


def bssa_sigma_ln(imt, mag, rjb, vs30):
    """Eq.(13)-(17): tau(mag) + phi(mag, rjb, vs30), ln units.

    Faithful to hazardlib including the vs30 == v1 double-subtract quirk.
    """
    C = ROWS[imt]
    if mag <= 4.5:
        tau = C['tau1']
    elif mag >= 5.5:
        tau = C['tau2']
    else:
        tau = C['tau1'] + (C['tau2'] - C['tau1']) * (mag - 4.5)
    if mag <= 4.5:
        phi = C['f1']
    elif mag >= 5.5:
        phi = C['f2']
    else:
        phi = C['f1'] + (C['f2'] - C['f1']) * (mag - 4.5)
    # Distance dependent phi (Eq. 16)
    if rjb > C['R2']:
        phi += C['DfR']
    elif rjb > C['R1']:
        phi += C['DfR'] * (math.log(rjb / C['R1']) / math.log(C['R2'] / C['R1']))
    # Site dependent phi (Eq. 15) — two separate branches, both fire at v1
    if vs30 <= CONSTS['v1']:
        phi -= C['DfV']
    if CONSTS['v1'] <= vs30 <= CONSTS['v2']:
        phi -= C['DfV'] * (math.log(CONSTS['v2'] / vs30) / math.log(CONSTS['v2'] / CONSTS['v1']))
    return tau, phi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='tools/data/gmpe-fixtures-bssa14.json')
    args = ap.parse_args()

    # Grid pinned to the model's structural boundaries: both Mh hinges
    # (5.5 pga / 6.2 pgv), R1/R2 distance breaks, the v1/v2/Vref/Vc site
    # breaks, and every style-of-faulting branch + the NoSOF case.
    mags = [4.0, 5.5, 6.2, 7.0, 8.3]
    rjbs = [0.0, 1.0, 10.0, 60.0, 110.0, 270.0, 400.0]
    vs30s = [150.0, 225.0, 300.0, 400.0, 760.0, 1500.0, 1800.0]
    rakes = [None, 0.0, 90.0, -90.0]
    variants = ['base', 'lowQ', 'highQ']
    imts = ['pga', 'pgv']

    points = []
    for imt in imts:
        for variant in variants:
            for rake in rakes:
                for mag in mags:
                    for rjb in rjbs:
                        for vs30 in vs30s:
                            points.append({
                                'imt': imt, 'variant': variant, 'mw': mag,
                                'rjbKm': rjb, 'vs30': vs30, 'rake': rake,
                                'lnA': bssa_ln(imt, variant, mag, rjb, vs30, rake),
                            })

    # Sigma is rake/variant independent: its own (imt, mag, rjb, vs30) grid.
    sigma_points = []
    for imt in imts:
        for mag in mags:
            for rjb in rjbs:
                for vs30 in vs30s:
                    tau, phi = bssa_sigma_ln(imt, mag, rjb, vs30)
                    sigma_points.append({
                        'imt': imt, 'mw': mag, 'rjbKm': rjb, 'vs30': vs30,
                        'tauLn': tau, 'phiLn': phi,
                    })

    out = {
        'schema': 'quake-sim-gmpe-fixtures-bssa14-v1',
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'source': {
            'repository': 'gem/oq-engine (master via jsDelivr)',
            'path': 'openquake/hazardlib/gsim/boore_2014.py',
            'sha256': 'c12315ff4c3d7c84ef39433348285ead4999032ec3ada0b4ccd09238cf3b4422',
            'paper': 'Boore, Stewart, Seyhan & Atkinson (2014) Earthquake Spectra 30(3) 1057-1085, Eq.(2)-(8)+(13)-(17)',
            'basis': 'scalar transcription of the hazardlib implementation (BooreEtAl2014, region=nobasin, sof=True; independent of physics.js); regenerate by re-transcribing if hazardlib updates',
        },
        'units': 'lnA: pga = ln(median PGA in g), pgv = ln(median PGV in cm/s) — hazardlib native; physics.js pgaBssa2014 converts g -> gal with 980.665',
        'consts': CONSTS,
        'rows': ROWS,
        'dc3': DC3,
        'sigmaPoints': sigma_points,
        'points': points,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=1)
        fh.write('\n')
    digest = hashlib.sha256(open(args.out, 'rb').read()).hexdigest()[:16]
    print(f'wrote {args.out}: {len(points)} points + {len(sigma_points)} sigma points, sha256[:16]={digest}')


if __name__ == '__main__':
    main()
