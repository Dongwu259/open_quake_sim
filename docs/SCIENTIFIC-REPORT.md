# Earthquake Simulator Pro —— 网站科研化完整技术报告

**版本**:v6.2(截至 2026-09-09 分层根批 + SH 混叠守卫批 + 支尾奇异因子扣除批 + Rc 反演批 + δ 矩阵批)
**性质**:离线科研内核 + 实时演示网站的完整科学化记录——方法论、验证体系、已冻结的测量结论(含负结果)、诚实边界与开放项
**读者**:接手本项目的开发者/研究者;所有结论均可由仓库内工具与冻结工件复现(见 §11 与 `docs/REPRODUCE.md`)

---

## 0. 执行摘要

这个网站从一个"参数化地震演示"逐步改造成了一套可复现、可证伪、以观测为裁判的计算地震学研究平台。截至本报告,科研化体系包含:

| 支柱 | 内容 | 状态 |
|---|---|---|
| **强震动验证基线** | 19 个冻结事件、6,917 个 K-NET/KiK-net 台站观测峰值;GMPE 预报路径对照 | 逐事件记分卡冻结;modelBias 留一(LOEO)结论经 19 事件扩容后**公开反转** |
| **GMPE 交叉实现** | Zhao2006 对 openquake.hazardlib 官方实现逐位对拍(2,400 点,max\|ΔlnA\| = 2.7e-15) | 锁死 |
| **PSHA 引擎** | Poisson 年超越率积分、10,441 格 GR 震源模型 + 分段南海 BPT 情景源、UHS、危险分解 | 自验闭合;对 J-SHIS 外部对照**如实报告高估 1.83×** 并完成归因 |
| **宽频带管线** | SH 离散波数内核 + Brune/Boore 混合 + 条件谱(CS)管线 + 短周期仲裁者 | 长周期改善 PASS(+0.143);绝对门 FAIL 如实冻结;仲裁 INCONCLUSIVE |
| **P-SV 研究内核** | 离散波数全空间/分层 Green 函数,五轮迭代(v1→v5) | 全空间锚定(残差 ≤0.08);分层 deviatoric 序列收敛;fullTensor 通道**诚实开放** |
| **动力学破裂** | SH/PSV 交错有限差分 + TSN 滑移弱化,TPV5-AP 官方参数 | 反平面验收通过;CVWS 参考解在登录墙后,不做逐站一致声明 |
| **测试与门禁** | ~98 个测试文件、约 1,089 项断言;不可变实验清单;pre-push 版本门禁 | npm test 全绿为每批提交的先决条件 |

本报告 §7 完整记录了 P-SV 内核七轮迭代的全部弯路与翻转——包括本批(支尾奇异因子扣除)开始时既定假设被实测**推翻**的过程:v4 冻结的"分支尾 1/√ 奇异"归因是错的,真正的元凶是**未设 qP 时泄漏型 P 波极点坐在实轴上,使波数积分成为主值意义下的发散积分**;v6 又发现登记的 Rc 反演不适用、真缺陷是 expm 传播子静默丢层 Q;v7(δ 矩阵批)落地 MGS 正交化链并修复两个传播子/链真 bug(R2 锚在冻结前抓住 triMul 交叉项丢失;μ* 反变换修复)。当前 deviatoric 通道在生产 cap 收敛(spread 1.3%),fullTensor 通道的残余=泄漏 P 峰顶带的 subdivide cap 依赖,作为登记的开放项如实冻结。

---

## 1. 科研化方法论:六条纪律

网站的每一块"科学结论"都由以下纪律约束,违反任何一条在代码评审/回归中都会被抓:

1. **预登记(pre-registration)**:测量方案与判据在开跑前写进工具头部注释或报告 `preRegistered` 字段;判据不允许在看到数据后修改。例子:cs-arbiter 的 0.1 s 决策带与 DBAR 阈值;v3 冻结时登记的"自觉解冻条件"(两个暴力参照收敛时 tripwire 必须失败并触发重冻)。
2. **冻结报告即测量,不是标定输入**:`tools/data/*.json` 冻结工件是"某时刻代码状态的测量记录"。拿它反过来调参是红线(例如 J-SHIS 对照门:整改方向必须来自可归因的物理原因,不许对着官方曲线调参)。
3. **负结果公开**:形状门 FAIL(§6)、仲裁 INCONCLUSIVE、LOEO 第一次结论"不泛化"、P-SV fullTensor 通道开放——全部写入冻结报告与 tripwire,而不是藏在注释里。
4. **不可变实验清单**:改任何 `tools/data/*.json` 必须重跑 `tools/build-experiment-manifest.js --write`(41 条目,内容哈希锁);npm test 红 = 清单过期。
5. **双实现/独立参照交叉验证**:每个内核至少一个与被测代码不同族的参照——GMPE 对 hazardlib 官方移植(逐位)、P-SV 传播子对 RK4 逐步积分(R2)、机械积分对中点规则暴力(R8)、α 数值积分对 Bessel 恒等式装配(R4/A3)、Kelvin 静态极限对 ω→0 极限(A1)。
6. **结论只在有锚时发表**:没有外部/闭式锚的数值一律标"研究态、不进入产品";`opts.psv` 至今未接入生产记分卡,正是因为分层通道还有一个未收敛的开放项。

---

## 2. 强震动验证与 GMPE 校准体系

### 2.1 观测基线

- `public/geojson/strong-motion-obs.json`:19 个事件、6,917 个台站的 K-NET/KiK-net 观测峰值(USGS ShakeMap 管道,`tools/fetch-strong-motion-obs.js`),覆盖 2003 十胜沖、2011 东北、2016 熊本、2022 福岛沖、2024 能登、2024 日向滩等。
- 全局基线(auto 路由 RMS):**1.217 / bias −0.433**(n=52,2026-09-04 因 von Kármán 滑移场更换如实重定基;旧值 1.189/−0.50)。历史 log 模型参照 RMS 3.17 仅作对照,不再复现。

### 2.2 GMPE 三族与逻辑树

- `GMPE_LOGIC_TREE`:crustal→Si-Midoriwara,interplate/intraslab→Zhao2006,三族 LLH 权重;`gmpModel 'logic-tree'` 输出加权几何均值 + 认知 σ。
- **Zhao2006 忠实实现**(论文 Eq.1/5 自然对数形,c·exp(dM) 伪深度饱和、15 km 门控深度项、FR 逆断层项、Table-2 场地分类、PGV 经 SA(1s) 换算):对 hazardlib 官方 `zhao_2006.py`(jsDelivr 拉取,sha256 锁)生成 2,400 点夹具,**max |ΔlnA| = 2.7e-15**(tests/gmpe-benchmarks.test.js)。
- **modelBias 距离分箱校正**:2,626 台站拟合,zhao2006 强度 bias +0.685 → +0.086,RMS 1.19 → 0.80。
- **LOEO 反转(科研化方法论的标准案例)**:v5.8 R0-4 留一检验(13 事件)得出"modelBias 不泛化"并冻结;v6.2 扩容到 19 事件后三族 held-out RMS 全部**低于**未校正(zhao 0.840→0.804 / si-mid 0.637→0.634 / kanno 0.772→0.743)——旧结论是小样本伪象,公开更正并写入 tripwire(tests/scientific-tripwires.test.js)。
- 大震饱和:Zhao 有效震级压缩 + tanh 软顶(3200 gal / 250 cm/s),对齐 2011 观测极大值(M9@30 km 从不可能的 12,718 gal 压到 ~3,100)。

### 2.3 其他校准锚

- 余震产出率 `AFTERSHOCK_PRODUCTIVITY_LOG10 = 0.809`(熊本/能登/东北 90 天 USGS 计数 LSQ;Utsu/Reasenberg-Jones b 斜率),ETAS α = 0.809·ln10。
- 场地响应:1D 等效线性(Thomson–Haskell + Darendeli 曲线)、S/B 经验先验(197 台 KiK-net 井表/地表比,anchor-invariant 的 f0(Vs30) 传递;振幅曲线按 borehole 参照混杂**有意不用**,死路已记录)、JIVSM V4 柱网格走时与盆地因子。
- 直接ivity:Bayless-Somerville 2013 全式(系数网格逐字冻结)+ Shahi-Baker 脉冲概率/周期/注入。

---

## 3. PSHA 体系与外部门

### 3.1 引擎与震源模型

