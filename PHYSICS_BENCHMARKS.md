# v5.2 物理参考与数值基准

更新日期：2026-08-24  
参考后端：`quake-sim-float64-cpu-reference-v1`（IEEE-754 binary64）

## 可复现入口

```bash
npm run validate:physics
```

冻结输入和容差位于 `public/geojson/physics_benchmarks.json`。DC3D 原始公式来自 Okada (1992) 的 `DC3D.f`（okada_wrapper 24.6.15，MIT）；垂向分量使用 GeoClaw 5.14.0 的 `SubFault.okada` 独立复算。

## 当前结果

| 模块 | 基准 | 结果 | 验收 |
|---|---|---:|---:|
| 地震矩 | Mw 6.5 / 7.5 / 8.5 / 9.1 子断层求和 | 相对误差不超过 `2e-14` | 通过 |
| DC3D | 倾角 20°、混合位错、垂直走滑 3 例 | 19 项参考检查通过 | 通过 |
| DC3D / GeoClaw | 倾角 20° 点位垂向位移 | 两者均为 `0.071428112228921 m` | 通过 |
| 分层走时 | 100 km 水平距、30 km 深 | P `17.0652457821 s`；S `30.0641670254 s` | 通过 |
| JMA 三分量 | 100 Hz 三正弦冻结记录 | 计测震度 `4.9930095148` | 通过 |
| 反应谱 | 100 gal、1 Hz、5% 阻尼 | PSA(0.5/1/2 s) = `161.786/954.738/80.864 gal` | 通过 |
| 湖面静止 | 变水深 300 s | `L∞ = 1.184e-14` | 通过 |
| Ritter 溃坝 | 101/201/401 网格 | L1 `0.1059/0.0761/0.0512 m` | 通过 |
| 溃坝湿干前缘 | 101/201/401 网格 Ritter 解 | L1 `0.1059/0.0761/0.0512 m`，观测阶 `0.477/0.570` | 通过（一阶路径，2026-08-17 更新） |
| **湿底溃坝（MUSCL 路径）** | hL=100/hR=50 vs Stoker (1957) 中间态精确解 `h*=72.692` | L1 `2.66e-1/5.37e-2/2.10e-2 m`，观测阶 `2.31/1.35` | 通过（二阶 MUSCL 重建首次有收敛证据） |
| **Synolakis (1987) 爬坡** | d=50 m、a/d=0.03、1:19.85 坡，解析 `R=2.831√cotβ·d·(a/d)^{5/4}=7.874 m` | 直接爬高 4.905 m（dx=12 m）/ 5.880 m（dx=6 m），比率 0.62→0.75 随加密上升 | 通过（一阶湿干前缘，收敛方向正确） |
| **海啸预报区混淆矩阵** | 3 事件 16 预报区，物理基线（无保守因子） | 命中 7、漏报 9、误报 0；命中率 43.8% | 基线落盘（`tools/data/tsunami-scorecard-report.json`，嵌套网格修复的追踪目标） |
| **ETAS/大森-宇津校准 + 产率定律修复** | 2016 熊本 / 2024 能登 / 2011 东日本（USGS ComCat，90 天） | b `0.812/0.823/1.224`（与文献一致）；p `1.10/1.10/1.06`（t≥1 天完备窗）；产率斜率 log10N/Mw=`0.809`。**修复**：`physics.js` 双产率定律已改用 `10^0.809(Mw−5)` 标度（原 `2^(Mw−5)` 斜率 0.301，每级震级低估 ~2.7×）；ETAS 分支 α 默认改为校准自然对数值 `1.86`（config `etasAlpha`，滑条上限放宽到 2.5） | 校准报告落盘（`tools/data/etas-calibration-report.json`，LSQ 拟合线 vs 实测 `47/43、118/131、2323/2266`；显示目录仍由 catalogCap=200 封顶） |
| 孤立波爬坡 | 10 m 水深、1 m 入射波 | 爬高 `0.364 m`，淹没 `0.040 km` | 通过 |
| 开放边界 | 向外传播高斯脉冲 | 残留 `1.163e-4 m`；壁面反射 `0.2696 m` | 通过 |
| 质量守恒 | 401 网格封闭溃坝 | 相对残差 `8.04e-9` | 通过 |
| DC3D 远场聚合 | Mw9、200×200 网格、450 km 切换 | RMS `0.00125 m`，相对 L2 `0.413%`，最大误差 `0.0262 m` | 通过 |
| **GMPE：Zhao 2006 跨实现数值断言** | 2,400 网格点（3 构造类 × PGA/SA1.0s × M5.5-8.5 × R10-250 km × 深 12/35/80 km × Vs30 5 档 × rake 0/90）对照 openquake.hazardlib 标量转录参考 | 系数表逐项相等；最大 \|ΔlnA\| `2.7e-15`；τ/φ 与 hazardlib sigma/tauC 逐类相等 | 通过（R0-3，`tests/gmpe-benchmarks.test.js`） |
| **GMPE：Kanno 2006 冻结回归锁** | 浅/深源 PGA/PGV 8 个代表点 | 与 2026-08-24 冻结值一致（1e-9 相对容差） | 通过（回归锁，非独立参考——开源界无 Kanno2006 独立实现） |
| **标定 LOEO 留一重拟合（R0-4）** | modelBias 层逐事件剔除→重拟合→held-out 强度 RMS（zhao2006 4 事件 1,925 站 / si-midorikawa 2 事件 701 站） | zhao2006 held-out 0.931 vs 未修正 0.899；si-midorikawa 0.78 vs 0.631 —— **两模型 held-out 均劣于不修正** | ⚠️ 反向证据落盘（`tools/data/model-bias-loeo-report.json`）：现行逐距离档修正不能泛化到未见事件，in-sample 改善无 out-of-sample 支撑 |

