# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/) where practical.

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
