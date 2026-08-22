# 常见问题（FAQ）

> **English summary**: troubleshooting for install/run (port conflicts, node version), TTS voice issues (engine choice, missing voices, upstream), realtime monitoring connectivity, missing optional data files (gsi/vs30 404s are normal), accuracy expectations, offline use, and how to report bugs. See the [English README](../README_EN.md) for setup basics.

## 安装与运行

**Q：启动报 `EADDRINUSE: address already in use`？**
A：3000 端口被占用——多半是已经有一个实例在跑（比如重复启动或之前的没关）。关掉旧实例，或换端口：`PORT=3001 node server.js`。

**Q：`npm install` 很慢或失败？**
A：依赖只有 leaflet/turf/ws 等几个包。网络环境差时换镜像：`npm install --registry=https://registry.npmmirror.com`。

**Q：支持哪些 Node 版本？**
A：Node.js ≥ 18（CI 在 20/22 上验证）。不支持 16 及以下。

**Q：可以用 npm 包方式安装吗？**
A：可以。发布后：`npx open_quake_sim` 直接运行，或 `npm install -g open_quake_sim` 后执行 `quake-sim`。首次下载约 35 MB（含全部离线音效与地图数据）。

## TTS 语音

**Q：语音播报没有声音？**
按顺序排查：
1. 侧栏「设置」里引擎是哪个？默认是**浏览器本地**——它用操作系统的语音，无需网络。
2. 浏览器是否允许发声？Chrome/Edge 首次需要一次用户交互（点一下页面任意处）后才解锁音频。
3. 浏览器本地引擎没声音：打开设置页点「试听」看状态提示。系统缺少日语语音时会回退到系统默认语音；部分精简版 Windows/Linux 没有任何语音包，需安装语音或改用服务器引擎。
4. 服务器引擎没声音：说明没有可用 TTS 上游。在设置页填自建/云端 TTS 上游地址（和 API Key），或改回浏览器本地引擎。
5. 检查侧栏音效模式是否在 jp（SREV 语音播报只在日语模式下启用）且音量不为 0。

**Q：云 TTS 怎么配？**
A：设置页 → 服务器代理 → 填上游 URL +（如需要）API Key，选择 key 的传递方式（`?key=` 参数 / `Authorization: Bearer` / `X-API-Key` 请求头）。key 只存在你本机的 `settings.json`，任何访问者都看不到。

## 实时监测

**Q：开启实时监测后没有数据/一直转圈？**
A：实时数据源是 P2PQuake、Wolfx、NIED 強震モニタ等**外部公共服务**。检查：(1) 你的网络能否访问这些（部分网络环境需要代理）；(2) 浏览器控制台有没有 WebSocket 报错；(3) 侧栏顶部数据源状态点（`/health` 面板）看每个源的连接状态。USGS 历史列表能加载说明外网基本通畅。

**Q：为什么没有 EEW 波圈？**
A：EEW 只在日本发生足够大的地震时由 JMA 发布——日本无震时没有 EEW 是**正常**的。想体验可以点「EEW 演示（测试）」。

**Q：页面报 `/geojson/gsi/...` 或 `vs30.json` 404？**
A：这些是**可选**的大体积数据文件，不随 git/npm 分发，404 属正常现象，功能会自动降级（回退 GEBCO 全球网格/默认场地）。需要时按 README「区域地形数据」自行生成。

## 精度与使用边界

**Q：模拟震度和真实地震有偏差？**
A：GMPE（地震动衰减关系）本身就是统计模型，单场地震±0.5–1 个震度档的偏差是物理常态；软件内置了 2,626 个实测台站的标定表，但无法消除模型不确定性。**结果仅供科研教育，不能用于防灾决策。**

**Q：能离线用吗？**
A：可以。首次加载后 Service Worker 会缓存应用外壳（地图、引擎、音效）；底图瓦片可用 `node download-tiles.js` 预下载。实时监测功能除外（本来就需要网络）。

**Q：手机上能用吗？**
A：可以，有移动端适配（底部抽屉式控制面板、横屏优化）。桌面端体验更完整。

## 其他

**Q：`recordings/` 目录越来越大？**
A：实时监测的 SSE 录制（用于回放功能），默认保留 3 天自动滚动清理。不需要回放可直接删除整个目录，不影响运行。

**Q：怎么报 Bug / 提需求？**
A：到 [GitHub Issues](https://github.com/Dongwu259/open_quake_sim/issues) 选对应模板，附浏览器版本、控制台报错和复现步骤。PR 见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

**Q：有官网/在线版吗？**
A：作者官网 [dwfileshare.top](https://dwfileshare.top)。本仓库是自托管开源版，功能以仓库 README 为准。