## GMPE：Zhao et al. (2006) 忠实实现（2026-08-17）

`Physics.pgaZhao2006`/`pgvZhao2006` 已从"本地重拟合简化式"替换为论文 Eq.(1) p.901 + Eq.(5) p.909 的忠实自然对数形式（系数转录自论文 Tables 4/5/6，并按 openquake.hazardlib.gsim.zhao_2006 的实现核对结构）：

- 距离项 `b·R − ln(R + c·exp(d·M))`——**饱和机制内建于 c·e^(dM) 伪深度**（M7≈11 km，M9.1≈102 km），移除了旧的外挂震级压缩 `gmpeSatMag`；
- 深度项 `[h≥15 km]·e·min(h−15,110)`（旧实现无条件应用 depth−15）；
- 逆断层样式项 `FR=0.251`（45°<rake<135°，仅地壳源；可选参数）；
- interface/slab 类别项（PGA 处 SI=QI=WI=0，即 interface≡crustal；slab 含 `SS+SSL·lnR` 与 M′=6.5 二次修正）；
- 场地类按论文 Table 2 边界（>1100/600-1100/300-600/200-300/≤200 m/s）；
- σ 拆分为 per-class τ/φ（0.303-0.321 / 0.604，ln 单位）；
- PGV 无论文模型，用论文 SA(1.0 s) 行经伪速度换算 `PGV≈SA/(2π)`（声明为 ±25% 工程近似）。

**对冻结 K-NET/KiK-net 站点包（6 事件 2,626 站）的原始（无补丁）残差**：真 Rrup（捆绑有限断层角点）总体 PGA bias **+0.11**（目标 <0.15，旧实现修补丁前 +0.58）；点源震中距约定 −0.25，`<100 km 桶无偏（−0.01~−0.03）`，>100 km 偏差为点源距离对巨型破裂的固有量（重拟 modelBias 后总体 iBias 0.000 / iRms 0.739）。残差结构与 mega-thrust 外推的已知行为一致（tohoku/tokachi/hyuganada 过预测 0.36-0.45、fukushima2022 slab 欠预测 0.53），见 `tools/probe-zhao2006-faithful.js`。19 事件 JMA 独立集：bias +0.199→**+0.043**，RMS 0.724→0.776（门禁通过）。

## GMPE 数值基准：hazardlib 交叉断言（R0-3，2026-08-24）

