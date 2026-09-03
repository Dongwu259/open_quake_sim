# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/) where practical.

## [v6.2] — 2026-09-04

v6.2 upstream sync (quake_sim `1256af5`..`cb957c3`): experience report page, illustrated guide, validation expansion, conditional-spectrum pipeline, J-SHIS external gate + attribution. v6.2 上游同步：体验报告页、图例使用说明、验证扩容、条件谱管线、J-SHIS 外部门与归因。

### Added
- **Experience report page** (`report.html`): full-window report of the current/last simulation — prefecture table with ±1σ ranges, top stations, tsunami zones, aftershock summary, response-spectrum chart — snapshotted to localStorage at simulation end; a frozen deterministic demo snapshot renders when nothing has run. Sidebar entry pill under the app title
- **Illustrated guide page** (`guide.html`): 13-section full-window manual with pure-CSS map legends (shindo palette / P-S rings / tsunami warning grades) anchored to the renderer and rt-tsunami colors; this fork's entry is a sidebar pill (upstream carries it in the promo modal, which is stripped here)
- **`Physics.deaggregate`**: PSHA hazard deaggregation (source class × 0.5-magnitude × Rrup bins, per-bin epsilon and representative source geometries for scenario replay)
- **Conditional-spectrum time-history pipeline** (`tools/broadband/cs-pipeline.js`): UHS anchor inversion → deaggregation → multi-scenario Baker conditional spectra × Jayaram 2011 ρ → hybrid broadband sampling → Sa(T*) anchored scaling. Pre-registered gates frozen honestly: short-period shape gates FAIL as measured, 2–5 s improvement vs Brune +0.661 PASS
- **J-SHIS Y2024 external gate** (`tools/fetch-jshis-comparison.js`): 6-site hazard-curve comparison against the official NIED PshmHzcv API — the self-built model overpredicts RP475 PGV by 5.97× median [1.69..14.54]; frozen as a measurement, not a calibration input
- **PSHA overprediction attribution** (`tools/psha-attribution.js`): 8-arm decomposition — the overprediction is almost entirely carried by the two characteristic scenario sources (median 99.7% of the RP475 exceedance rate); the grid + zhao + PSV-factor endpoint lands within ~1% at sendai/tokyo; the honest next lever is a rate-calibrated segmented Nankai source, not a GMPE change
- **Strong-motion validation set expanded 13 → 19 events** (6,917 stations): the v5.6-era "modelBias does not generalize (LOEO)" conclusion is overturned as a small-sample artifact — public correction locked in tripwire tests

### Changed
- Release identity v6.2 (title / h1 / `app.title` / help section, 145 i18n keys added per language)
- Overview station markers below zoom 7 are now small plain dots (JQuake-style) instead of full-size discs

## [v6.1] — 2026-09-01

(v6.1 full sync `3be3f21`; changelog entry recorded retroactively with the v6.2 sync)

### Added
- **PSHA / UHS**: USGS ComCat self-built source model (0.25° GR grid + Nankai M9 / capital M7.3 scenario sources) with `Physics.hazardCurve` (Poisson annual exceedance, pre-registered acceptance) and `Physics.uhs`; info-page PSHA card (hazard curve, UHS canvases, 475/1000/2500/5000-year return-period selector, CSV export)
- Zhao et al. (2006) coefficient table extended to all 21 hazardlib IMTs with period-aware sigma
- **Offline broadband research pipeline** (`tools/broadband/`): SH discrete-wavenumber Green functions (Thomson–Haskell + Bouchon DW, five analytic anchors) and hybrid broadband synthesis with a Kyoshin 13-event scorecard (long-period improvement PASS, absolute-level gates fail honestly and are frozen)

## [v6.0.1] — 2026-08-26

Map interaction fixes (upstream quake_sim `737999e`…`d497ea9`). 地图交互修复。

### Fixed
- **Canvas overlay now tracks the basemap during pan/zoom** in every state: the drawn frame's view is recorded and the bitmap is glued via a translate+scale transform during gestures (idle, paused and running alike — no more one-frame rubber-banding), with a crisp redraw on settle; window resizes repaint immediately instead of leaving a blank overlay
- **Intensity circles no longer twitch while dragging at mid zooms**: the declutter grid is now earth-fixed with cell size derived from a fixed reference latitude (36°N) and zoom only — the previous live-view-derived cell size breathed with Mercator's latitude scale and re-picked cell winners every pan frame (probe-measured 6.5 flips/frame → 0 inside the viewport); winner ordering uses the static peak instead of the jittering current shindo
- **Intensity curve no longer reads "always too large"**: sampling was gated on the charts panel being visible, so opening it mid-event started the history at the current peak; per-second sampling now runs unconditionally from the sim loop (90 s rolling window)
- Finite-fault info page now surfaces the `Physics.sourceBudget` physicality flags (radiation-efficiency, supershear, rise-time and slip-spike warnings), i18n ×3

## [v6.0.0] — 2026-08-26

Research platform finale: dynamic rupture pipeline, dispersive tsunami, velocity structure. 研究平台收官：动力学破裂管线、频散海啸、速度结构（合并 v5.7 + v5.8 + v6.0 三个上游批次）。

