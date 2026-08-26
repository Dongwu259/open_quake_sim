# 插件与版本兼容契约(v6.0)

> 6.9 平台化要求"震源、地震动、海啸、场地和数据适配器插件接口及版本
> 兼容规范"。本仓库的做法是**把既成事实的接口写成有版本号的契约**并
> 配回归守卫,而不是另起一套新插件框架。任何第三方实现按下述 schema
> 产出即可被主程序消费;schema 破坏性变更必须升主版本号并保留一版
> 兼容读取。

## 1. 震源适配器:`quake-sim-finite-fault-v1`

- 契约:`public/finite-fault.js`(`FiniteFault.parse`,≤20,000 patches;
  中心+走向/倾角/长度/宽度 或四角坐标;slipM/momentNm 至少其一;
  rigidityGPa 默认 30;ruptureTime/riseTime 可选,STF ∈ {half-cosine,
  triangle, brune, boxcar})。
- 消费方:GMPE 预报(逐 patch Rrup)、海啸 dtopo、动画、3D 视图。
- 生产方:SRCMOD FSP / GeoJSON / 标准 JSON / `tools/dynamic-rupture/
  export-finite-fault.js`(R6 回导,A9 测试守卫 round-trip)。
- 兼容规则:schema 字符串即版本;新增可选字段=次版本,删改必填字段=
  主版本+迁移。

## 2. 数据适配器:research manifest(public/data-catalog.js)

- 每个数据角色(terrain/coastal/vs30/strong-motion/tsunami-observations)
  声明资源路径、SHA-256、许可、质量等级与 **角色解锁状态**;运行时
  无静默回退(缺文件=显式降级标记)。当前 4/5 角色认证,tsunami-
  observations 诚实降级(R5-6 数据策展网络受阻)。
- 兼容规则:角色新增=次版本;已解锁角色不得回退为未认证(测试守卫)。

## 3. 物理内核:Physics UMD API

- `public/physics.js` 为纯函数 UMD(浏览器/Node 同体),全部函数显式
  传参、无全局状态;`tests/` 直接 require。破坏性签名变更需在
  AGENTS.md 版本表记录并同步 open 镜像。
- 新增可调参数必须走 `config.js` + `index.html` `data-cfg` 行 +
  config.test.js 覆盖守卫。

## 4. 海啸求解器选项面(算子级"插件")

- `Physics.createNonlinearTsunamiSolver(grid, source, options)`:
  options 的可选键(dispersion='boussinesq'|none、tideOffsetM、
  manningField、dtopoTiming='per-patch'|'cumulative'、nested grids[])
  即求解器能力面;每键有独立测试与默认行为字节兼容保证(默认值改动
  需重跑 Playwright 精度门)。

## 5. 实验工件:`quake-sim-dynamic-rupture-report-v1` 等冻结 schema

- `tools/data/*.json` 各报告自带 schema 字符串;`experiment-manifest.json`
  以内容哈希(`qsx1-<sha256[:16]>`)锚定不可变身份,`tests/
  experiment-manifest.test.js` 守卫新鲜度——改报告必须 consciously
  重冻清单。

## 6. 暂不提供(诚实边界)

- 服务端任务 API/模型热插拔运行时(6.9 远期项):服务器为用户部署的
  零依赖静态 + API 服务,任务编排属 v6.x+ 评估项;
- 外部审查流程(6.9 验收项"外部技术审查"):`docs/REPRODUCE.md` 提供
  独立环境端到端复现的全部材料,审查本身是社区动作。