`tests/gmpe-benchmarks.test.js` 将 `Physics.zhao2006LnA` 与 `tools/gen-gmpe-fixtures.py` 生成的冻结参考逐点比对。参考实现是 **openquake.hazardlib 官方 `zhao_2006.py` 的标量转录**（gem/oq-engine master 经 jsDelivr 获取，sha256 `3322dd09…c88ec9`，完整哈希与来源记录在 `tools/data/gmpe-fixtures-zhao2006.json`）——与 physics.js 相互独立，因此同时锁定系数转录和公式结构（Eq.(1) p.901 + Eq.(5) p.909：a·M + b·R − ln(R+c·e^(dM)) + [h≥15]·e·(h−15) + FR(rake 45°-135°, 仅地壳源) + 场地档 + 类别二次项；slab 另有 SS + SSL·lnR 与 PS·(M−6.5) 线性项）。三项断言：

1. **系数表逐项相等**——hazardlib 转录值同时内嵌在测试与 fixture 中，两侧都被校验（防止 fixture 被篡改后静默放行错误系数）；
2. **2,400 网格点中位数**——最大 |ΔlnA| 2.7e-15（浮点噪声级），容差 1e-9；
3. **σ 拆分**——`ZHAO2006_SIGMA`（log10 存储）×ln10 后与 hazardlib 的 phi=sigma（共享 0.604）、tau（逐类 0.303/0.308/0.321）相等。

Kanno 2006 无开源独立实现，采用 8 点冻结回归锁（ PGA/PGV × 浅/深源），属防漂移措施而非外部验证。PGV 的 SA(1.0)/2π 伪速度换算是本仓库的工程近似（±25%），不在 hazardlib 断言范围内。

再生成方式：`python tools/gen-gmpe-fixtures.py`（纯 stdlib；若更新 hazardlib 转录源，需同步更新脚本内嵌系数表、sha256 与测试内嵌值）。沙箱环境 pip 安装 openquake.hazardlib 不可用时，此转录路线即替代方案。

### 标定泛化性（LOEO，R0-4，2026-08-24）

`node tools/scorecard-strong-motion.js --loeo-model-bias` 与 `node tools/calibrate-gmpe.js --loeo` 对两层标定做留一事件重拟合：每折用其余事件重拟合修正（MIN_EVENTS/距离档规则原样复用），给留出事件打分。**结果（冻结 6 事件）**：modelBias 层两个模型的 held-out 强度 RMS 均高于完全不修正（zhao2006 0.899→0.931、si-midorikawa 0.631→0.780；最差折 hyuganada2024 0.663→1.379）——修正把逐事件特性当成了系统偏差。结论：现行 modelBias 只应视为对这 6 个冻结事件的经验对齐，不能宣称改善预测；在冻结事件扩容（或引入收缩正则）之前，v5.6 R1 的逻辑树定权必须避免同一条路过拟合路径（LLH 权重同样只能在小样本上拟合）。录像层（震级分箱 deltaI）当前无可打分目录真值事件，报告如实记录；其 2 事件折叠门本身阻止了过拟合。

## R1 不确定性量化基准（2026-08-24）

**标定数据扩容**：冻结强震事件 6→13（+7 个 crustal 事件，JMA 震中取自 observed.json；kobe1995/tottori2016 站数不足、kushiro1993 无 stationlist、fukushima2021 属 JMA 独立盲测划分刻意不用），4,887 站。si-midorikawa modelBias 重拟合（9 事件）LOEO 通过（held-out 0.635 vs 未修正 0.637）；kanno2006 重拟合（13 事件）LOEO 通过（0.772 vs 0.807）；zhao2006 维持 4 事件，LOEO 反向证据保留在其 note。

