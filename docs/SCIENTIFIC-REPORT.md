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
| **宽频带管线** | SH 离散波数内核 + Brune/Boore 混合 + 条件谱(CS)管线 + 短周期仲裁者 | 长周期改善 PASS(+0.143);形状门 FAIL 已收口为「合成-vs-GMPE 一致性监视器」(CS_GATE_ROLE:短带=种群+类别结构化配置性质,长带=源种群性质,四条全局治愈全否证);仲裁 INCONCLUSIVE |
| **P-SV 研究内核** | 离散波数全空间/分层 Green 函数,十二轮迭代到终局(§6) | 全空间锚定(残差 ≤0.08);QD 算术五点门 1e-13 级;series 收敛(1.0012);带内无极点实测;**CS v4 门执行完毕,P-SV 水平块对形状门 MEASURED-NO-CURE(生产保持 SH-only)** |
| **动力学破裂** | SH/PSV 交错有限差分 + TSN 滑移弱化,TPV5-AP 官方参数 | 反平面验收通过;CVWS 参考解在登录墙后,不做逐站一致声明 |
| **测试与门禁** | 105 个测试文件、1,142 项测试;不可变实验清单;pre-push 版本门禁 | npm test 全绿为每批提交的先决条件 |

本报告 §6 完整记录了 P-SV 内核十二轮迭代的全部弯路与翻转——包括本批(支尾奇异因子扣除)开始时既定假设被实测**推翻**的过程:v4 冻结的"分支尾 1/√ 奇异"归因是错的,真正的元凶是**未设 qP 时泄漏型 P 波极点坐在实轴上,使波数积分成为主值意义下的发散积分**;v6 又发现登记的 Rc 反演不适用、真缺陷是 expm 传播子静默丢层 Q;v7(δ 矩阵批)落地 MGS 正交化链并修复两个传播子/链真 bug(R2 锚在冻结前抓住 triMul 交叉项丢失;μ* 反变换修复)。终局(§6.17–6.21):QD bigfloat 算术把 1-ulp 混沌压到 1e-13 级、fullTensor 级数十五版不收敛就此结束(below-floor spread 1.0012,绝对值换代为信号级 1.2369);重建的定位器实测带内**本无极点**(detM 洼=远轴弱模态,埋源被积函数指数盲)——P2 负向解决;P1 水平绝对锚 6.03e-13;CS v4 预注册门经 30 分片 ~2.2 天执行,**三带门全 FAIL,P-SV 水平块假设被测量否定**,按预登记退役为 MEASURED-NO-CURE。负结果以可复现形态发表,这正是本体系的方法论输出。

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
- v4 P-SV 激活预注册草案**在开跑前撤回**(预登记撤回也是纪律的一部分)——后经 §6.20 可跑化批重立、§6.21 执行:**三带门全 FAIL,P-SV 假设被测量否定**,生产保持 SH-only。
- **v5 诊断(2026-09-15,PRE_REG_V5 五臂)**:目标构造无 bug(maxMuDelta 0.00466≪0.02);短带 HF 独占(blend 是 fcHz=1 Hz 硬频率分割,份额 1.000)且**应力杠杆 DEAD**(S*=0,残差 0.53>0.15);**长带符号分裂**(kochi 亏损 −0.51..−0.33 vs osaka 超额 +0.50..+0.49)——单一全局 LF 杠杆原理上救不了;LF-gain 倾斜只占形状超额 ~0.1-0.3。实现收获:buildHfSpectrum 的 `(fillScale || 1)` 把 0 当 falsy(HF 归零臂失效),冒烟探针当场抓住——falsy 开关坑第三枚。
- **v6 诊断(2026-09-15,PRE_REG_V6)**:**台柱交换**判长带分裂 SOURCE-OWNED(反转规则 0.198;线性台柱份额 ~40%)——分裂主要跟情景源种群走;**去倾斜重评分**(首跑抓到自家锚点电平污染,形状校正后)U=0.318 判 SYNTHESIS-SIDE:情景种群合成形状比 zhao 热 +0.2..+0.4@0.1s。**种群反差入冻**:真事件上同套合成比观测冷 −0.24..−0.28(arbiter DSYN)而情景种群比 zhao 热——~0.6 dex,配置混淆如实披露。
- **v7 配置对齐重测(2026-09-15..16,PRE_REG_V7 门先于运行)**:把**管线真实配置**(JIVSM 台站柱+网格 vs30+siteCurve+stressByClass+lfGain)放到 13 个真事件 × ~700 台站上——alignedDs(0.2s)=**+0.02**(legacy 裸臂 −0.238),R1 判 **CONFIG-OWNED**:配置链自身携带 ~+0.26 dex 形状;情景种群再叠加 ~+0.3;且**按震源类别强分裂**(0.2 s 中位:地壳内 +0.071、板块间 −0.265、板内 −0.142)。登记治愈候选=对观测锚定的逐类配置链重校准(**未排期**)。
- **v8 逐类 κ 重校准(2026-09-17,PRE_REG_V8,用户排期)**:以 v7 冻结形状按类拟合 κ(物理符号修正后 G1 过:板块间 0.018/地壳内 0.046/板内 0.027),G3 情景非回退门**判死**(短带 0.776→0.96、长带 0.574→0.777)——真事件最优方向与情景门最优方向**反号**,且 1 s 锚坐在缝上,HF 改动经单一振幅尺度漏进 LF 带。逐类单参数治愈线就此关闭;G2 按预登记免跑(任何 FAIL→NEGATIVE)。
- **收口(CS_GATE_ROLE,2026-09-16;v8 判死后终版)**:形状门的语义改判为「shipped 合成 vs 条件谱(zhao)在情景去聚合种群上的一致性监视器」——不是任何一侧的正确性主张。三带 FAIL 作为模型形式+种群性质如实常驻;κ/应力/P-SV/LF-gain 四条全局单参数治愈全部测量否证;生产保持 SH-only,psv 留研究态。