- `Physics.hazardCurve`:Poisson 年超越率积分;`Physics.deaggregate`:条件 IM 水平上的构造类×0.5 级×Rrup 分解(独立重推导、守恒 1e-15、RP 单调、代表性源几何 7 项锁死);`Physics.uhs`:逐周期危险曲线反演(Zhao2006 全 21 周期表,pga 锚点)。
- 震源模型 v2(`psha-source-model.json`):USGS ComCat 自算 0.25° 网格 GR(10,441 格,三构造类)+ **分段南海 3 模式**(nankaiFullM89 / EastM82 / WestM83,ERC 纯间隔 BPT,均值 1/117 年,4/1/1 分割)+ 首都直下 M7.3 情景源。

### 3.2 外部门:对 J-SHIS 如实报告高估

外部对照(`fetch-jshis-comparison.js`,6 站点)是**测量**,不是标定目标:

> 自建模型 **高估 PGV 危险**:RP475 比值(ours/J-SHIS Y2024)中位 **1.827×** [1.458, 4.227];mid-band 年率比中位 10^0.422。

### 3.3 归因(高估从哪来)

`psha-attribution-report.json` 逐臂消融:

- 去情景源后比值中位降到 **0.923**(≈1)——**超估主要由南海情景源承担**(RP475 率中位 99.7% 来自情景源);
- zhao-only 臂 1.395:GMPE 族也有贡献;
- mid-band 负 rate-ratio 尾部是 BPT 时间依赖特征——登记为 BPT 引擎的立项依据。

**铁律重申**:下一步(若有)是可归因的物理整改(情景率/BPT 工程判断复核),绝不是对着 J-SHIS 调权重。

---

## 4. 宽频带地面运动管线(SH + 混合 + CS)

### 4.1 结构

- `tools/broadband/core.js`:SH(反平面)离散波数内核——Thomson–Haskell + 双力偶 m=2 源 + Bouchon DW,五锚(Rayleigh 根、RK4 ODE 交叉、SI 闭式柱柔度、频带稳定、k→0 绝对尺度)。
- `tools/broadband/hybrid.js`:DW-LF × Brune + Boore 绝对定标 HF + 有界缝平滑;`opts.psv` 三分量研究态开关(默认关=字节兼容)。
- `tools/broadband/scorecard.js`:13 事件 Kyoshin 预登记记分卡(逐事件台站中位数的 log10(syn/obs))。

### 4.2 冻结的记分卡结论(broadband-scorecard.json,2026-09-06 重冻)

| 带 | hybrid AbsMax | brune AbsMax |
|---|---|---|
| 0.1–0.5 s | 1.404 | 1.068 |
| 0.5–2 s | 1.585 | 1.033 |
| 2–10 s | **2.228** | **2.371** |

- **长周期对 Brune 改善 PASS**(+0.143);
- **绝对门全部 FAIL**(PGA/PGV/PSA),findings 记录选择偏差地板:强度选台使 GMPE 臂同样过不了门——这是测量协议的地板,不是模型一家的失败;
- PGA AbsMax:hybrid 1.342 / brune 0.902 / gmpe 0.538。

### 4.3 条件谱(CS)管线与仲裁:负结果链

- cs-pipeline v3 冻结:κ0=0.04、应力平坦化与 LF 增益均为**否证的负结果**;形状门**如实 FAIL**(短 0.776 / 中 0.432 / 长 0.574)。
- cs-diagnose:HF 短周期超标 100% 在 Boore HF 侧(κ0.02 贡献 ~0.186);4/6 例 MS-CS 目标结构性不可达;高知 2–4 s 亏损排除 JIVSM 与 Q → 1D SH 核对 M8.8@26 km 的固有小振幅(zhao 嵌入 3D/盆地效应)。
- cs-arbiter(13 事件预登记):obs−zhao 配对残差中位 −0.038 @0.2 s → **目标侧 INCONCLUSIVE**;κ 杠杆否证(dKappa −0.008);合成−观测 Ds −0.238 @0.2 s(Mj≥7.5 子集 −0.221)——短周期分账需要 M8.5+ 近场记录(登记,待用户 Kyoshin 账号)。
- v4 P-SV 激活预注册草案**在开跑前撤回**(见 §7)——预登记撤回也是纪律的一部分。

---

## 5. SH 内核长距 Bessel 混叠:暴露量化与守卫(2026-09-06)