| 模块 | 基准 | 结果 | 验收 |
|---|---|---|---|
| τ/φ 分解 | ANOVA 矩法，距离档去趋势（`tools/data/sigma-components-report.json`） | si-mid τ0.256/φ0.654、kanno τ0.551/φ0.771（lnPGA）；zhao 论文值保留 | 通过（shakemap 聚合分量约定使 φ 略膨胀，已注明） |
| LLH 逻辑树 | Scherbaum LLH + Delavaud 权重（`tools/data/logic-tree-weights.json`） | crustal 0.367/0.338/0.296，interplate 0.372/0.357/0.271，intraslab 单事件 0.398/0.352/0.250 | 通过（无退化权重；slab 单事件如实标注） |
| 空间相关 | JB2009 论文式 ρ=exp(−3h/b) + 实测半变异函数 217,859 对 | 实测范围 lnPGA 94 km / intensity 72.5 km（2-3× 论文 Case1：本系统平滑失配结构残留） | 通过（实测值入引擎，论文式保留参考；场相关形状测试 0.50 vs 0.47） |
| MC 集合 | 种子确定性 + 循环嵌入场；冻结 13 事件 1,633 站 × 120 成员 | **68% 覆盖 0.696、80% 覆盖 0.811**；79 ms/100 成员×200 站 | ✅ 预登记验收（±5pp） |

## 适用范围（2026-08-17 修订）

- DC3D 假定均匀、各向同性、线弹性半空间和矩形位错，不包含分层弹性、塑性、孔弹性或滑坡源。
- 浏览器默认在距震源 `max(150 km, 0.75×最大断层尺度)` 内逐子断层求和，远场使用守恒总位错面积矩的等效解析矩形；可用 `dc3dFarFieldAggregation:false` 运行全场 CPU 参考结果。
- 水平海床位移按 `Δz = uz - ue ∂z/∂e - un ∂z/∂n` 加入；结果受地形分辨率和垂直基准质量限制。
- 有限破裂的海床形变按逐子断层起裂、上升时间和 STF 得到的累计矩释放比例连续施加；规定源体积会从质量漂移中单独扣除。当前按累计矩比例缩放完整 DC3D 空间场，尚不是逐子断层移动 `dtopo(x,y,t)` 的全分辨率反演产品。
- NLSWE 是静水、非频散长波模型，不含频散和波浪破碎；市域淹没不能解释为逐街区结果。
- 溃坝湿干前缘仅表现约半阶收敛，符合一阶 Rusanov 通量在间断解上的预期，不应宣称二阶精度；**深水（>20 m）湿底溃坝的二阶 MUSCL 路径已单独验证，观测阶 2.31/1.35（见上表）**。
- Synolakis 爬坡在 0.15°-级网格仍低估解析值（0.62-0.75 比率），一阶湿干前缘是主因；该对比是收敛性证据而非精度声明。
- 有限断层反演入口是带平滑正则和可选矩约束的非负线性反演参考步骤；Green 函数、波形预处理、正则参数和断层几何仍需独立论证。

## 外部模型状态

解析 DC3D 已与 GeoClaw 5.14.0 的冻结垂向输出交叉计算。NLSWE 当前以解析湖面静止、Ritter 解、Stoker 湿底溃坝（MUSCL 路径）、Synolakis 爬坡解析律、开放边界及质量守恒验证。JAGURS/COMCOT 的授权事件输出仍未取得。

**GeoClaw 跨代码对比已实机跑通**（2026-08-17，clawpack v5.12.0 Windows/conda-gfortran 编译，`tools/geoclaw-crosscheck/`）：相同 0.15° GEBCO 地形 + 相同 DC3D dtopo 的 Mw8.2 三陆冲情景，7200 s、4 个规范 gauge——深水峰值差 9.2%/24.2%、到时逐 gauge 一致、去均值 r 0.92/0.87；近岸 gauge 差 41–49%（一阶 vs 二阶湿干前沿处理）。报告落盘 `tools/data/geoclaw-crosscheck-report.json`。

**分辨率阶梯**（2026-08-17，同源 0.025° 网格 K=1/2/6 聚合、固定 gauge，`case-sanriku-{fine,mid,coarse}`）：本求解器深水峰值 0.05° 收敛（0.77/0.75 m，与 GeoClaw global 用例 0.71/0.58 m 相符）；**近岸峰值随分辨率单调增长（ofunato 0.24→0.86→1.24 m）0.025° 未收敛**——2.8 km 格距仍低估浅化/爬高。⚠ 区域域（lat-lon）的 GeoClaw 侧被 **Windows mingw 构建的球面 capa 静水缺陷**阻断：静止纯水下伪流 3–99 m/s、质量流失最高 8%，gfortran 15.2/16.1 逐位一致、Cartesian 路径正常（0.005 m/s）——跨代码区域对比需 Linux/WSL/Docker 官方构建重跑（输入用例全部随库提交）。详见 `tools/geoclaw-crosscheck/README.md`。

