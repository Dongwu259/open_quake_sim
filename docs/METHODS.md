# quake_sim 方法文档(v6.1 开发中)

> 目的:把"我们算了什么、用什么方程、参数从哪来、哪里校准过、哪里没验证"
> 集中到一处可引用的地方。数值细节与全部冻结数据见
> `PHYSICS_BENCHMARKS.md` 与 `tools/data/experiment-manifest.json`
> (每个冻结工件的内容哈希 ID)。本文档是索引 + 主控声明,不复制数值。

## 1. 震源与强地面动

| 模块 | 方法 | 参数来源 | 校准 | 已知限制 |
|---|---|---|---|---|
| GMPE 主路径 | Si & Midorikawa (1999) 距离衰减;Zhao et al. (2006) 忠实实现(板缘/板内);逻辑树 3 分支 LLH 权重;**区域模式地壳内事件 → Boore et al. (2014) BSSA14/NGA-West2 忠实实现(Rjb,原生 Vs30 线性+非线性场地,区域 Δc3:日/意 LowQ)** | 论文系数逐字(hazardlib 交叉断言 `gmpe-fixtures-zhao2006.json` / `gmpe-fixtures-bssa14.json`,max \|Δln\| < 1e-12) | 2,626 冻结台站 modelBias(强度偏差 +0.685→+0.086,仅日本);LOEO 报告如实记录不外推;**v6.7 区域观测验证:15 区域事件 2,491 冻结台站(USGS Shakemap stationlists,仅仪器记录)记分卡 `region-obs-report.json`——BSSA14 crustal 偏差 PGA −0.17 log10(加州)/−0.14(意大利)/−0.14(台湾)/−0.25(新西兰),zhao2006 区域板缘 −0.55 log10(智利,无 NGA-Sub 的量化代价,诚实记录不外推校正)** | 远场点源弱(tohoku);modelBias 是 6 事件经验对齐,不是普适校正;BSSA14 盆地项关闭(无 z1.0 数据)、深度只经 h 准深度进入;区域记分卡为原生物理残差(未施任何校正),近场峰值因合成断层光滑化系统性偏低 2-4×(如实记录) |
| 饱和与上限 | Zhao 大震有效震级压缩 + tanh 软上限(3200 gal/250 cm/s) | 2011 观测极值锚 | — | — |
| 不确定性 | τ/φ 分量拆分、JB2009 空间相关、FFT 嵌入集合场(40 成员,P10-P90) | 论文公式 | 可靠性/覆盖报告(0.696/0.811) | detect 模式禁用防真值泄漏 |
| 场地反应 | 1D 等效线性(Darendeli 2001 曲线 + Thomson–Haskell 传递)+ S/B f0(Vs30) 先验合成剖面 | Darendeli 论文表逐值;KiK-net 197 站派生比(DOI 10.17598/NIED.0004) | eqlin-sb 臂:强度 bias −0.154→−0.044 | S/B 幅值不可迁移(实测死路,仅 f0 锚定) |
| 走时 | IASP91 分层(默认)/ JIVSM 逐柱 Snell 组合(选项) | IASP91 表;JIVSM V4 官方 LYRD | S−P 差分冻结拾取:IASP91 0.83 s vs JIVSM 0.94 s 中位——JIVSM 不占优,默认保持 iasp91 | K-NET 记录器缓冲使绝对到时不可恢复 |
| 方向性/脉冲 | Bayless & Somerville (2013) 全式(PEER 2013/09 逐字);Shahi–Baker 脉冲概率 + Mavroeidis 注入 | 论文系数 | — | 脉冲 ±15% 记录一致性未验证(需 Baker-2007 分类器);PGA 方向性为零是模型本意 |
| LPCM 长周期 | Brune 源 × Q 路径谱锚定 PGA + 区域 Q0 + JIVSM 盆地因子 | 官方 5/15/50/100 cm/s 阈值 | 三事件锚(Tohoku-4/Noto-2/Hyuganada-3) | 谱代理方法,非时程 |