---

## 5. SH 内核长距 Bessel 混叠:暴露量化与守卫(2026-09-06)

- 根因:固定 dkInvKm=0.01/km 只对 r ≲ 63 km 抗混叠(J2(kr) 周期 2π/r);守卫 `dk = min(dkInvKm, (2π/r)/10)`。
- 暴露量化(`sh-alias-exposure.json`):13 事件 756 条台站路径中 **69% 超过 63 km**(中位 88 km);守卫前逐点偏差 p90 0.35 / max 2.08(数量级级);守卫后 max ≤0.9、中位 ≤0.05;记分卡带级影响 ≤0.05 log10 → **文档性重冻,不触发重标定**。
- 残余(守卫后 max 0.80)= Love 模态极点的格点运气,登记后续:SH 侧引入 §7 的分层窗机制。

---

## 6. P-SV 离散波数内核:完整研究史(v1→终局)

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

### 6.8 v8(cap 收官批,2026-09-09):cap 研究阴性——离散化旋钮不是答案

登记的"subdivide-cap 研究"执行完毕,结论**阴性**:cap 2/4/6/10/30 每一档都给出**内部 dk 收敛**的序列(cap4 fullTensor below-floor spread 0.45%、cap2 1.7%),但**跨 cap 值无单调收敛**——fullTensor 0.79(cap6)/1.23(cap4)/0.92(cap2)/2245(cap10)/7-59(cap30);deviatoric 同样漂移(0.0083/0.0096/0.0141/0.027)。即:每个 cap 模式解析了泄漏 P 峰顶带的不同部分,偶极(深度 FD)通道直接继承该模式敏感性。**离散化收紧不能关闭峰顶带表征问题**;登记下一步=逐极点物理表征(残量法模态综合或逐层 Schur 导纳步进)。生产 cap 保持 30,opts.psv 继续 BLOCKED。

同批交付:**BPT 时间依赖引擎**(BPT=IG(μ,λ=μ/α²) 闭式 CDF,尾部渐近 Φ 防 e^{2/α²} 因子对多项式 Φ 噪声的放大——实测 ±0.02 的 CDF 污染;`hazardCurveTimeDependent` 把 BPT 场景源的条件破裂概率与 Poisson 背景按独立通道乘法合成;Nankai 全域 P30=87%(μ117/elapsed 318.75/α0.24)落在 ERC 公表「80%程度」带内=外部锚)与 **SH Love 极点窗**(core.shLovePoles 检测器+阶梯窗+梯形积分;窗 vs 32× 细 brute ≤5%)——后者同时**测量推翻了 v1 的「Love 极点网格运气」归因**:双侧带窗后远场残差 0.797 不动,真机制=格点对 J2×柔度乘积的采样不足(sh-alias-exposure v2,登记收紧 range-adaptive 除数)。

### 6.9 P-SV 锚集(测试即规格)

R1 Rayleigh 根(Rayleigh 三次方程)· R2 RK4 独立积分 · R3 辐射零节点 · R4 逐波数 α 数值装配 · R5 偶极深度 FD 收敛 · R6 频带稳定 · R7 SI 闭式柱柔度 · R8 加宽 Q 暴力对拍 ≤5% · R9 网格无关 ≤10% · **R10 阻尼半空间对拍(v6.2 R1 批,2026-09-09:复模量+复 ν 辐射条件的独立 RK4,实测出 psvEigenvectors 牵引行实 μ 约定偏差 1.4% 并修复;μC 类缺陷在无阻尼锚下不可见=本锚存在的理由)** · **R11 分层对拍(同批:无阻尼+阻尼;首条跨界面独立验证——排障中修掉参照自身两处缺陷:层查找米/公里单位错、W 跳变对需下传到半空间顶取残差(rW=I 只在 R2/HALF 特例成立);生产链被证实正确)** · A1 Kelvin 静态极限 · A2 κ 域=空间闭式 · A2c 约定钉死 · A3 全空间块参照 · SH 侧 L1-L4(Love 窗 vs 32× 细 brute ≤5%)· PSHA 侧 B1-B8(BPT 一致性/单调性/ERC 外部锚/TD 通道往返/uhs 透传)· psv-scale-diagnosis v9(修正内核基线锁)。**全绿为每批提交先决条件。**

### 6.10 v9 重定基 + SH 守卫除数阶梯 + BPT 产品线(2026-09-09)

**v9 重定基**:v4-v8 的全部 fullTensor 系列都骑着实模量半空间导纳(R10 实测的约定偏差)。在 μ* 修正内核上重测:below-floor fullTensor 从无规律非单调塌缩(54.2/58.9/21.3/7.3)变为**干净的单调发散**(28.1→44.4→50.2→54.6,spread 1.95),deviatoric 保持收敛(spread 1.055),全空间锚 0.062≤0.08 不变——**crest 带 OPEN 在可信基线上重确认**,残量法/Schur 导纳仍是生产 opts.psv 的登记阻塞;v8 系列+cap 研究字面量带 PRE-mu*-fix 注记保留。另登记:P-SV 侧混叠守卫仍是 (2π/r)/10,SH v3 阶梯已把 SH 内核移到 80——P-SV 阶梯待测。