**GSI 沿岸 DEM 试点**（2026-08-17，`tools/fetch-gsi-dem.js` + `tools/blend-gsi-gebco.js`）：地理院タイル DEM（z12，~30 m/px，154 瓦片）重投影镶嵌 → 与 jp-sanriku 0.025° GEBCO 融合（frac≥0.5 替换/羽化过渡，1100 格替换、92 个湿干翻转、海岸线 5702→5794 陆地格）。Tohoku-2011 runup scorecard 对比（`--grid=tohoku2011:jp-sanriku-gsi` 诊断开关）：ofunato 2.66→3.03 m、onagawa 15.93→12.35 m、rikuzentakata 7.05→2.95 m、sendai 1.30→1.28 m（观测 23.6/18.4/17.6/10.4）——**混合方向无系统性改善**：在 2.8 km 求解格距下，DEM 精度不是瓶颈（瓶颈是分辨率+runup 提取）；基础设施（抓取/镶嵌/融合/评估开关）就绪，供嵌套网格批次直接复用。融合网格 `public/geojson/grids/jp-sanriku-gsi.json`（原始镶嵌不入库，可由工具再生）。不能用内部结果冒充外部模型。

**GSI DEM 推广**（2026-08-17 第二批）：同一工具链扩展到全部四个区域窗口——`jp-noto-gsi`（能登半岛+富山湾岸，658 格替换）、`jp-hokkaido-sw-gsi`（奥尻/噴火湾，734）、`jp-nankai-gsi`（室戸・高知沿岸，1835）、`jp-sagami-gsi`（相模湾岸，803）；全部通过 `Physics.validateResearchGrid`，scorecard `--grid=` 诊断开关同步支持。诊断结论与试点一致：预测基本不变（noto wajima 0.80→0.82 m、hokkaido 全点不变）——DEM 不是瓶颈，诊断保留供未来细网格批次使用。

## 两层嵌套网格求解器（two-way AMR，2026-08-17）

`Physics.createNestedTsunamiSolver(coarseGrid, fineGrid, source, options)`——生产配置为全局 0.15° GEBCO 粗层 + 区域 0.025° 细层（加密比 6，`tsunamiNested: auto/on/off` 配置）。此前区域事件在自封的单一网格盒内运行（外壁反射/海绵），远场传播和迟到波不物理；嵌套后波可自由穿越细区边界进入全球网格。

**耦合算法**（coarse-first 经典模式）：每粗步 (1) 粗层全域推进 dtC；(2) 细层以 dtC/K（K≥ratio，按细层 CFL 探测自适应上调）做 K 个子步，每个子步前用**湿加权双线性 + 时间线性插值**（粗层 t_n/t_{n+1} 两态之间）重填细层鬼元环；(3) **eta 基湿单元保守限制**——含 ≥1 个细格中心的粗格被细层面积加权水面覆盖。关键取舍：限制的是水面而非水深（水深限制在斜底上注入细/粗床采样差，伪造 ~1.3 m 水丘与 0.6 m/s 界面流；eta 限制使静水跨接缝**精确**），代价是界面处小规模非保守缝项，如实计入 `massResidualFraction`（实测 ~3e-4）。无 Berger-Colestra 通量修正。

**验证**（`tests/nested-grid.test.js` + `tools/validate-nlswe-benchmarks.js` 第 7 节）：
- 跨接缝含岛屿斜底静水：扰动 9.7e-15（精确 C-property）；
- 高斯脉冲穿界面 vs 均匀细网格参考：细区 L1 = 2.2% 振幅；界面反射 0.55% 振幅；
- CFL 严格贴限（0.150/0.15）；生产 0.15°+0.025° 组合验证 + 健康运行 60 s。

**scorecard A/B**（`--nested=auto` vs `--nested=off`，3600 s）：预报区命中率 **43.8%→50.0%**（warning 行 2→3 命中），误报 0 不变；沿岸峰值基本不变（ofunato 2.66→2.68 m 等——近场由细网格主导，符合预期）；逐事件耗时 1.6–2.7×（`_stepOnce` 探测去重后）。渲染端快照改为绝对经纬度锚定（顺带修复区域网格图层错位 bug）。