- 根因:固定 dkInvKm=0.01/km 只对 r ≲ 63 km 抗混叠(J2(kr) 周期 2π/r);守卫 `dk = min(dkInvKm, (2π/r)/10)`。
- 暴露量化(`sh-alias-exposure.json`):13 事件 756 条台站路径中 **69% 超过 63 km**(中位 88 km);守卫前逐点偏差 p90 0.35 / max 2.08(数量级级);守卫后 max ≤0.9、中位 ≤0.05;记分卡带级影响 ≤0.05 log10 → **文档性重冻,不触发重标定**。
- 残余(守卫后 max 0.80)= Love 模态极点的格点运气,登记后续:SH 侧引入 §7 的分层窗机制。

---

## 6. P-SV 离散波数内核:完整研究史(v1→v5)

这是科研化方法论最完整的案例:一个内核从"21.3× 偏热"到"全空间锚定 + 分层部分收敛",五轮批次,每一步都是测量驱动的。

### 6.1 v1(方案 A 批):阻塞

尺度诊断 v1:**traction 族比 0.908,dipole/traction 偏热因子 21.3×** → `blocked_pending_source_calibration`。旧代码被证明不可信:全局中位数 razor 在衰减型被积函数上整带误杀 + 混叠格点 + 不健全的归一化启发式。

### 6.2 v2(源标定锚批):全空间锚 + 三处内核缺陷

- 新建闭式全空间参照 `psv-fullspace.js`(Kelvin 静态极限自锚 + Weyl κ 域张量),A1–A3 锚:五纯张量复残差 ≤0.08,被积函数级逐 κ 一致。
- 用锚实测并修复:①缺失偶极项 3 个(Mzz 的 u_r、Mxz 的 u_z 臂;u_z(Myz) 结构性为零=镜像反对称,首版修复的 sin² 幂次滑错被锚在 1e13σ 抓住);②错列项 1 个;③traction 族与 dipole 族相对 −1;④razor 全局中位数缺陷(锚用例 180/388 样本被杀,198× 积分损失→改局部邻居判据)。
- v1 的"21.3× 偏热"判读随 v2 报告**正式退役**。

### 6.3 v3(分层极点批):留数方案废弃

- 13 层 JIVSM 生产栈上留数提取不收敛:GS 正交化幅度在模态根处指数坍缩(det(BA) V 谷 1e13),任何 [g·D]/D' 留数公式在硬堆上失效——**废弃留数,改 γ 分辨窗积分**(窗内解析峰 + 普通梯形余项)。
- 色散行列式 GS 一致化(per-k 归一化因子精确相消)。
- **Bessel 混叠根因**:tokyo 生产配置 r=198.5 km 处 J 振荡周期 0.032/km,固定 dk=0.02/km 每周期只采 1.6 点 → 距离自适应下限 dk ≥ (2π/r)/10(SH 内核同参数,见 §5)。
- 诚实冻结:模态谐振半宽 γ_d=k/(2Q)~2.4e-7 vs 探测器根定位精度 ~80γ_d——**γ_d 精度缺口 OPEN tripwire**,并登记"两步长暴力自差 1.8×"的自觉解冻条件。

### 6.4 v4(分层根批):根追踪交付

四层诊断(每层都被独立实验钉死):

1. **GS det 噪声地板**:GS 链的 det 平躺在 1e-15 正交化噪声上,全基阶带无根可寻 → 弃用;
2. **原始链阶梯**:不重正化链骑 e^±80 中间量 + e^19 subdivide 阶梯 → 弃用;
3. **联合标量重正化链**:四列同乘一个因子、精确 log 记账——列比不变、无表示切换(GS 切换被 Rc⁻¹~1e15 放大成 8 阶 compliance 跳变,tokyo 1.67995/km 实测 C 从 −30.3 跳 −22.5);
4. **E diag D E⁻¹ 传播子在支点奇异**:k=1.68/km(沉积层 P 支)P 上下行特征向量合拢,det(E)→0,compliance 跳 8 个量级 → **改矩阵指数 exp(Ah)**(scaling-and-squaring;expm 是矩阵元的整函数,无分支结构)。

根追踪:原始链色散 + 三重防御(支点排除/背景线性拟合深度门/双 subdivide-cap 确认)+ **2D 实 Newton**(复商形式只沿 Re 微分,Im 永不收敛——实测根的 Im 依赖仅 0.2%);γ 取 Newton |Im κ*| 与实轴 HWHM 较大、下限材料宽/4。验证:R8 机械 vs 独立暴力 ≤5%(真 Rayleigh 根 0.976/km 被找到并精炼——v5 探测器漏掉它);R9 网格无关 ≤10%。v3 登记的解冻条件**如约触发**(暴力对 56.53/62.54,比 1.106 ≤1.3)。

