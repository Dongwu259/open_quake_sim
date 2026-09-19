# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/) where practical.

## [Unreleased] — 县级速报 + 地图涂色 + 烈度尺度快捷切换

同步自上游 quake_sim（v6.4 区域面积批）：

### Added
- **加州县级边界包**：USGS cb_2018 20m 公版 58 县（71KB）——全球模式下的都道府县等价物
- **县级震度速报与地图涂色**：`_areaLayerSource()` 三层优先（区域县 > JMA 细分区 > 都道府县）——区域模式Live 涂色、县级 GMPE 预测（质心无关引擎）与观测聚合（turf 点在多边形）、「区域预测震度」表（县 / ±1σ / 长周期列，与都道府县表同构）；无面积包的区域诚实隐藏
- **烈度尺度快捷切换**：显示偏好面板新增「显示烈度尺度」下拉（日本气象厅震度 / MMI / EMS-98 / 中国烈度），与高级面板同键联动

### Fixed
- 重复设置行（快捷切换 vs 高级面板）数值互相同步
- 区域预报卡标题在回到日本模式后正确还原
 — 资源懒加载 + 加州 Vs30 真实网格

同步自上游 quake_sim（v6.4 懒加载批 + 加州 Vs30 批）：

### Added
- **加州 Vs30 真实网格**：Yong et al. (2014, BSSA 104(5), USGS public domain) 7.5 角秒加州 Vs30 图重采样为 0.025° 包——6,232 个真实台站中 94.1% 直接取得真实场地 Vs30（双线性采样，水域/出界格点诚实回退 500 m/s 估计并计数标注），台站弹窗显示数据来源
- **懒加载基建**：`_loadScript` + `LAZY_SCRIPTS` 版本清单 + `_ensureScript` 按需加载器

### Changed
- **首屏脚本瘦身 ~775KB**：observed-fault-models(708KB)/finite-fault/waveform-analysis/moment-tensor/waveform-data/strong-motion-data/waveforms 移出启动路径——预设断层模型、有限断层/矩张量/强震动导入、波形分析等入口按需加载（模块缺席时诚实降级，绝不静默假数据）；Service Worker 预缓存同步瘦身（首次取用后运行时缓存，离线契约保持）
- reference-backend.js 不再是页面脚本（仅 node 测试使用）
 — 全球真实台站测站化 + 12级烈度播报

同步自上游 quake_sim（全球真实台站+12级烈度批）：

### Fixed
- **「加州测站没反应」根因**：waveCanvas 卡在 0×0 时 drawImage 层缓存直接抛异常并杀死整帧渲染——drawFrame 现在逐层隔离（safeDraw）并在开头自愈画布尺寸；板块边界缓存键补视图维度（旧键会把日本视图的线原样贴到其他区域）

### Added
- **真实台站成为模拟测站**：加州 6,232 个 FDSN 真实台站载入后直接作为模拟接收点（站名 NET.CODE + 站址；Vs30 以 500 m/s 估计并如实标注）
- **12级烈度（CSIS）模式**：显示尺度新增「中国烈度」——标签/图例/台站数字图标按 12 级换算（JMA 震度对齐近似，7 级上限 XI，公开记录）
- **12级播报**：Intensity1–12 提示音（懒加载，首次播放弹出下载提示）+ 最终速报/报告页「最大烈度 N 度」句子走浏览器 TTS
- 音频懒加载：中英语言包 ~130 个播报片段不再启动预热，改为首次播放按需加载
 — 全球真实台站（显示层）

同步自上游 quake_sim（全球真实台站批）：

### Added
- **全球模式真实台站层**：勾选「显示所有测站」时以青绿小三角显示 6,232 个真实台站元数据（SCEDC 5,893 / NCEDC 337 / EarthScope 全球骨干 2），仅展示、不参与模拟；点击弹出台站元数据，侧栏显示计数注记
- 全球模式启用时复用启动进度条（区域包 → 世界海岸线 → 测站切换 → 完成）
- tools/fetch-region-stations.js：FDSN station-text 三源抓取工具（quake-sim-region-stations-v1 冻结包，provenance 记录逐源计数）
- tests/region-stations.test.js：包契约测试（provenance 守恒/bbox/去重/锚点台站）

## [6.4.0] — 2026-09-19 全球区域试点 + v6.4 身份

同步自上游 quake_sim（dfa30b8）：

### Added
- **全球模式（测试）**：模拟功能列表勾选开启——懒加载世界底图（OSM/CARTO/Esri 三源自动探测 + 运行时看门狗回退，全部不可达时保留日本离线底图）与加州试点区域包（50 城市台站 + 1906/1989/1994/1971 四历史预设，USGS ComCat 参数硬编码）
- **quake-sim-region-pack-v1** 区域包架构：台站/预设/边界一个 JSON 包，懒加载可回滚；0.5° 台站格网从台站集合推导（日本路径字节不变）；都道府县预报表全球模式门控
- 语言体验：首访按浏览器语言自动选择（日/中/英）；侧栏顶部常驻语言切换器；标签页标题随界面语言

### Changed
- 应用与元数据明确 Japan 限定（Japan Earthquake Simulator / 日本地震模拟器）
- **fitBounds 替代 flyToBounds**（捆绑 Leaflet 的 fly 动画从不前进——已知问题，rtFlyJapan 同病）

### 诚实边界
- 加州强度模型未标定（日本标定模型直接适用并如实标注）；海啸暂不支持；全球 EEW 无开放源

## [6.3.3] — 2026-09-18 CS 宽频带研究线闭卷同步

同步自上游 quake_sim（CS v4 执行 → v5–v8 归因收官，master 3478f47e）：