## 2. 动力学破裂(R6,v6.0 新增)

2D 速度-应力交错网格 FD + 分裂节点牵引(TSN)线性滑移弱化自发破裂;
SH(反平面)/P-SV(面内)双模式;扰动松弛型海绵;SH 垂直走滑断层的
水平自由面用精确镜像。验证:解析锚(辐射阻尼 μ/2cs 收敛、静态位错核、
能量闭合、分辨率自收敛、对称性),SCEC TPV5 官方参数反平面约化全流程
运行并冻结站点序列;**未完成**:CVWS 官方参考解逐站对比(登录墙,用户
运行手册 `docs/CVWS-UPLOAD.md`)、PSV 超剪切转换阈值校准(诚实边界,
见 PHYSICS_BENCHMARKS v6.0 段)。运动学震源的质量诊断(应力降/辐射能量/
视应力/辐射效率/破裂速度拟合)以 `Physics.sourceBudget` 进入信息页。

## 3. 概率地震危险性 PSHA(v6.1 P1 新增)

震源模型(自算,非官方 J-SHIS 模型):USGS ComCat 日本域冻结目录
(M≥5.0,1923 起,8,883 事件,公有领域)→ 项目自定义窗去簇(非已发表
算法,窗/半径公式冻结于报告)→ 完备性扫描(Mc=5.0@1980,十年率 CV
0.131,预登记选择规则)→ 0.25° 网格 GR(Aki 1965 MLE 逐类 b:
crustal 0.84 / interplate 1.14 / intraslab 1.16)+ 自适应 top-hat 平滑
(25/50/100 km,逐类质量归一化,修正前偏差 1.05/1.32/1.21 冻结在报告);
情景源南海海槽 M9.0 与首都直下 M7.3 的年率取地震本部公开 30 年概率
换算(−ln(1−P30)/30)。GMPE 中位与 σ 复用三条主路径逻辑树(LLH 权重),
**modelBias 故意不施加**(LOEO 证据:held-out 不泛化)。Poisson 年超越
率积分:`Physics.hazardCurve`(等面积圆破裂面 Rrup 代理;逻辑树认知
分位以 3 曲线 branch-set 集合近似,公开记录)。验收(预登记,未读任何
外部对照前冻结):闭式锚 1e-12 一致 + Monte Carlo Poisson 目录互验
|ln rate|<0.08 + 单调性/分位序 + 逐类速率守恒 |ratio−1|≤0.005
(`tests/psha-engine.test.js` / `tests/psha-source-model.test.js`)。
**已知限制**(全部在模型 provenance 与 ROADMAP v6.1 记录):日本海沟
M9 级复发无情景承载(三陆长周期危险低估)、Sagami 海沟 150 km 缓冲把
关东浅源事件归入 interplate、类级 rake 简化、绝对水平 vs J-SHIS 官方
曲线的对照是**待办外部门**(用户取数,完成前不做等价性声明)。

### 3.1 区域 PSHA 源模型(v6.7 D 新增,2026-10-01)

