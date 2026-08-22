# 开发者指南

> **English summary**: this is the developer guide for open_quake_sim — architecture, repository layout, testing, the content-hash version-fingerprint rules, and how-to recipes (presets, i18n, sounds, data regeneration). It is written in Chinese; the README has a full [English version](../README_EN.md).

## 1. 架构总览

- **`server.js`**：零依赖 Node.js（≥18）静态文件服务器 + 反向代理 + SSE 实时数据管道。职责：静态资源（`public/` 与 `sounds/`）、安全头/限流/gzip、USGS 与目录代理、P2P/Wolfx WebSocket 汇聚（`/api/p2pquake/stream`）、NIED 強震モニタ轮询（`/api/kmoni/*`）、SSE 录制与回放（`/api/replay/*`，数据落盘 `recordings/`）、NTP/geoIP 代理、TTS 代理（`/api/tts/synthesize`）、本地设置（`/api/settings`）。
- **`public/`**：无框架前端，全局变量状态管理，`app.js` 为主编排（约一万行）。物理引擎 `physics.js` 是纯函数 UMD 模块（浏览器与 node:test 双端可用）。渲染、信息面板、实时监测各自成模块（`renderer.js`、`info-panel.js`、`rt-*.js`）。
- **Web Worker**：海啸 NLSWE 求解器（`tsunami-worker.js` + `tsunami-solver-host.js` 宿主代理，进程内回退逐位一致）与 kmoni 计算核（`rt-kmoni-worker.js`）都在后台线程。
- **`tools/`**：数据生成/校验/标定脚本（node 与 python 混合）；`tools/data/` 存放标定报告与断层模型源文件。
- **`tests/`**：`node:test` 单元/集成测试（服务器测试直接 require `server.js` 并劫持 `http.createServer`，随机端口起真实实例）。

## 2. 仓库布局

```
open_quake_sim/
├── server.js              # 服务器（唯一进程）
├── public/                # 前端全部资产（index.html 入口）
│   ├── geojson/           # 台站/断层/边界/海深/标定数据
│   ├── leaflet/  turf/    # 本地化的前端依赖（无 CDN）
│   └── sw.js              # PWA Service Worker
├── sounds/                # 音效（jp/en/zh），由 /sounds/ 路由服务
├── tools/                 # 构建/校验/标定/抓取脚本
├── tests/                 # node:test 测试套件
├── docs/                  # 本文档与其他技术文档
└── recordings/            # 运行时生成的 SSE 录制（gitignore）
```

## 3. 开发环境

```bash
npm install        # 安装依赖（会自动安装 pre-push 钩子）
node server.js     # http://localhost:3000
```

行尾约定：仓库用 `.gitattributes` 强制 **LF**（`eol=lf`）。`tools/bump-versions.js` 对工作副本字节算哈希，CRLF 会导致本地哈希与 CI 不一致，请勿绕过。

## 4. 测试与发布校验

| 命令 | 内容 |
|---|---|
| `npm test` | 全部 `tests/*.test.js` + 5 个 validate 工具（physics / nlswe / tsunami-alerts / tsunami-observations / focal） |
| `node tools/validate-release.js` | 发布门槛：版本资源存在性、PWA 清单与预缓存、研究数据目录、i18n 三语键完整性、可访问性 |
| `node tools/bump-versions.js --check` | 版本指纹门禁（pre-push 钩子与 CI 都强制执行） |
| `npm run validate:audio` | 音效资产完整性 |
| `npm run validate:accuracy` | GMPE 精度记分卡（对 observed.json 的 11 个预设事件） |

CI（GitHub Actions，Node 20/22 矩阵）跑的就是上面这条链。

## 5. ⚠️ 版本指纹规则（最容易翻车的一条）

静态资源缓存策略（`server.js cacheHeader()`）：HTML `no-cache`；**JS/CSS `max-age=31536000, immutable`（一年）**；JSON 1 小时；图片/音频 24 小时。

**修改 `public/` 任何文件后必须运行 `node tools/bump-versions.js`**。它把 `index.html` 里每个 `?v=` 重写为文件内容 SHA-1 的前 6 位，并从 `sw.js` 内容派生 Service Worker 版本（同时同步 `app.js` 的 `register('sw.js?v=N')` 与 `index.html` 的 `data-sw` 标记——三者必须一致，`validate-release` 会断言）。忘记 bump = 用户浏览器一年内都用旧代码。

## 6. 常见配方

**添加/修改地震预设**：编辑 `public/geojson/observed.json`（带 JMA 实测震度的事件用于精度验证）或 `app.js` 内的预设定义；`tests/presets.test.js` 与 `validate-accuracy` 会校验结构。预设若带有限断层模型，见 `docs/FINITE_FAULT_FORMAT.md` 与 `tools/build-fault-models.js`。

**添加界面文案（i18n）**：在 `public/i18n.js` 的 **ja/en/zh 三个块都**加同名键（`validate-release` 检查三语并集一致）；HTML 里用 `data-i18n="key"`（占位符用 `data-i18n-ph`，aria 用 `data-i18n-aria`），JS 里用 `t('key')`。帮助页词条在 `public/i18n-help.js`（懒加载，其 `?v=` 哈希在 `i18n.js` 里手工维护，改完要同步）。

**添加音效**：放仓库根 `sounds/{jp,en,zh}/`（**不是** `public/sounds/`——那个目录不被服务器路由），生成器参考 `tools/gen-bulletin-sounds.js` / `tools/generate-alert-sounds.js`，改完跑 `npm run validate:audio`。

**调物理参数默认值**：`public/config.js`（`cfgGet/cfgSet` + localStorage 持久化）。改默认值会影响精度基线，必须重跑 `npm run validate:accuracy` 确认记分卡不回退。

**再生成数据资产**：GSI 区域 DEM（`tools/fetch-gsi-dem.js` + `blend-gsi-gebco.js`）、Vs30（`tools/build_vs30.py`）、强震观测（`tools/fetch-strong-motion-obs.js`）、K-NET 波形包（`tools/fetch-kyoshin-waveforms.js`，需 NIED 账号）、JMA 细分区域（`tools/build-jma-subareas.py`）、EEW 区域（`tools/build-eew-areas.py`）。

## 7. 提交与分支约定

- 提交信息：`Feature:` / `Fix:` 单行英文摘要 + 正文要点。
- 单分支 `master`；push 前钩子会执行 `bump-versions --check`。
- 物理数值改动需在提交信息中附验证结果（精度记分卡/基准测试数值）。