### 条件谱宽频带研究线闭卷
- **CS v4 全门阵列执行**：30 分片 quad-double P-SV 臂（~2.2 天墙钟）跑完，三个形状带门全 FAIL（P-SV 0.794/0.398/0.727 vs SH-only 0.776/0.432/0.574）——P-SV 补全假设否证，生产线保持 SH-only；冻结报告 `tools/data/cs-pipeline-v4-report.json`
- **归因弧线 v5→v8**：目标审计 PASS（max μC 偏差 0.0047）；应力杠杆 DEAD（S\*=0）；台柱交换 SOURCE-OWNED（0.198）；**v7 配置对齐重测**（13 真事件 × ~700 台站，158.8 min）：alignedDs(0.2s)=+0.02 vs legacy −0.238 → CONFIG-OWNED；**v8 逐类 κ 重校准被预登记情景非回退门判死**（真事件最优与情景门最优反号 + 1s 锚-缝耦合）。形状门终版角色=合成-vs-GMPE 一致性监视器，五条单参数治愈全部实测否证、各有 tripwire 锁定

### 文档与验证
- `docs/SCIENTIFIC-REPORT.md` P-SV 终章（v12→终局弧线）+ 状态账本重判；`PHYSICS_BENCHMARKS.md` 扩容（105 文件 / 1,142 测试全绿）
- 实验清单 manifest 79 条冻结工件

## [Unreleased] — 2026-09-04 v6.2 功能批同步（实时波形 · 波形分析 · 断层系统升级 · 动力学破裂管线）

同步自上游 quake_sim（cf6ad9e→cc8e3af 五批）：

### 实时监测
- **实时多台站活波形面板（RTWave）**：4 个环绕日本的开放 GSN 台站（IU MAJO 松代 / YSS 南萨哈林斯克 / INCN 仁川 / TATO 台湾坪林）实时迹线，30 s 刷新，5/10/20 分钟窗口，EEW 跟踪事件叠加 P/S 预计到时刻度；仪器原始计数（未标定）诚实标注
- 服务端 `/api/waveform/live` 代理 + **纯 JS miniSEED v2.4 STEIM1/2 解码器**（libmseed 权威语义移植，含 5×6/6×5/7×4 密集模式；三方验证 = 官方夹具 + ObsPy 逐样本零失配 + 四站活流）

### 波形分析
- **报告页三站波形分析节**：最强 PGA / 最近 / 中等距离自动选站，滑移/能量/周期指标 + 矩速率曲线 + 波形 PGA 反演震级 vs 设定震级
- **信息页波形分析工具**：台站选择 → PGA/PGV/PGD/Arias/CAV/D5-95/卓越周期/视拐角 + 震级反演对比

### 断层系统
- **von Kármán 滑移谱**（Mai & Beroza 2002 型各向异性，H=0.75，网格无关）+ 浅部滑移亏损旋钮（矩守恒）
- **断层破裂详情卡**：断层面剖面（沿走向×深度，滑移/破裂时间着色，成核星，运行中动画）+ 矩速率/累积矩图 + 9 行统计
- **分段弯折断层**：侧栏路径编辑器（地图点选 → 共节点段平面链，连续滑移场跨弯折，3D 走时）；诚实限制：平面段近似深部弯折间隙
- **铲式几何**（faultListricDip 0–60°，默认 0 字节兼容）
- **动力学破裂管线化**：`tools/dynamic-rupture/run-scenario.js` 场景 CLI（导出前过应用自带验证器）+ 2 个捆绑模型（SH 走滑 M7.45 / PSV 倾滑 M6.71）+ 导入卡一键加载

 — 2026-09-04 science refresh

Upstream science batch (quake_sim `6c82057`..`be463ba`), no app-version bump: segmented Nankai source model + CS shape-gate diagnosis. 上游科学批次：分段南海震源模型 + 条件谱形状门诊断。

### Changed
- **PSHA source model v2 (segmented Nankai)**: the single full-trough M9 at 0.0462/yr — which took the ERC *time-dependent* 30-yr probability as a Poisson rate — is rebuilt as three rupture modes (full M8.9 / east Tokai+Tonankai M8.2 / west Tonankai+Nankai M8.3) at Poisson long-run rates from the ERC plain-interval BPT set (1/117 yr total, 4/1/1 mode split over 1361–1946; Poisson P30 = 22.7% inside the published 20–50% band). Segment geometry reuses the bundled 4-segment synthetic model's own polyline (2013 HERP domains)
- **J-SHIS external gate re-frozen**: RP475 PGV ours/J-SHIS median **5.97x → 1.83x** [1.458..4.227]; mid-band log-rate ratios flip negative at Kochi/Nagoya — the expected Poisson-long-run vs BPT-conditional signature; attribution re-frozen (sendai scenario share 99.7% → 3.6%; the v1 all-sites 99.7% pathology is gone); CS pipeline re-frozen on v2 anchors (shape gates still FAIL — anchors moved, shapes did not)

### Added
- **CS shape-gate diagnosis** (`tools/broadband/cs-diagnose.js`): the 0.1 s overshoot is 100% on the Boore HF side (shipped ≡ HF-only arm at every case), ~0.186 of it from the frozen κ0=0.02 choice, and in 4/6 cases the MS-CS mixture target sits below every contributing-bin median envelope (structurally unreachable); the Kochi 2–4 s deficit excludes the JIVSM column (half-space Δ ≤ 0.08) and Q (Δ ≤ 0.005) — attributed to the 1D SH kernel vs zhao's empirically amplified long-period medians. Repair directions registered, not executed

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