v4 冻结的结论:"below-floor dk 序列不收敛,主导残余 = 可积 1/√ 分支尾 cusp(IASP91 半空间 P 支 0.524/km),梯形 O(√h)"——**这个归因是错的,见 v5**。

### 6.5 v5(支尾奇异因子扣除批,2026-09-06):假设被实测推翻,真机制现形

本批以"分支尾奇异因子扣除"立项,结果经历了三次机制翻转,每一步都有数值证据:

**翻转 1:分层柔度在支点有界,"1/√ cusp"不存在。**
对 R8 半空间逐点实测:|g·ur| 趋近 P 支点时**平台在 ~7e2**,S 支点 ~3.5e1——没有发散。原因:柔度 C = Rc⁻¹Rw,两个残差矩阵携带**同样的** 1/ν 导纳因子,相消。因此分层路径上拟合 A/√(k*−k) 模型得到的是垃圾振幅(实测 A 谱无平台),扣除反而引入 19% 误差(R8 实测)。**分层路径的扣除撤销**;真正发散的 1/ν cusp 只在全空间路径(Weyl 因子显式 1/ν_c)。

**翻转 2:全空间路径的扣除成立,对照必须同步去偏。**
- 全空间:拟合复支点 k* = νOf(v, ω, 0, q)(Q 阻尼把 k* 推离实轴,模型处处光滑),从每个采样点减 A/√(k*−k),梯形积余项,解析回加 ∫₀^K dk/√(k*−k) = 2(√k* − √(k*−K));Im≥0 分支延拓自动覆盖隐逝侧。支点邻域 ±dkF/2 采样置 null(格点可 bit 级命中支点 → 0/0 NaN,该格由解析积分承载)。
- 两个独立对照(R8 中点暴力、A3 momentBlockReference)原本带各自的 cusp 梯形偏差;给它们实现**独立的 ξ=√|k−k_bp| 代换积分**(k = k_bp ∓ ξ²,dk = 2ξ dξ,2ξ·g 在 ξ 光滑)——不与机械共享任何拟合代码。
- 结果:R8 恢复 ≤5%;A3 锚 19/19 绿(残差重定基 0.070 ≤ 0.08 门;两侧求积同时改变,门是判据)。

**翻转 3:tokyo 序列的真元凶——qP 未设的主值积分。**
v4 冻结时 series(286→86)与"暴力真相"(56–62)并存,当时未察觉矛盾。本批深挖:

- 0.50–0.55/km 带内被积函数在**精确 null(m2inv 抛出,det(Rc) 过零)与 1e8 尖峰之间交替**——这是**未阻尼 P 波的泄漏型共振坐在实轴上**:probe 只传了 qShear=50,qP 缺省=0 → 该带 k 积分是**主值意义下的发散积分**,任何求积都不可能收敛。修复:分层路径 qP ← qShear 缺省(两个入口,带注释)。
- det 谷极点扫描器在深堆上结构性失效:重正化行列式坐在 **e^−288**,谷深与链噪声同量级,400 点扫描(步长 0.0124/km)直接跨过基阶(HWHM ~1.5e-3/km 的盆地囚禁模态 @1.005/km,被积函数对比度 10 个量级),2D Newton 对所有候选失败——v4 根表 4/4 全 raw,被积函数支撑仅 ~1e-13,**全是噪声谷**。→ **整体替换为柔度脊检测器**:扫有界柔度幅值 log max|C_ij|(步长 2.5e-4/km;内层支点在 expm 链下根本不是奇点,只有半空间支点排除;线性背景突出度 ≥0.75;黄金分割细化;HWHM 走查宽度),21 个候选全部 refined。
- 顺带修掉窗构造的连续性 bug:stepB 环从 mB=nA(=2γ)起跳,留下 **(γ/2, 2γ) 采样空窗**——宽 γ 时被粗格掩盖,盆地模态正好丢掉峰肩。

**v5 冻结状态**(后被 v6 部分更正):deviatoric 序列收敛 ~1.2% ✅;fullTensor 开放(当时归因"泄漏峰顶的欠流 null",登记"尺度不变 Rc 反演")。

### 6.6 v6(Rc 反演批,2026-09-09):登记方案被证伪,真缺陷是层 Q 丢失

