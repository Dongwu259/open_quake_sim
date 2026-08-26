# quake_sim 方法文档(v6.0)

> 目的:把"我们算了什么、用什么方程、参数从哪来、哪里校准过、哪里没验证"
> 集中到一处可引用的地方。数值细节与全部冻结数据见
> `PHYSICS_BENCHMARKS.md` 与 `tools/data/experiment-manifest.json`
> (每个冻结工件的内容哈希 ID)。本文档是索引 + 主控声明,不复制数值。

## 1. 震源与强地面动

| 模块 | 方法 | 参数来源 | 校准 | 已知限制 |
|---|---|---|---|---|
| GMPE 主路径 | Si & Midorikawa (1999) 距离衰减;Zhao et al. (2006) 忠实实现(板缘/板内);logic-tree 3 分支 LLH 权重 | 论文系数逐字(hazardlib 交叉断言 `gmpe-fixtures-zhao2006.json`) | 2,626 冻结台站 modelBias(强度偏差 +0.685→+0.086);LOEO 报告如实记录不外推 | 远场点源弱(tohoku);modelBias 是 6 事件经验对齐,不是普适校正 |
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

## 3. 海啸

非线性浅水(二阶 MUSCL,CFL 0.15)+ 两级嵌套双向 AMR(0.15°→0.025°,
生产比 6)+ 可选 Peregrine [0,2] 频散修正(v5.8);潮位基准偏移、
Manning 糙率场(标量默认)、逐子断层时变 dtopo。海底变形 Okada/DC3D
双实现交叉。验证:静水/脉冲穿缝/反射率基准 + 3 事件预警区记分卡
(命中率 50%,小样本如实记录)+ 1960 智利越洋频散案(到时 23.8 h 与
史实一致)。已知未收敛:近岸峰值随分辨率单调增(0.025° 未收敛,
ROADMAP R5)。

## 4. EEW 反演与实时

多轨迹网格搜索定位 + 前向 GMPE 一致震级反演(斜坡门控截尾中位数 +
巨大地震抬升)+ PLUM 近场外推;实时套件(Kmoni/EEW/551/552)与服务器
回放。校准:EEW 首报抬升 0.7 M(冻结探针报告)。全部为模拟/研究用途,
不构成业务预警能力(声明边界,ROADMAP 第二节)。

## 5. 数据与许可

数据来源、申请路径与入库红线:ROADMAP 附录 A 许可矩阵 + research
manifest(`public/data-catalog.js`,4/5 角色认证)。NIED 原始数据绝入
库,只入派生量(DOI 10.17598/NIED.0004 等署名)。

## 6. 版本与可引用性

- 版本与构建:`?v=` 内容哈希 + 派生 SW 版本(`tools/bump-versions.js`);
- 实验不可变标识:`tools/data/experiment-manifest.json`(`qsx1-<sha256[:16]>`);
- 引用与 DOI:`CITATION.cff` + `.zenodo.json` + `docs/DOI-RELEASE.md`
  (Zenodo 发布为用户动作);
- 复现:任一环境执行 `docs/REPRODUCE.md` 的命令序列并比对冻结门禁。