**SH 守卫除数阶梯**(sh-alias-ladder.js,v2 登记治愈的执行):48 点×8 频,16× 细参照(320 臂自稳 p95 0.0217 如实记录,压线超 0.02 预登记值)。远场 |ratio−1| p90/p95/max:div10 0.33/0.69/0.80 → div20 0.14/0.21/0.23 → div40 0.05/0.10/0.16 → **div80 0.027/0.034/0.070(过 max≤0.10 门,选定为内核默认)**。代价=线性样本数(远距 8×)。scorecard 同步重冻结=再标定记录。

**BPT 产品线**:`uhs` timeDependent 透传 + PSHA 卡时间依赖开关(#psha-timed-toggle)落地——引擎对用户可见;J-SHIS 对照 v2 加时间依赖臂,**证实预登记诊断**:stationary 臂中段亏损(kochi −0.594/nagoya −0.15)在 BPT 引擎下全部翻正(TD min +0.234)=J-SHIS 曲线中段确实携带更新过程抬升;尾部 4.51× vs 1.83× 非同口径(J-SHIS AVR 是时间无关产品),stationary 臂仍是外部门尾部数字。

---

### 6.11 支点带噪声批:样本级诊断与 in-chain 治愈家族退休(2026-09-10)

v9 把 fullTensor 系列立在了可信基线上(单调发散 28.1→54.6)。本批回答"这个发散到底是什么":在冻结配置(tokyo 0.5 Hz / zs=73 km / r=198.5 km / qP=qS=50)上做样本级测量,结论分四层。

**1. 刺是链条件噪声,不是物理共振(连续性判别器)**。qP=50 时任何真实共振的宽度下限是材料值 k/(2Q)≈0.005/km——物理被积函数在 δ=1e-5/km 的 k 偏移下至多变化 ~0.2%。实测:对照带(0.44/0.46/km)恰好如此(1.000/1.000);支点带样本(0.5112/0.5242/km)在同样偏移下摆动 1.4–15×——**去相关尺度比物理下限窄 500 倍**。这些刺不携带物理信息。

**2. 机制 = 深度差分放大**。偶极通道吃 dC=(Cdn−Cup)/(2dh)。两个证据锁定:加大差分臂长,刺单调塌缩(0.5295/km:4.26e6→6.3e5→1.9e5→4.7e4, dh=0.5/2/5/20 m)而对照点 4 档 dh 完全不变(6.270e3);且 |C| 本身在带内光滑(4.7e-8)而被积函数爆刺——野值只活在深度梯度通道,不在柔度幅值里。

**3. 两代链内治愈实测退休**。gen-1(自适应栅格一致性搜索,psv.js `params.dhAdaptive` 首版):刺塌 5–120×、对照字节不变,但 dk 系列 9.54/12.28/7.95/2.62 非收敛(spread 3.7)——双次一致出口被**相关**噪声骗过(残差方向随 dh 缓慢旋转,相邻臂共享噪声)。gen-2(Richardson 对 D(2h)−D(h),对臂独立的舍入噪声 a/h 精确相消):对照字节不变、刺纹丝不动(0.5187:1.854e6 vs legacy 1.835e6)——证明带内噪声**不是加性测量噪声,而是链输出的 (k,z,dh) 联合确定性野函数**,任何链内栅格组合都无法相消。

**4. 登记治愈收敛到唯一选项**。链内 FD 治愈家族(搜索式与 Richardson 式)整体退休;剩余登记 = **独立表示——逐层 Schur 导纳步进**(v6 原型上行腿稳、下行腿 NaN 是具名阻塞)。legacy 系列在本批逐位复现 v9 冻结(28.092/28.092/44.362)后才开测——基线跨日稳定。诊断 v10 重冻(verdict=`fullspace_anchored_layered_crest_noise_proven_fd_cures_retired_full_tensor_open`),crestDiagnostics 测量块与四个诊断脚本(crest-diagnose/noise-probe/dh-probe/series-run)入库;R 锚 43/43(legacy 零改动)。生产 opts.psv 仍 BLOCKED;P-SV 侧混叠守卫阶梯仍挂账。

### 6.12 裁决批:深配置信任度闭环、Schur 生产接线与阻塞再定位(2026-09-10)

v10 把治愈收敛到「独立表示」一个选项。本批把这句话拆成三件事做完:把裁判修到可信、用可信裁判裁决 legacy/Schur、再把级数重跑一遍。结论分层如下。

**1. 三个互证可信参考建立(HALF@1.2 Hz / zs=73 km / q=50)**。①分段 RK4 裁判(crest-ode-referee.js,边界分段+欠流感知重标)的 Richardson 外推;②平衡特征分解输运链(crest-probe-lib.js:特征向量做真/缩放牵引约定对齐+列归一,κ(E) 从 2.5e8 落到 1e3);③**闭合式半空间 BVP**(crest-halfspace-closed.js:自由面 τ(0)=0 + 半空间辐射 + 源跳条件,6×6 直接解,无任何链代数)。三者两两一致 **4e-3**;闭合解与 Schur **精确差一个全局符号**(跳取向约定)——即数值恒等。

**2. expm 无罪,legacy 链判决落地**。psvPropagator 输出变换到缩放约定后对特征分解 **7e-13**、半群机器净——深配置误差源不在矩阵指数,在 A/W+MGS 残差簿记:legacy 对可信对 **3.4–7.8× 偏离(全 k 段)**且 cap 敏感(_subCap 15/45 摆 0.23–2.7);Schur 对特征链 **1.1e-11**。据此 psvSchurCompliance 生产接线(params.schurCompliance → complianceAt 分发器;legacy 缺省位级不动,R1–R11 锚全绿)。排障实录:特征参考自身两处 bug(增广单位阵写死首行→m4inv 全坏;真/缩放牵引未对齐)曾制造 O(1) 假分歧——探针也要被锚。

**3. tokyo 带内:输运表示系统性病态的独立实证**。与 legacy 同构代数、传播子已验证的特征输运链在带内塌阵(0.5112/0.5295/km 非有限 Cc;带内 |C| 垃圾量级)——机制=源下 337 km 幔内在 k>ω/vp 处渐退,四列输运的动态范围 e^±95 吃掉衰减方向;Schur 上行导纳递推是唯一光滑表示。新增 box 格式 FD-BVP 裁判(crest-fd-referee.js):0.5 Hz 锚点对闭合解 2%,1.2 Hz 欠分辨 OPEN。

**4. 级数判定与阻塞再定位**。Schur 臂 dk 级数(生产接线后实测):fullTensor **194/194/523/680/541 非单调**,deviatoric 对照 0.0178→0.0083(2×)——v10 的「deviatoric 已收敛」实为**表示相对**假象(单表示误差跨 dk 自洽≠物理收敛)。**合规表示已裁决完毕,剩余阻塞是带内比任何网格都窄的极点结构在 k 积分里的未解析贡献**——登记治愈改为极点感知求积(模态扣除/复围道)。诊断 v11 重冻(verdict=`fullspace_anchored_layered_compliance_adjudicated_schur_validated_band_quadrature_full_tensor_open`),psv-schur.test.js 四锚入库(含 R2 裁决锁:legacy 若突然对上闭合解即触发重冻)。生产 opts.psv 仍 BLOCKED。

### 6.13 FD-SH 退化对照批(2026-09-11):SH 裁决反转,分层柔度危机降级为探针自身 bug

v12 时代的「分层柔度裁决危机」(R11:链家族 3.165e-8 vs 网格收敛 FD 2.203e-8 = 30%,无存活独立分层裁判可裁决)由本批关闭。新建 `crest-fd-sh.js`:SH 退化 FD-BVP(HALF 模量,对 shake91 解析锚定 core-SH 0.1–0.34%),本想当 SH 侧独立裁判,却在隔离测试里抓到**两个 FD 探针共享的「源上层失明」装配 bug**(vs1 2.6→0.9:core-SH +46% 而 FD 平线)——**P-SV FD 分层证据就此撤回,链家族站得住**,30% 危机降级为探针自身缺陷。修复路上顺带解决 κ~1e15 的 u/tr 量级混合下裸主元丢小分量:行/列平衡化(解向量按 colS[i] 反缩放)。det 主值扣除路线自此解除阻塞。probe v11 重冻(fdRefereeStatus 撤回 + tokyoBand referee 修正 5.79e-3)。**教训:裁判自身也要被锚——一个没有解析锚的独立裁判给出 30% 分歧时,第一怀疑对象应该是裁判。**

### 6.14 det 主值扣除落地批(2026-09-11):机制交付,series 不被治愈

`psvPoleModelFit`/`psvPoleModelSet`(门 0.15 + 贪心去重:±8γ₀ 阶梯双侧、双 Im 符号 Nelder-Mead、共轭复数 LS + 4× 中位离群剔除)+ `params.detSubtract` 生产接线(拟合极点去窗 + 逐样本减除 + 主支复对数解析回加;失败者回退窗;缺省字节兼容 tripwire)。合成闭式自测:极点位置 1.7e-9、欠分辨极点回加 2.6e-5(素梯形 12–14% 失败,反衬解析回加的必要)。复 k Newton 两路实测不可行:Schur 上行阶步 det 在极点处自身过零→猎点被 null 包围;raw 级联 det = v4 老病。**生产判定 = series 不被治愈**(冻结协议 detSub fullTensor 231.77/231.77/231.77/532.96/770.39/803.88 单调升 spread 1.51;deviatoric 不动)→ 新具名阻塞 = **极点定位器失准**(psvModalPoles 候选偏 0.1–0.2/km,门+去重后 7 模型)。附带一次公开撤回:「v11 冻结 schur 系列伪值/不可复现」判读是本批旋转张量侧脚本的可复现性错觉——冻结协议的 full 张量是未旋转源系牛顿量,已提交代码原样复现(tensorProtocolNote 入冻)。verdict=`…_pole_subtraction_shipped_but_series_open_candidates_mislocate`。

### 6.15 极点定位器可行性批(2026-09-12):1-ulp 判别器判死原生定位器

判别器从 v10 的 1e-5/km 偏移连续性检查(粗了 7 个量级)升级为 **1-ulp 阶梯**(任何真共振在 ulp 级 k 偏移下只动 (ulp/γ)²≈0;O(1) 摆动 = 舍入混沌非结构)。对照 k=0.40/km:积分函数与 C 直到 1e7 ulp 逐位稳定(全稳定数位);簇带 0.70/0.73/0.76/0.80/km:积分函数 1 ulp 摆 −89%~+1203%(零稳定数位),C 15–567%,dh 0.5 与 32 m、全源深度同然。机制闭合:detM 坐在 ~1e-16·|M|² 上(cond(M)~1e16),2×2 行列式消减噪声就是输出量级——与 v11「Schur 上行光滑」不矛盾(递推光滑,输出继承地板);v6 的 det(Rc) 定位器在 k≳0.65 结构性致盲(detM 桶极小 −6.1→−39.5、0.002/km 间距去相关、0.900 处 −690 消减针)= v12「候选失准」的根因。冻结拟合表降级为单样本锚定(候选 0.6173 的 γ₀=0.11/km 把 12 个梯子样本撒到 0.18–1.50/km,rel 0.02 反映那一个样本而非场干净度)。series 后果(seriesDhSensitivity 活测):dh FD stencil 把 fullTensor 系列在 dk0.02 挪 194/266/44.9/28.4/6.6(dh 0.5/2/16/32/64,30× 无钉死),无任何截断安全 dh 收敛——**本配置上不存在可解释为信号的 series 值**;v10「链内 FD 治愈退休」延伸到固定大 dh stencil。登记下一步 = Schur 链全补偿算术(DD),验收门 = 1-ulp 判别器在簇带翻转。verdict=`…_locator_infeasible_zero_stable_digits_series_noise_dominated`。

### 6.16 DD 算术批(2026-09-12):门部分通过,步进消减现形

`psv-dd.js`:Dekker/Knuth 原语无 FMA;特征向量半空间导纳、expm 传播子含 μ* 反变换、上方联合缩放乘积、C=−e^{−σ}(Y·Q11−Q21)⁻¹ 全链 DD;材料积精确 two-product;`params.ddCompliance` opt-in 缺省字节兼容。上行递推加**逐层传播子归一化**(Y 对 P→αP 不变,代数免费)消掉 e^{±114} 隐逝尺度。路上两个真 bug 被交叉验证抓住:①lamC 虚部误用复数减法 cddSub(实数 DD 被当复数拆开→嵌套 NaN);②m4maxabsDD 用复数零初始化(毒化全部 ddToNumber 比较)——而「验证」它的手动循环自身在吞 NaN(NaN 比较恒 false)。**本批最宽教训:比较型检查可疑地轻易通过时,先用已知坏输入测它。** 验收门实测(v14 probe):0.80/km 过(1-ulp 混沌 −76%→2.9e-5%)+ 对照带 DD 噪声级(双路径一致 1.2e-11;DD ~5 ms/eval vs double 1.5 ms);0.70/0.73/0.76 仍混沌(1 ulp O(10–600%))——**新具名阻塞 = 上行步进 det(P22−Y·P12) 消减 5e30–8e31**(upLegStepCancellation 诊断入导出;导纳递推穿越 below-source 子系统近共振 + P 波隐逝穿越 190 km 幔层 e^{±114})。输出混沌 ≈ eps × 步进消减 × O(1–40):DD 的 1e-32 恰被吃光,登记 quad-double(eps 1e-64)。verdict=`…_dd_landed_gate_partial_step_cancel_5e31_quad_double_registered`。

### 6.17 QD 算术批(2026-09-12):五点门全过,series 十五版不收敛就此结束

`psv-qd.js`:BigInt bigfloat = 值 m·2^e、尾数归一 256 位(eps ~1.7e-77 = 实测需求 1e-64 的 13+ 个量级);全原语正确舍入(精确整数积 + 精确余数舍入);exp/log 自适应级数(ln2 = 2·atanh(1/3));expm4 项数自适应化(DD 时代常数 24 项只够 eps 1e-32);链 1:1 移植含上行逐层归一化;`opts.pbits` 逐调用改尾数 = 失败时的诊断阶梯。路上真 bug = **移植丢密度因子 ρ**:propagatorBF 的 c1s/w2vs2 减了裸 ω²,DD 原文是 ρω²——两个 A 条目差 2650×、expm 输出差 e^66;被组件级 DD 对照抓住,而此前两次 scratch 对照全过(**scratch 从移植版抄公式把 bug 一起抄了 + NaN 吞比较——必须对被裁定过的模块输出对照,自己的拷贝对自己的拷贝一致什么都没验证**)。另有 4×4 单位阵写成一维向量、退休的共享传播子三联(prepare 按 target 深度切层,索引共享会静默算错物理层)。

验收门全过(v15 probe 活测,确定性):1-ulp 判别器全部五点翻白——0.40/0.70/0.73/0.76/0.80/km 积分函数摆 1e-14%~1e-11%(门 1e-6%,余量 8–11 个量级),65536 ulp 仍 ≤1e-5%;C(zs) 0.73 处 1 ulp 稳 2.9e-14%;crest 守卫 null 消失 = 可解场存在;交叉路径:0.40 对照处 QD 复现 DD 到最后一位舍入双,对双精度 1.245e-11(=双链噪声级)。**步进消减预算更正**:0.40=1.727 与 0.80=2.783e26 跨精度复现,但 0.76/0.73/0.70 真消减 8.6e30/3.4e35/6.3e42——v14 表(5e30–8e31)被 DD 自身 eps 饱和(DD 链分辨不出低于 eps×scale 的 det);QD 输出噪声 ~1e-77×1e42=1e-35,过门余量 23+ 个量级。成本 ~0.07 s/链(DD 5 ms,double 1.5 ms)。

series 产出(qdSeriesUrm,9 run 并行):dh 不变性 2.1e-5/2.2e-5(v13 的 7–30× 噪声实现挪动消失——「dh=噪声旋钮」判定死亡);dk 轴 1.243517(clamp 0.00316/km)→1.237305(0.002)→1.236935(0.001)→1.235870(0.0005)= −0.502%/−0.030%/−0.086%,**below-floor spread 1.0012 ≪ 冻结 1.03 收敛门——v12「>1.05 收敛时自觉解冻」条件触发,15 个版本的不收敛到此结束**;deviatoric 0.02216335→0.02214221。绝对值换代:双链时代 194.41/28.09/44.36 是噪声积分,QD 系列是本配置首个信号级测量。verdict=`…_qd_landed_gate_full_series_dh_noise_dead_below_floor_converged_locator_reopens`。

### 6.18 定位器重建批(2026-09-12):定位器交付,但带内本无极点——P2 负向解决

`psvModalPoles` 增 `params.qdCompliance` 分支:同一洼地协议(地表源 zs=1e-4、2.5e-4/km 格、突出度 0.5、黄金分割细化、HWHM γ、半空间支点排除),扫描对象换 Schur detM = det(Y·Q11−Q21) 大浮点链——zs≈0 时上方乘积塌缩 detM=det(Y)=表面导纳极点条件,与 det(Rc) 同物理;候选文件旁路 + `opts._qdScanStep` 测试粗化,双路径字节不变。实测(f0p5/f1p2 全扫各 ~57 min,冻结字面量):QD 定位器 ulp 精确(log|detM| 1–16 ulp 恰 0;双精度场 0.002/km 去相关)+ 噪声森林消失(f0p5:17 双时代候选[8 个 γ 打 5e-4 地板=噪声洼]→7 个真实宽度洼地;f1p2:45→9;远带位置逐位吻合 2.43/3.80)。

**转折 = detM 洼不是被积函数极点**:洼深仅 0.5–1.9 log 单位(对 15.7 背景)= 远轴弱模态;埋源 QD 被积函数无极点——0.3–0.8/km 光滑 Bessel 调制 1e4–9e4,ω/vs_half≈0.70/km 以上指数塌亡(0.80 处 1.4e4 → 0.85 处 1e2 → 0.95 处 7e-7 → 1.54 处 1e-33 → 3.8 处 1e-110)。支撑带全部候选诚实过不了 0.15 拟合门(rel 0.25–0.74——A/(k−kp)+B 模型类无法表示 Bessel 振荡被积函数),死带「保留」是拟合数值尘埃。**v12「候选失准」记录就此解决 = 本无可找**:双时代拟合锁在链噪声刺上,而噪声刺恰坐落真信号塌亡处;v13「定位器不可行」判读是场的算术盲而非洼地协议缺陷。唯一真近轴结构 = f1p2 1.70–1.80/km 陷缚模态族(剪切支点 1.676 之上;detM 洼底穿透 1e-300 双精度返回地板,1.783 处 QD 解在洼底 null = eps-窄真 null),但埋源被积函数对它指数盲(隐逝半空间腿)。detSubtract 在可解场上实测 no-op(六 run,82–128 min/run:full 1.242353/1.242268/1.236453/1.235651 @dk 0.02/0.002/0.001/0.0005——对 plain QD 系列全部 ±0.50% 内,below-floor spread 1.0054 仍收敛)。CS v4 前置:P2 负向解决、P3 已完成(div10),P1 是唯一剩余门。坑两枚入冻:①f1p2 ulp 阶梯初读「噪声」实为 detM 洼底穿透双精度返回地板(ladder 量的是 log() 的 1e-300 守卫抖动非链);②驱动器候选文件往返 1/km-vs-1/m 单位错(候选静默掉到 DC 尺度)——跨文件边界的单位要断言。verdict=`…_qd_locator_built_band_pole_free_subtract_measured_noop_series_converged`。

### 6.19 CS v4 P1 锚批(2026-09-13):组合端到端精确,双链地板机制定量化

psv.js 两生产钩子(缺省字节兼容):`params.closedFormHalfspace`(crest-halfspace-closed.js 闭式半空间 BVP 合规注入——自由面+辐射+源跳 6×6 直解,单位真牵引,无链约定;符号 −1 按裁决跳取向;HALF 单层栈限定)+ `params.poleWindows:false`(跳过定位器——v16 实测生产带无极点、subtraction no-op,legacy 定位器 ~60s/ω 是死重)。

P1 锚实测(`tools/broadband/psv-horizontal-anchor.js`,**门预注册在先 ≤1e-2**):生产管线 vs 闭式 BVP 端到端(共享积分器与水平块代数,注入式对照),HALF {strike-slip, thrust-DC}×{0.5, 1.2 Hz}×zs33。**QD 臂 PASS@worst 6.03e-13**(比门低 11 个量级——单位/约定/积分器/块代数/分层合规的组合端到端精确;纯 Mxy 的 ur=0 正确对称零)。**双精度臂配置依赖 FAIL**:f0.5 3.8e-6(过)但 f1.2 8.34——机制 = 双链 ~1e-16 detM 消减地板踩在 Rayleigh 共振 detM 洼地上(HALF f1.2 的 k=1.9/2.1/2.3/km 三点:大浮点链与 BVP 全部打印数字逐位相等而双链差 6000×;RK4-ODE 裁判 4e-3 第三方)——**v13–v15 算术故事延伸到每一根柱**:半空间 Rayleigh 族的 detM 洼在 f≳1 Hz 就坐进权重带,非 tokyo crest 特有。

CS v4 运行判决 = **NOT EXECUTABLE AS PRE-REGISTERED**(入 PRE_REG_V4):诚实门臂必须跑 QD,而 QD ~0.21 s/合规三联 → ~24–30 h/(case,bin)(~197 频 × ~2500 k × 3 链),~50 case-bin 对 = 多月计算;P2 负向解决 + P3 完成如实入账;登记治愈 = 两级接线(双链打底 + detM 洼邻域大浮点替换,~10× QD 削减)或 1-ulp 认证的缩范围 v4。hybrid.js v4 臂接线就绪(psvHorizontalOnly/psvSchur/psvNoPoleWindows);tripwire:cs-pipeline 7/7 + broadband-psv 12/12(钩子契约:Schur≡BVP 逐项 <1e-9 / 多层栈 throw / poleWindows 中性 <1e-4)。

### 6.20 CS v4 可跑化批(2026-09-13):多月计算压进 ~17 小时墙钟

①`psv.js params.fdChannels:false`:偶极自由张量(mzz=mxz=myz=0,旋转后清零)的 Cup/Cdn 深度 FD 通道是死重——1 链替代 3 链 = 3×;调用方契约 = 零分量。首版 **2×2 复零矩阵写成 `[[0,0],[0,0]]`(两复对的向量)**:Cdn[0][0]=标量 0 → csub(0,0)=[NaN,NaN] → 被积函数全 NaN;FDDBG/ITDBG 双向探针逐层定位后修为 `[[[0,0],[0,0]],[[0,0],[0,0]]]`——v15「4×4 单位阵写成 1×4」同类坑重演,**complex 矩阵零的嵌套层级 = [层][行] = [re,im] 三层**。②hybrid `opts.psvQd`(大浮点链 = P1 实测无地板路径)+ fdChannels 随 psvHorizontalOnly 联动。③`cs-pipeline --v4` 运行器:双臂 a_shOnly(v3 原样基线)vs b_psvHorizontal(psv+psvHorizontalOnly+psvQd+psvNoPoleWindows,T1/T2 水平块大浮点链),LF gain 双臂同加(隔离块效应,披露),门限 v3 不变,独立报告;`--shardIdx/--shardN` 分片 + `--v4-merge` 合并。**分片布局 = shard s → case s%nCases × realization-group floor(s/nCases)**(shardN 须为 nCases 倍数;首版 ci%shardN 在 25/6 形状下 19 片空转且每 case 只跑 1/25——发射后才发现,杀阵重排重发)。**synthesize() psv opts 透传修复**(原 Object.assign 只带 common 字段,psv opts 全被丢弃 = hybridPsv 静默跑成 shOnly,pilot 0.0 min 曝露)。④pilot 实测:fdChannels 恒等逐位 ✓;tokyo f0.8 水平块 double-vs-QD 端到端差 46%(v4 动机在真柱定量坐实);QD 削减后 165 s/ω(39×);双 pilot realization 201.1/203.1 min(双样本锁定)。⑤30 分片全门阵列发射(6 case × 5 组)——**nohup 孤儿进程被会话清理杀 27/30 的坑**(日志干净终止、无 JS 错误 = 外部击杀),改工具托管 run_in_background 逐分片发射后 30/30 存活;频率抽稀测量被同场清理误杀,登记下一批。

### 6.21 CS v4 门阵列执行批(2026-09-15):三带门全 FAIL,预注册假设否定——终局

30 分片 ~2.2 天墙钟落地(快案例 kochi/osaka 先退场,12 个 tokyo 慢片收尾)。merge 两处修复:①runV4 报告块 `kappaSec` 简写引用未定义(从 v3 段复制漏改,函数内叫 kappa);②**merge 按 (site,rp,arm,i) 去重**——分片阵列把 hybrid 全 25 实现在每片重跑(5 份冗余,唯一差异 = synthSecs 计时字段),psv 组布局实测正确(每片 i%5==floor(s/6));去重后 300 唯一行,**gate 数字对拍逐位不变**。

**裁决(tripwire 数字锁,900 行 0 invalid)**:

| 带 | psv 臂 | shOnly 臂 | 门限 | 判定 |
|---|---|---|---|---|
| 0.1–0.5 s | 0.794(kochi RP2500@0.15s) | 0.776 | 0.30 | FAIL |
| 0.5–2 s | 0.398(kochi RP475@2s) | 0.432 | 0.25 | FAIL |
| 2–5 s | 0.727(osaka RP2500@5s) | 0.574 | 0.25 | FAIL |

中带边际改善(0.432→0.398)而短带 +0.018、长带 +0.153 恶化;containment 0.334 vs 0.385(门 0.8,双 FAIL);pgaRatioDelta +0.03 在 ±0.05 非回退裕度内。per-case 混合:tokyo RP2500 改善(0.533→0.434,containment 0.462→0.615),tokyo RP475 退化(0.923→0.462),osaka/kochi ~不变。

**处置 = P-SV 水平块退役 MEASURED-NO-CURE**:生产保持 v3 SH-only 臂;QD/fdChannels/poleWindows/horizontalOnly 接线留研究态;runVerdict 入 PRE_REG_V4(whyNotRunNow 标 SUPERSEDED 留决策链)。带形失配的下一假设在「缺 P-SV」之外(κ 与 LF-gain 否证照旧):候选 = 条件谱目标构造本身 / HF-LF blend 拓扑 / 逐 bin 参数重拟合,均未立项。

本批从发射到收尾跨三个会话,途中四类缺陷(分片布局缺陷、nohup 清理连杀、复制漏改的未定义引用、冗余重跑的记账虚高)全部被廉价检查(进度计数、hash 对拍、抽样比对)在冻结前抓住——**900 个 QD 实现只有一个版本进入冻结报告,这正是六条纪律想要的形态:负结果也要以可复现的形态发表。**

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
- P-SV 全空间锚(A1–A3)、根追踪(R8/R9)、**deviatoric 序列收敛**;QD 算术五点门 1e-13 级 + fullTensor series 收敛(spread 1.0012,信号级绝对值 1.2369)+ 带内无极点实测 + P1 水平锚 6.03e-13;
- 动力学破裂 TPV5-AP 反平面验收;
- 全部 P-SV 锚 + 全量 npm test 绿(1,142 项);CS v4 门执行完毕(900 QD 实现 0 invalid,数字冻结于 cs-pipeline-v4-report.json)。

### 10.2 黄(研究态,未接生产)

- `opts.psv` 研究态(判定已关闭):QD 链全绿,但 P-SV 水平块对 CS 形状门 **MEASURED-NO-CURE**(§6.21)——接线保持 opt-in 研究态,不再等待生产化;
- PSHA 绝对水平高估 1.83×:已归因,整改方向=情景率/BPT 复核,未动;
- SH Love 模态极点窗(守卫后残余 max 0.80)。

### 10.3 红/开放(登记在案)

CS v4 线关闭两项:P-SV fullTensor 序列(v12 解冻条件触发,QD series 收敛,§6.17)与 CS v4 预注册门(执行完毕,假设否定,§6.21)——均从开放表移除。 2026-09-16 再收口:CS 带形失配诊断线(v5/v6/v7 三批)完结,开放表中的失配行改写为唯一剩余候选(逐类配置链重校准,未排期)。 2026-09-17 终版:该候选被 PRE_REG_V8 的 G3 判死,治愈线全部关闭。

| 开放项 | 机制 | 登记 |
|---|---|---|
| CS 短周期分账 | 需要 M8.5+ 近场宽频记录 | cs-arbiter Ds 重跑(待用户 Kyoshin 账号) |
| CVWS 参考解 | 登录墙 | docs/CVWS-UPLOAD.md 用户运行 |
| BPT 时间依赖引擎 | psha-attribution mid-band 负 rate-ratio 指向 | 立项依据已归因 |
| (CS 带形失配治愈线已全部关闭) | v8 逐类 κ 重校准被预注册 G3 判死(短带 0.776→0.96/长带 0.574→0.777,真事件与情景门最优方向反号+锚-缝耦合);κ/应力/P-SV/LF-gain 五条参数治愈全部测量否证 | 无剩余候选;形状门保持监视器角色(CS_GATE_ROLE) |

---

## 11. 复现索引

| 工件 | 生成器 | tripwire |
|---|---|---|
| `tools/data/psv-scale-diagnosis.json`(v16,含 QD 臂/定位器/series 冻结字面量) | `node tools/broadband/psv-scale-probe.js --write` | tests/psv-scale-diagnosis.test.js |
| `tools/data/cs-pipeline-v4-report.json`(+30 分片文件) | `node tools/broadband/cs-pipeline.js --v4 --shardIdx s --shardN 30` ×30 → `--v4-merge --shardN 30` | tests/cs-pipeline.test.js(v4 数字锁) |
| P1 水平绝对锚(6.03e-13,PRE_REG_V4.p1Anchor) | `node tools/broadband/psv-horizontal-anchor.js`(门预注册在先) | tests/broadband-psv.test.js 钩子契约 |
| QD 定位器扫描/series | `node tools/broadband/psv-qd-locator.js` / `psv-qd-detsub-series.js` | tests/psv-qd.test.js |
| `tools/data/cs-diagnosis-v2-report.json`(v5 五臂) / `cs-diagnosis-v3-report.json`(v6 交换+去倾斜) | `node tools/broadband/cs-pipeline.js --v5-diag` / `--v6-diag` | tests/cs-diagnosis.test.js |
| `tools/data/cs-align-retest-report.json`(v7 管线配置×真事件) | `node tools/broadband/cs-align-retest.js`(~160 min,台站 90 s 预算守卫) | tests/cs-diagnosis.test.js |
| `tools/data/cs-kappa-by-class.json` + `cs-kappa-scenario-report.json`(v8 拟合+判死) | `node tools/broadband/cs-kappa-recal.js` + `cs-pipeline.js --kappa-scenario … --write` | tests/cs-diagnosis.test.js |
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

*本报告由裁决批(2026-09-10)同步更新;P-SV v11 冻结叙事与开放项以此为准。*