同一管线参数化到五个全球区域(`tools/build-psha-source-model.js
--region=<id>`,目录 `tools/fetch-comcat-japan.js --region=<id>` 抓
ComCat 区域窗冻结:加州 931 / 意大利 758 / 智利 4,616 / 台湾 1,556 /
新西兰 1,011 事件,1923 起 M≥5.0):区域 bbox(包 bounds 外扩 ~2°)、
区域 Mmax 约定(粗公开记录值,非官方;智利板缘保留 1960 M9.5 尾部)、
构造分类 trench 线直接复用 `Physics.REGIONAL_SUBDUCTION_LINES`(与
app 构造先验同几何;意大利无注册俯冲线=无板缘类)。**区域包无情景源**
——未策展公开区域特征断层复发率(UCERF3/NSHM 等),纯网格 GR,已知
大断层附近长重现期危险低估,如实列入包 limitations。区域 GMPE 树冻结
进包 `gmpeTree` 字段:crustal=BSSA14 单分支(NGA-West2,区域非弹性
变体 italy→lowQ 其余→base;si-mid/kanno 为日本标定不外推),板缘/板内
=zhao2006 单分支(无 NGA-Sub;C 批实测智利板缘 −0.55 log10 偏低,危险
水平偏保守方向如实记录);SA 周期仍塌缩 zhao2006 单模型(唯一带谱行
的打包 GMPE,区域谱形未标定)。引擎 `Physics._pshaBranchesFor` 消费
`sourceModel.gmpeTree`(缺省=日本三分支逻辑树,字节兼容),
`_pshaBranchMotion` 增 bssa14 分支(variant 随分支透传)。app 侧:区域
激活时 PSHA 卡加载 `geojson/psha-source-model-<rid>.json` 正常计算;
**本批修复真 bug**——loader 自 v2 批(2026-09-04)起只接受
`psha-source-v1` 而 bundled 日本模型已是 v2,卡片在生产上停了 27 天
waiting 态(psha-region 测试锁 v1|v2 接受契约);时间依赖 (BPT) 开关
区域模式禁用(区域包无 BPT 更新源,南海专属)。验收:五区域城市锚
(LA 304 / 罗马 96 / 圣地亚哥 775 / 台北 593 / 惠灵顿 537 gal@RP475,
无外部官方对照=不做等价声明)+ 逐类速率守恒 ratioAfter=1 +
`tests/psha-region.test.js` 8 锚。

## 4. 海啸

非线性浅水(二阶 MUSCL,CFL 0.15)+ 两级嵌套双向 AMR(0.15°→0.025°,
生产比 6)+ 可选 Peregrine [0,2] 频散修正(v5.8);潮位基准偏移、
Manning 糙率场(标量默认)、逐子断层时变 dtopo。海底变形 Okada/DC3D
双实现交叉。验证:静水/脉冲穿缝/反射率基准 + 3 事件预警区记分卡
(命中率 50%,小样本如实记录)+ 1960 智利越洋频散案(到时 23.8 h 与
史实一致)+ **v6.7 区域海啸观测记分卡(`region-tsunami-scorecard-report.json`:
Maule/Illapel/Kaikōura 三事件 17 个策展观测点(tide-gauge 与 runup 分型),
区域地形格 standalone 单格求解=app `_bathyCoarseCovers` 同路径,NCEI/PTWC
不可达故全部值来自开放一手文献,逐条记录级引用)**。已知未收敛:
近岸峰值随分辨率单调增(0.025° 未收敛,ROADMAP R5);Kaikōura Sumner
验潮站实测最大 ~4 h 到达,超出 7200 s 记分地平线(如实记录)。

## 5. EEW 反演与实时

多轨迹网格搜索定位 + 前向 GMPE 一致震级反演(斜坡门控截尾中位数 +
巨大地震抬升)+ PLUM 近场外推;实时套件(Kmoni/EEW/551/552)与服务器
回放。校准:EEW 首报抬升 0.7 M(冻结探针报告)。全部为模拟/研究用途,
不构成业务预警能力(声明边界,ROADMAP 第二节)。

## 6. 数据与许可

数据来源、申请路径与入库红线:ROADMAP 附录 A 许可矩阵 + research
manifest(`public/data-catalog.js`,4/5 角色认证)。NIED 原始数据绝入
库,只入派生量(DOI 10.17598/NIED.0004 等署名)。

## 7. 版本与可引用性

- 版本与构建:`?v=` 内容哈希 + 派生 SW 版本(`tools/bump-versions.js`);
- 实验不可变标识:`tools/data/experiment-manifest.json`(`qsx1-<sha256[:16]>`);
- 引用与 DOI:`CITATION.cff` + `.zenodo.json` + `docs/DOI-RELEASE.md`
  (Zenodo 发布为用户动作);
- 复现:任一环境执行 `docs/REPRODUCE.md` 的命令序列并比对冻结门禁。