## R6 动力学破裂求解器(v6.0,2026-08-26)

`tools/dynamic-rupture/`(core.js 求解器 + configs.js 实验配置 + run-experiment.js 运行器 + export-finite-fault.js 回导导出器)。2D 速度-应力交错网格 FD + 分裂节点牵引(TSN)线性滑移弱化自发破裂;SH(反平面,mode III)与 P-SV(面内,mode II)两模式;扰动松弛型 Cerjan 海绵(保持环境场,不虚假弛豫静态解)。SH 模式下垂直走滑断层的水平自由面用**精确镜像**(uy 偶对称)表示。

**已验证(解析锚,`tests/dynamic-rupture.test.js` A1–A8 + 报告 tripwire A9–A10)**:
- 辐射阻尼 Z(dx)→μ/(2cs):dx=200→12.5 m 单调收敛,|rel| 2.3%→0.03%(SH),−1.0%(dx=50,PSV)——断层-介质耦合的时域精确性;
- 静态位错核:高斯滑移斑 ΔT 在 5 个断层位置 vs 解析 PV 积分一致(≤13%,含 PV 积分自身离散化);
- 离散能量闭合:无断层纯弹性波 350 步漂移 <0.5%(两模式);平面应变能量密度公式 p²/(2(λ+μ)) 修正后成立;
- 自发破裂(SH):左右对称至 1e-6(浮点放大下限)、传播期 T=τd 一致性 ±1.5 MPa、v_front=0.68–0.75·cs(dx=100/50)、中心滑移分辨率收敛 5%(3.40/3.24 m);
- SCEC TPV5 官方参数反平面约化(TPV5-AP,半空间镜像):成核成功、双向传播 v≈0.5·cs、10 站 0.1 s 采样序列冻结于 `tools/data/dynamic-rupture-report.json`;
- 回导:`export-finite-fault.js` → `FiniteFault.parse`(quake-sim-finite-fault-v1)round-trip,矩一致 <2%,`Physics.sourceBudget` 诊断零旗标。

**实现要点(踩过的坑,复现别再踩)**:
- TSN 分支必须用**运动学状态机**:屈服判据只允许 locked→sliding 单向转换;滑动节点只有在 V 过零时重新锁定。若按 |Tlock|≤强度 随时重锁,慢滑段被错误清零,产生 dx 依赖的 stop-go 颤振与伪成核停滞(2026-08-26 实测定位);
- 测速站必须取**震源同侧**(跨两侧的 |Δz|/Δt 会 2× 虚高——首版报告 3470>cs 的荒谬值由此而来,被 tripwire 当场拦截);
- 2D 滑移弱化自发破裂的最终滑移相对静态裂纹解有**动态过冲**(低 S、大占比成核补丁时可达 2–4×),过冲量由动力学选择、静态许可集内任意锁定态都是合法终态——"终态=静态椭圆"不是有效测试锚(已从验收中移除,以自收敛替代)。

**诚实边界(不声称的能力)**:
1. **PSV 面内 Burridge–Andrews 超剪切转换阈值未经校准**:实测 S=2.0 时前导 P 波在断层前方抬高 σxz ~12–14 MPa,使转换提前于 Zheng & Rice (1998) 经典估计(报告 psvSpont 段);dx=50 依旧。原因未定(物理或离散化),官方 SCEC 参考数据(登录墙后,`docs/CVWS-UPLOAD.md` 用户运行手册)是裁决依据。在此之前**不做任何超剪切阈值门禁**;
2. 倾斜断层(TPV10/11-2D 的 60° 正断层类)与 P-SV 自由面**未实现**(需要浸入式分裂节点或曲线网格,ROADMAP 6.9 记录);
3. TPV5-AP 是**非官方 2D 约化**:官方 TPV5 为 3D,其沿走向应力补丁(±7.5 km 的 78/62 MPa 块)在 (法向,深度) 平面内不可表示,已从配置中如实排除;站点序列与 3D 官方参考解只做定性对比(手册第 3 步);
4. Kostrov 自相似裂纹解析解**未**用作锚(公式无法从记忆可靠复原,拒绝半记忆公式入回归——如需,按 Freund 1990 教材逐字转录后再加)。

