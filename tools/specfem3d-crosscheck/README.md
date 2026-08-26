# SPECFEM3D crosscheck assets (v5.7 R3-4)

**Offline external comparison only — nothing here runs in the browser or in CI.**
Purpose: give a third-party 3-D wave-propagation code (SPECFEM3D Cartesian/
Globe, SW4, etc.) exactly the inputs our 1-D travel/wave engine sees, so the
resulting synthetic seismograms can be compared against (a) our predicted
P/S travel times and (b) the frozen observed S−P picks.

## Case layout (`case-kumamoto2016/`)

| File | Contents |
|------|----------|
| `CMTSOLUTION` | 2016-04-16 Kumamoto M7.3, strike/dip/rake → moment tensor (Aki & Richards DC, self-checked: zero trace, ‖M‖ = √2·M0), Nm→dyne-cm |
| `STATIONS` | 60 K-NET/KiK-net stations of the frozen waveform package (NIED, DOI 10.17598/NIED.0004) |
| `model_1d.txt` | The SAME 1-D model our engine composes: JIVSM V4 column at the source region (sub-50 m block-mean layers merged, travel-time weighted) + IASP91 continuation (depth km, Vp, Vs, ρ) |
| `expected.json` | Our IASP91 and JIVSM-composed P/S times per station + observed S−P picks (from `tools/data/travel-time-picks.json`) |

Regenerate with `node tools/export-specfem-case.js`.

## Comparison protocol (run on your own SPECFEM3D install)

1. Build a mesh over Kyushu (≥ 31.5–34.5 N, 129.5–132.5 E) sampling
   `model_1d.txt`; free surface at 0 km.
2. Simulate ≥ 300 s; bandpass 0.05–5 Hz.
3. Pick P/S onsets on the synthetics the same way our validator does
   (trailing STA/LTA, see `tools/validate-travel-times.js`).
4. Compare against `expected.json`:
   - `pIasp91S/pJivsmS` — onset times of the synthetics should sit within
     picker tolerance of BOTH (they differ <0.5 s at most stations; sites on
     deep sediment columns differ most — that divergence is the point).
   - `observedSpSec` — the observed S−P differentials; a 3-D code that
     reproduces them better than the 1-D columns quantifies the 1-D
     approximation error, which is what R3 exists to bound.

## Honest scope

Our engine is a 1-D Snell-integral travel model + stochastic waveforms; the
3-D code is the reference. This case exists to MEASURE that gap, not to claim
equivalence. Results of any actual comparison should be reported back into
`PHYSICS_BENCHMARKS.md` verbatim, favorable or not.