1. **登记的"尺度不变 Rc 反演"实测不适用**:det(Rc) 小是**物理**(实轴泄漏极点),不是缩放——Rc 条目 O(1)、det 从 1e-5 一路塌到 1e-16(条目量级的浮点地板)再到精确 0;缩放/求积形式都救不了该基下的逐点求值。
2. **挖出更大的真缺陷:v4 的 expm 传播子把每层 Q 静默丢光了**。v4 用实模量(λ, μ, ρ 全实)构造层 ODE 阵 A——特征值 ±iν 全实 ν,无衰减;阻尼只剩半空间导纳一条路。旧 EDE⁻¹ 公式的 ν=nuOf(...,q) 是复的(带 e^{−Im ν h} 衰减)。三个锚全部盲:R8/R9 的栈不跑传播循环、R2 与同一无损耗系统自洽。**修复**:复模量 μ*=ρvs²(1−i/q_s)、λ*=ρ(vp²(1−i/q_p)−2vs²(1−i/q_s))(与 nuOf 逐位同约定 c*²=c²(1−i/q)),expm 特征值精确复现旧谱;无阻尼路径 bit 级不变。
3. **单点 qP 缺省下沉到 psvIntegrandAtK**:v5 的缺省在机械入口,R8 的暴力参照直接调被积函数 → 机械 qP=20 vs 暴力无阻尼,9% 的"假失配"。单点化后机械/暴力/探针同物理。
4. **检测器换地表源 det(Rc) 谷扫描**:极点条件源无关;衰减恢复后埋源 |C| 脊沉入 e^{−kz} 背景(v5 检测器因此失明,R8 又挂)。det 景观在修复后健康(背景 e^−24..−38,e^−288 链地板消失)。支点分辨环(内梯 bw/32×64)处理半空间支点 kink(悬崖 0.001/km 内跌 30%)。
5. **导纳递推原型(未入库存)**:上行腿(半空间→源)稳定;下行腿(地表→源)naive 逆递推 NaN——记录于 git 历史,登记 δ 矩阵(正交化)稳定化为正解。

**v6 冻结状态**(psv-scale-diagnosis.json v6,verdict `fullspace_anchored_layered_attenuation_restored_dev_converged_degenerate_band_open`):

| 通道 | below-floor 序列(dk 0.002/0.001/0.0005) | 状态 |
|---|---|---|
| deviatoric | 0.01474 / 0.01452 / 0.01465 | **收敛,spread 1.5%**,且是**正确物理尺度**(无损耗错误值的 1/3)✅ |
| fullTensor | 15.53 / 13.34 / 16.17 | **开放**,spread 1.04(v5 是 3.9×),非单调;tripwire 锁 >1.03 |

fullTensor 残余 = **Rc 基简并带**:k≈0.53–0.56/km(0.5 Hz,vs_half 以上的泄漏 P 带)上 det(Rc)=**精确 0**——两个残差基列 float 级平行,该基下 compliance 不可逐点表示(物理响应有界有限)。登记:δ 矩阵(正交化)稳定化柔度解。生产 `opts.psv` 继续 BLOCKED。

### 6.7 v7(δ 矩阵批,2026-09-09):MGS 正交化链落地,两个真 bug 被锚抓住