## 场地反应外部基准:SHAKE 谱系两级阶梯(2026-08-27)

**第一级 — 线弹性(SHAKE-91/Itasca, v5.7 收尾已冻结)**:Itasca FLAC3D 文档公开的 3 层线弹性算例,解析 3 Hz 输入 × Thomson–Haskell 传递 → 地表峰值 **0.160 g vs 发表 SHAKE-91 0.156 / FLAC2D 0.160 g**(`tools/data/shake91-benchmark-case.json` + `tests/shake91-benchmark.test.js`,预登记区间 [0.140, 0.175])。

**第二级 — 十层非线性等效线性(EERA 手册算例, 2026-08-27)**:经典 150 英尺 SHAKE-91 示例剖面,以 EERA 手册(SHAKE 谱系免费后继,Bardet/Ichii/Lin 2000)完整数值算例运行——"Diam @ 0.1 g":

- **输入**:DIAM.ACC(1989 Loma Prieta Diamond Heights 台站 H1_90 分量;2000 点 @ 0.02 s,原始峰值 0.112895 g,缩放至 0.1 g)。NISEE 的 SHAKE-91 软件下载需登录(软件目录 500),记录取自 EERA 官方发行包(孟菲斯大学 ce.memphis.edu,免费);同一剖面亦为 Itasca FLAC3D vs SHAKE-91 非线性验证页所载。
- **剖面**:16 子层 + 弹性半空间(Vs 1219.2 m/s,出露输入约定),材料曲线 = Seed & Sun (1989) 黏土上限 / Seed & Idriss (1970) 砂上限 + Idriss (1990) 阻尼(工作簿逐值冻结)。
- **发表锚点**:地表出露峰值 **0.190411 g @ 11.28 s**;17 行收敛末态(逐子层应变/G-Gmax/阻尼);基期 0.478723 s。
- **方法对齐**:为跑对算给 `Physics.siteResponse1D` 增加逐层曲线表覆盖(`opts.layerCurves`,log10 应变分段线性插值,阻尼保留独立应变栅格 3.16% 终端),并新增 `Physics.shTransferComplex`(同一 `_shPropagate` 传播器,保相位)——SHAKE 语义的末次卷积用**复**传递函数(正频率乘 A、共轭 bin 乘 A*;只乘 |A| 会 +17%,丢共轭会 −41%,两者都是实现陷阱)。
- **结果**:我们的等效线性地表峰值 **0.1803 g @ 11.30 s = 发表值的 −5.3%,峰值时刻差 0.02 s**;1 g 输入放大系数 1.803→1.482(非线性去放大趋势与 FLAC3D-SHAKE 发表行为一致)。预登记 ±15% 区间 [0.162, 0.219] 断言入回归(`tests/deepsoil-benchmark.test.js`),另设冻结结果漂移绊线(引擎改动使基准偏移 >0.5% 即报警)。
- **深化(2026-08-27 第二批):谱应变路径 + 9 级缩放阶梯**。新增 `Physics.shStrainTransfers`(逐层中深应变传递函数,γ_m(f)=T_m(f)·F(f))——**16 个子层收敛 G/Gmax 与 EERA 逐层差 ≤0.04**,地表峰 **0.2006 g @ 11.28 s = +5.3%,峰值时刻精确命中**。代理(−5.3%)与谱(+5.3%)从两侧包夹发表值 0.1904 g。Itasca 9 级阶梯两模式全程单调不增(2.13/2.20 → 1.48/1.48),高输入端两法收敛。生产路径保持单频代理不变。
- **已知缺口(收缩)**:单频代理的顶层应变高估(25×)仍是生产路径特性(对 GMPE 场地修正是保守方向);基准对算已有完整频域路径覆盖。

工具:`node tools/run-deepsoil-benchmark.js [--write]`;案例冻结 `tools/data/deepsoil-benchmark-case.json`(schema quake-sim-deepsoil-benchmark-v1,含 2000 点记录、双曲线表、17 行收敛态与出处链)。