### Highlights
- **Dynamic rupture offline pipeline** (`tools/dynamic-rupture/`): 2D velocity-stress staggered-grid FD solver with split-node TSN slip-weakening (SH and in-plane modes), validated against ten analytic anchors (radiation damping, static dislocation kernel, energy closure, self-convergence); SCEC TPV5 official parameters frozen verbatim and run as the TPV5-AP antiplane reduction; results round-trip into the main simulator through the finite-fault-v1 contract
- **`Physics.sourceBudget`**: kinematic source diagnostics (Eshelby stress drop, Orowan/Brune radiated energy, apparent stress, radiation-efficiency consistency, rupture-speed LSQ fit with supershear flag) shown as a one-line block in the finite-fault info page
- **Tsunami upgrades**: Peregrine-type Boussinesq dispersion option (far-field RMSE −36% on the exact-reference benchmark), recursive multi-level nested AMR grids, tide-level offset, per-cell Manning roughness field, and per-subfault dtopo timing — all opt-in, legacy defaults byte-identical
- **Velocity structure**: bundled JIVSM V4 layered column grid (21,131 cells) with per-column Snell travel times behind the `travelModel` switch (honest negative result on frozen S−P picks — default stays IASP91), regional Q0 and JIVSM basin factor for long-period class prediction
- **Near-field detail**: Bayless & Somerville (2013) full-equation directivity, Shahi & Baker pulse probability with Mavroeidis pulse injection into 3-component waveforms, response spectrum extended to 0.05–10 s with CSV export
- **Research engineering**: monthly frozen-data refresh with drift reports, experiment manifest with immutable content-hash IDs (`qsx1-*`), scientific tripwire tests, aggregated version report, and the METHODS / PLUGIN-CONTRACTS / REPRODUCE / CVWS-UPLOAD document set
- Ensemble intensity fields ≥100 members now run in a Web Worker (`ensembleMembers` slider)

### Fixed
- `Physics.shindoLabel` was missing — `shindoToMMI`/`shindoToEMS` threw a TypeError for fractional numeric intensities when the display scale was set to MMI or EMS-98

## [v5.6.0] — 2026-08-25

Uncertainty quantification and 1D site response. 不确定度量化与一维场地反应（R1 + R2 并版）。

### Highlights
- **GMPE logic tree**: three branches per source class with LLH-fitted weights, weighted geometric-mean aggregation with epistemic sigma; per-model τ/φ components fitted from the frozen station set
- **Monte Carlo ensemble engine**: seeded FFT circulant-embedding spatial fields (Jayaram–Baker correlation with Japan-fitted ranges), P10–P90 intensity outlines on live subdivision layers; pre-registered coverage 0.696/0.811 on the frozen 13-event set; reliability curves and Brier skill scores in the report
- **Conditional spectrum**: Jayaram et al. (2011) Japan period-pair correlation tables frozen after transcription checks; dashed CS ±1σ band on the station response-spectrum chart
- **1D equivalent-linear site response**: faithful Darendeli 2001 modulus/damping curves, Thomson–Haskell SH transfer with under-relaxed iteration, synthetic profiles from Vs30 + JIVSM bedrock depth with an empirical S/B f0(Vs30) prior — the `eqlin-1d` site model joins `predictStationMotion`
- **Data foundation**: J-SHIS 2020 Vs30 0.05° derived grid (17,848 land cells) and JIVSM V4 engineering-bedrock depth grids bundled with provenance metadata

## [v5.5.1] — 2026-08-23

Map rendering haze — final pass. 地图色雾/光晕收尾修复。

### Fixed
- **Shindo-7 "glowing circles"**: removed `drawDamageHeatmap` — its 15–30 px red discs only appeared around shindo 6+/7 stations and read as a red halo
- **Detect-mode color fog**: live subdivision fill alpha halved again (observed 0.30/0.24 → 0.20/0.15, forecast 0.22/0.16 → 0.10/0.07) with softer polygon borders; layer bisect showed this fill was the dominant veil
- **PLUM field saturation**: per-disc local-density alpha (1/(1+0.6·neighbors)); 45 km discs overlapped ~10 deep in dense near-fields and stacked into a glowing blob
- P/S ring soft under-strokes halved (crisp dashed cores kept); shaking-grid cells softened to 0.22 border / 0.07 fill

## [v5.5.0](https://github.com/Dongwu259/open_quake_sim/releases/tag/v5.5.0) — 2026-08-22

The first open-source release (MIT). 首个开源正式版。

### Highlights
- **Settings page**: browser-local Web Speech TTS (zero config, offline) or cloud/self-hosted TTS upstream (URL + API key, three key placements)
- **Manual aftershock editor** with map-picked epicenters; strong aftershocks get their own EEW detection track and tsunami simulation
- **Sharper detection mode**: FINAL magnitude re-inversion at the locked epicenter, retuned giant-event saturation lift, 5-station first bulletin
- **Tsunami engine in a Web Worker** with two-level nested AMR grids
- **Realtime EEW productization**: dedicated EEW page, S-wave countdown at the user's pinned location, per-agency bulletin chimes and agency-credited history rows, shorter TTS announcements
- Tokyo Inland M7.3 scenario preset; Nankai Trough M9.0 and Hokkaido-east-offshore M8.4 join the "Japan Sinks" chain scenario
- Map rendering haze fixes (shaking-grid blocks, subdivision fill alpha, intensity-circle decluttering at low zoom)

### Infrastructure
- Content-hash asset fingerprints (`tools/bump-versions.js`) with a pre-push gate and CI on Node 20/22
- `.gitattributes` enforces LF line endings so local and CI hashes agree
- Docs: bilingual READMEs, developer guide, finite-fault v1 contract, physics benchmarks
