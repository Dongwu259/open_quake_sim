# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/) where practical.

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