1. **链替换**:联合标量缩放链(保列比、不保列独立)退役,换 **MGS 正交化 δ 矩阵链**:S=Q·T 精确分解,逐层修正 Gram-Schmidt(双次再正交化)把增长推进 R,物理幅值以**乘积**形式进 T——从不作为大数相减出现;逐层对 T 联合归一(源上方因子进 σ,语义与旧链一致;源下方联合因子在 Rc⁻¹Rw 中相消)。无表征切换、对 k 连续——v5 GS 失败的"正交化↔仅缩放"阈值切换模式结构性缺席。
2. **triMul 交叉项丢失(新代码 bug,冻结前被锚抓住)**:首版三角乘积求和上界误写 l≤i(对角索引),(R·T) 的 j>i 交叉项全丢。症状:R2 RK4 锚 3.3e-2 失败、单层无阻尼下新旧链 c00 差 3–20% 而 c11 逐位一致(对角项不受影响)。**期间产生过一个"fullTensor 收敛于 0.0077"的假读数——该 bug 恰好压低了偶极通道——已公开撤回**。修复(全和乘积)后 R2 恢复,9/9 锚绿。
3. **μ* 反变换修复(v6 遗留真 bug,交叉验证逼出)**:psvPropagator 把缩放态牵引行/列还原回物理态时用实 μR,应为复 μ*(μ*=μR(1−i/q));无阻尼二者相等(v6 全部锚盲),阻尼路径每层混 |1−i/q| 的状态约定。修复后无阻尼逐位不变。
4. **测量结论(生产配置 qP=qShear=50,cap 30)**:deviatoric below-floor 序列 0.01414/0.01409/0.01427,**spread 1.3%,与 v6 raw 链尺度一致(差 2.5%)**——v6 的绝对尺度结论保留;带内 raw 链的精确 null 全部恢复有限值(残余孤立 null 3 个:0.555/0.585/0.620/km)。
5. **fullTensor 保持 OPEN,病因更锐**:不是 det-null 坍缩(已消),而是 **subdivide 指数帽依赖**——每子层指数帽限制 MGS 内积可分离的动态范围,cap 30 下泄漏 P 峰顶带(偶极通道骑乘)欠分辨:点位 cap30/cap10 差至 10×、系列差 ~30×;cap10/cap4 点位收敛到 16%。cap10 系列(dk 0.02/0.001:dev 0.0391/0.0366,full 1787.7/1641.2)入冻结记录。生产 `opts.psv` 继续 BLOCKED。登记下一步:compliance 链 cap 研究(成本 ~3× 子层)或逐层 Schur 导纳步进。

### 6.8 P-SV 锚集(测试即规格)

R1 Rayleigh 根(Rayleigh 三次方程)· R2 RK4 独立积分 · R3 辐射零节点 · R4 逐波数 α 数值装配 · R5 偶极深度 FD 收敛 · R6 频带稳定 · R7 SI 闭式柱柔度 · R8 加宽 Q 暴力对拍 ≤5% · R9 网格无关 ≤10% · A1 Kelvin 静态极限 · A2 κ 域=空间闭式 · A2c 约定钉死 · A3 全空间块参照。**19/19 绿为本批提交先决条件。**

---

## 7. 动力学破裂(离线)

- `tools/dynamic-rupture/`:SH/PSV 交错速度-应力有限差分 + TSN 滑移弱化;TPV5-AP 官方参数逐字冻结并跑通反平面约化(10 站序列在 dynamic-rupture-report.json);有限断层导出接入 app.js 捆绑模型下拉。
- 实现级教训(写进 PHYSICS_BENCHMARKS,复现别再踩):①TSN 必须运动学状态机(屈服单向解锁、V 过零才重锁);②测速站必须震源同侧(跨两侧 2× 虚高被 tripwire 当场拦下);③平面应变能量密度 p²/(2(λ+μ));④"自发破裂终态=静态裂纹椭圆"不是有效锚(动态过冲 2–4×),验收改自收敛。
- 诚实边界:PSV 超剪切转换阈值未校准;倾斜断层/面内自由面未实现;Kostrov 解析解有意不用。CVWS 官方参考解在登录墙后(`docs/CVWS-UPLOAD.md` 为用户运行手册),拿到前不做逐站一致声明。

---

## 8. 实时观测对照与暴露量化

- **Kyoshin 记分卡**:13 事件(ComCat 矩张量 13/13)预登记测量,见 §4.2。
- **强震动观测扩容**:19 事件/6,917 站 → LOEO 反转(§2.2)。
- **SH 混叠暴露**:§5,逐点偏差从 max 2.08(约一个数量级)压到 ≤0.9,带级影响 ≤0.05 log10——同一测量纪律用于"我们自己的历史数字"的回溯审计。
- 实时波形面板(rt-waveform):仪器原始计数、不做标定、不构成烈度/物理单位——界面与文档同样执行"诚实边界"标注。

---

## 9. 测试与门禁基础设施

- **npm test**:93 个测试文件、约 1,089 项断言;每批提交(完成即提交纪律)前必须全绿。
- **tripwire 模式**:每个冻结报告配一个 tripwire 测试,把"当前结论"锁成断言;新证据到来时测试**自觉地**失败,强制重冻(例:v3 登记的暴力收敛解冻条件在 v4 如约触发;v5 的 fullTensor open 锁在收敛时会同样触发)。
- **不可变实验清单**:41 条目,内容哈希;`--check` 入回归。
- **版本门禁**:`tools/bump-versions.js`(内容哈希 ?v=)+ SW 三方一致 + pre-push 钩子 + CI。
- **复现**:每个冻结报告的生成工具都在仓库内(`tools/broadband/*.js --write`),随机性显式种子化或确定性化(如 report-demo.json 明确"确定性无 RNG")。

---

## 10. 状态总账

### 10.1 绿(已验证/已冻结)

- GMPE hazardlib 逐位对拍、2626 台站校准、LOEO 反转(19 事件);
- PSHA 引擎自验(闭式锚 1e-12/MC 互验 0.08/守恒 0.005)+ J-SHIS 外部门(高估 1.827×)+ 归因(情景源承担超估);
- 记分卡长周期改善 PASS;SH 混叠守卫落地 + 暴露量化;
- P-SV 全空间锚(A1–A3)、根追踪(R8/R9)、**deviatoric 序列收敛**;
- 动力学破裂 TPV5-AP 反平面验收;
- 全部 19 项 P-SV 锚 + 全量 npm test 绿。

### 10.2 黄(研究态,未接生产)

- `opts.psv` 三分量:分层 deviatoric 已收敛,等 fullTensor 开放项关闭后走 CS v4 预注册门(用户闸门);
- PSHA 绝对水平高估 1.83×:已归因,整改方向=情景率/BPT 复核,未动;
- SH Love 模态极点窗(守卫后残余 max 0.80)。

### 10.3 红/开放(登记在案)

| 开放项 | 机制 | 登记 |
|---|---|---|
| P-SV fullTensor 序列 | 泄漏 P 峰顶带 subdivide cap 依赖(v7 δ 矩阵链已消 det-null 坍缩;cap30/10 系列差 ~30×,cap10/4 点位收敛 16%;残余孤立 null 3 个) | compliance 链 cap 研究(cap10 成本 ~3×)或逐层 Schur 导纳步进(v7 registeredNextStep) |
| CS 短周期分账 | 需要 M8.5+ 近场宽频记录 | cs-arbiter Ds 重跑(待用户 Kyoshin 账号) |
| CVWS 参考解 | 登录墙 | docs/CVWS-UPLOAD.md 用户运行 |
| BPT 时间依赖引擎 | psha-attribution mid-band 负 rate-ratio 指向 | 立项依据已归因 |
| CS v4 预注册门 | P-SV 分层解锁后的产品化前置 | 用户闸门,开跑前预登记 |

---

## 11. 复现索引

| 工件 | 生成器 | tripwire |
|---|---|---|
| `tools/data/psv-scale-diagnosis.json`(v5) | `node tools/broadband/psv-scale-probe.js --write` | tests/psv-scale-diagnosis.test.js |
| `tools/data/broadband-scorecard.json` | `node tools/broadband/scorecard.js` | tests/broadband-scorecard.test.js |
| `tools/data/sh-alias-exposure.json` | `node tools/broadband/sh-alias-exposure.js --write` | tests/sh-alias-exposure.test.js |
| `tools/data/cs-pipeline-report.json` / `cs-arbiter-report.json` / `cs-diagnosis-report.json` | cs-pipeline.js / cs-arbiter.js / cs-diagnose.js | tests/cs-pipeline / cs-arbiter / cs-diagnosis |
| `tools/data/jshis-comparison-report.json` | `node tools/fetch-jshis-comparison.js` | tests/jshis-comparison.test.js |
| `tools/data/psha-attribution-report.json` | `node tools/psha-attribution.js` | tests/psha-attribution.test.js |
| `tools/data/strong-motion-report.json` | `node tools/scorecard-strong-motion.js` | tests/strong-motion*.test.js |
| `tools/data/dynamic-rupture-report.json` | `node tools/dynamic-rupture/run-experiment.js` | tests/dynamic-rupture*.test.js |
| `tools/data/experiment-manifest.json` | `node tools/build-experiment-manifest.js --write` | 入回归 |

内核源码:`tools/broadband/{core,psv,psv-fullspace,hybrid,cs-pipeline,cs-arbiter}.js`;方法细节:`docs/METHODS.md`;物理基准笔记:`PHYSICS_BENCHMARKS.md`。

---

*本报告由 30af0f5 之后的 Rc 反演批(2026-09-09)同步更新;P-SV v6 冻结叙事与开放项以此为准。*
