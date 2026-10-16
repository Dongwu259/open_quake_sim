# UCERF3-TD 加州时间依赖 PSHA — 数据可得性报告(2026-10-12)

> 队列来源:UCERF3 批 C 收官后用户选定「UCERF3-TD —— 加州时间依赖 PSHA」的**立项前置件**
> (照 UCERF3-AVAILABILITY.md 先例:先出可得性报告再立项)。
> 本报告只回答「TD 参数可不可得、方法学权威是什么、以什么代价复刻」,不改任何引擎代码。
> 所有实测数字(文件大小/sha256/可达性/解析计数)均为 2026-10-12 本机实测。

## 1. 结论(TL;DR)

**可得、方法学完整、stdlib+现有引擎可复刻,立项数据风险清除。** 三通道全部实测可达:
①方法学权威=OpenSHA 源码(GitHub 钉 IP 通道)+ 官方 UCERF3-TD 论文 PDF(wgcep.org 直连);
②TD 输入数据=`UCERF3_OpenIntervals_ver11.xls`(391 行上次破裂开间,python xlrd 2.0.2 解析成功,
Parkfield 锚 9.0 年@基准 2013 与论文 Table 2 一致);③外部验证锚=论文 Table 7 区域 30 年参与概率
(全加州 M≥7: 0.93、M≥8: 0.07 等,起算 2014)可直接做量级门。

批 A 数据批落地后,批 B 集成 = 加州 v3 包特征源挂 BPT 通道(引擎 `hazardCurveTimeDependent`
已具备全部原语:`bptConditionalProb` 闭式 IG、BPT 情景乘法通道、等效率输出)。

## 2. 通道清单(2026-10-12 实测)

| 通道 | 实测 | 角色 |
|---|---|---|
| `https://wgcep.org/resources/UCERF3-TD_2015_BSSA_Paper.pdf` | **200,2,725,218 B** | 官方 TD 论文(Field et al. 2015, BSSA 105(2A))——参数默认值与验证锚的权威 |
| GitHub `opensha/opensha-ucerf3`(钉 140.82.112.5+SNI+Host 头) | **200** | TD 实现权威:`LastEventData.java`(数据装载语义)、`ProbabilityModelsCalc.java`(破裂级增益算法)、XLS 数据文件本体 |
| GitHub `opensha/opensha`(同通道) | **200** | 参数默认值权威:`MagDependentAperiodicityParam`(默认 ALL_PT3)、`BPTAveragingTypeParam`(默认 AveRI&AveNormTimeSince)、`HistoricOpenIntervalParam`、`BPT_DistCalc` |
| Zenodo DOI 10.5281/zenodo.5519802 | (批 A 已验) | **无 TD 输出**——分支平均解仅时间独立率;TD 视图须由本报告参数+批 A 冻结率自行计算(官方注记:分支平均解与 TD 兼容) |

GitHub 通道坑(新):node:https 直连钉 IP 时**必须显式带 `Host: api.github.com` 头**——
缺省 Host=IP 时 `/repos/...` 与 `/contents/...` 返回 400 HTML 错误页,而 `/search/*` 静默 200 空结果
(伪阴性,已浪费一轮);curl `--resolve` 无此问题。另:GitHub code search API 对这两仓返回 0 命中
(原因未查明,疑似搜索索引/权限),**用 git trees API recursive=1 全树列举+本地 grep 替代**(opensha-ucerf3
全树 1,960 路径一次拉全)。

## 3. UCERF3-TD 方法学(代码+论文双重核实,逐字级)

**数据文件**:`src/scratch/UCERF3/data/paleoRateData/UCERF3_OpenIntervals_ver11.xls`
(sha256 `4cae78f96ad8839e9b3cab353d600806d80d79bd889512179fdc952c88aa6635`,3,205,120 B)。
三张数据表(sheet 0「Well resolved historical」287 行 / sheet 1「Paleo-well resolved」99 行 /
sheet 2「Unique to FM3.2」5 行;sheet 3 为 Data Sources 文献表)。列语义(LastEventData.java 锁定):
0=段名,1=**parentID**(直接挂父段,无需定位匹配),3=上次事件位错(m,可空),4=**开间(年,
基准年 2013-01-01)**——事件年=2013−开间,6-9=起止经纬度(供子段级 1 km 容差匹配)。

**破裂级组合规则**(`ProbabilityModelsCalc.getU3_ProbGainForRup`,论文 §「Mixture of Known and
Unknown」同式):破裂的「距上次事件」=**有数据子段的面积加权平均日期**;全无数据→用
historic-open-interval 条件式(下文);部分有数据→对无数据部分按 BPT 生存函数归一化分布积分混合
(默认均化方式=AveRI & AveNormTimeSince,BPTAveragingTypeParam 默认值)。

**非周期性**(论文 Table 1 逐字,与 `MagDependentAperiodicityOptions` 逐值一致):

| 分支 | M≤6.7 | 6.7<M≤7.2 | 7.2<M≤7.7 | M>7.7 | 权重 |
|---|---|---|---|---|---|
| Low range | 0.4 | 0.3 | 0.2 | 0.1 | 0.1 |
| Mid range | 0.5 | 0.4 | 0.3 | 0.2 | 0.4 |
| High range | 0.6 | 0.5 | 0.4 | 0.3 | 0.3 |
| Poisson | — | — | — | — | 0.2 |

(官方 UCERF3-TD 即该 4 支混合=`U3_PREF_BLEND`;单值 σ=0.3 仅为 ERF 缺省与论文 Fig.5d 演示用。)

**historic open interval**:T_H = 起算年 − **1875**(论文 §「Historic Open Interval」逐字:
「We use the year 1875 …T_H ≈ 2014 − 1875 ≈ 139 years」;工作组成员意见范围 1850-1900,
敏感性实测不主导)。无数据段条件概率(Field & Jordan 2015 式6):
P(T|TSL≥T_H) = ∫_{T_H}^{T_H+T}(1−F(t))dt / ∫_{T_H}^∞(1−F(t))dt ——本引擎可用闭式 IG 的
`bptCdf` 数值积分精确求值(指数分布特例精确退化为 1−e^{−λT},已自检)。

**增益→概率→率**(FaultSystemSolutionERF,U3_BPT 分支):prob = gain×rate×duration
(代数上恰=BPT 条件概率);需率时 equivRate = −ln(1−prob)/duration ——与本引擎
`hazardCurveTimeDependent` 南海通道的「条件概率×乘法合成→等效泊松率」语义完全一致。

**OpenSHA 数值细节(我们选择不复制)**:BPT CDF 用 501 点归一化离散表(9×RI 截断)——
本引擎 `bptCdf` 为 IG 闭式(尾部渐近 Φ 稳定),精度更高;对照时用容差门不用逐位锁。

## 4. XLS 解析实测(python xlrd 2.0.2,2026-10-12)

- 391 行数值开间(287+99+5);每行均含 parentID+起止坐标(LastEventData 装载契约)。
- 锚:San Andreas (Parkfield) parentID=32,8 行开间=9.0(基准 2013→2004 事件 ✓),
  论文 Table 2「Average Years Since 10」为 2014 口径 ✓;位错 0.008–0.07 m 逐行变化。
- FM3.1/FM3.2 双解:sheet 2 为 FM3.2 独有父段;批 B 构建时按 FM 各挂各的(冻结件按 FM 分块),
  0.5/0.5 平均语义与批 A/B 一致(同段两 FM 都有→同参数;仅 FM3.2 有→该段权重 0.5,如实注记)。

## 5. 外部验证锚(论文 Table 2/6/7,批 B 验收用)

- **Table 2 段级年数**(2014 口径):Parkfield 10、Hayward 146(1868)、SA 各段 157(1857)、
  North Coast/Offshore 108(1906)、Imperial 34/22(1979/1940 行)、Rodgers Creek 281(1732.5) 等——
  批 B 构建件的逐段核对锚(±1 年,截断取整口径差)。
- **Table 7 区域 30 年参与概率**(起算 2014,U3 Mean=断层+网格全体):全加州 M≥6.7 **1.00**、
  M≥7 **0.93**、M≥7.5 **0.48**、M≥7.7 **0.27**、M≥8 **0.07**;TD/TI 增益 1.04/1.09/1.21
  (M7/7.5/8)。批 B 打包后用「断层+网格全源参与率积分」复算,量级门(非逐位:父段聚合近似+
  闭式 BPT vs 501 点离散表+2014 vs 运行年起算差)。
- 主断层 30 年 M≥6.7 概率(论文 §Table 6 文字锚):北圣安德烈斯 0.33、Hayward–Rodgers Creek
  0.32、San Jacinto 0.09(UCERF2 0.32→UCERF3 0.09 三倍降)。

## 6. 立项建议(批 B/C 设计输入,非终稿)

1. **冻结件** `tools/data/ucerf3-td-sections-california.json`(schema `quake-sim-ucerf3-td-v1`):
   按 FM 分块,每 parentId→{名称,面积加权平均事件年(匹配子段面积权重,无数据=null),
   明细行 [{openInterval,offset,span}]},provenance={repo 路径, xls sha256, 提取时间}。
   构建器 `tools/build-ucerf3-td.js`(node 主控+xlrd 调用 python 一次性出 staging JSON——
   xlrd 已在环境,python 构建先例:build-bathymetry-regions.py)。
2. **包**:加州 v3 包 `characteristicSources` 条目增 `bpt:{lastEventYear|null}` 块
   (RI 由条目自身 charMfd/rate 携带,非周期性由引擎按量级查 Table 1 混合);loader 无需改
   (v3 已接受);**无数据段不显式置 null 而省略 bpt 块?——否:显式 null,与「未知≠不存在」语义一致**。
3. **引擎**:`hazardCurveTimeDependent` 的 v3 消费(`_pshaV3SourcesEach` 调用点)拆两路——
   gridMfd 节点留在泊松背景;带 bpt 块的特征源进 BPT 乘法通道(逐 charMfd 分级:
   RI=1/rate_bin、elapsed=currentYear−lastEventYear(null→historic-open-interval 式6)、
   α=Table 1 按量级混合,Poisson 权重 0.2 落回长期率)。日本路径字节不动
   (scenarios 通道逻辑零改动,改动只在 v3 消费分支)。
4. **app**:`_pshaCompute` 的 TD 门由「!regionActive」改为「区域包声明 TD 能力」
   (包内 `bptReady:true` 或特征源带 bpt 块);`_pshaClearForRegionSwitch` 同步;
   i18n 注记键 ×3(卡上注明 UCERF3-TD 口径+父段聚合近似)。
5. **锚**:tests/ucerf3-td.test.js(数据锚:XLS 行数/Parkfield/表 2 抽样;引擎锚:式 6 指数退化、
   混合权重守恒、TD-off 字节兼容、LA TD vs TI 量级+方向)、psha-region 增 TD 锚、E2E 探针扩
   probe-ucerf3(TD 开关在加州可用、卡渲染 BPT 徽标 xN、日本不变)。
6. **批次**:批 A=本报告+数据冻结件(item 1);批 B=item 2-5;批 C=E2E+docs+清单+镜像。

## 7. 诚实边界

- **父段聚合近似**:官方 UCERF3-TD 在破裂级做「有数据子段面积加权+无数据子段生存函数混合」;
  本包特征源是父段聚合(批 B 定案 γ 的粒度),TD 计算同样在父段级——多行不同日期的父段
  (如 SA 系 1857/1812 混合)取子段面积加权平均事件年,等价于把「整个父段一次破裂」当作破裂单元。
  与官方破裂级结果的偏差未量化,锚只用量级门;pack limitations 言明。
- **起算年漂移**:论文锚为 2014 起算;本引擎 elapsed 按运行 currentYear 滚动(南海通道同约定)——
  复算锚时统一传 currentYear=2014。
- sheet 3(Data Sources)未结构化,仅作文献溯源参考;位错列(lastOffset)本批不消费。
- UCERF3-TD 官方结果的逻辑树 5760 支在仓内不可复现(全量 4.5GB 通道未取),
  本实现=分支平均率+官方概率模型(Table 1 混合)的组合,非官方逐支均值。

## 8. 复现

```
# XLS(钉 IP + Host 头;sha256 4cae78f96ad8839e9b3cab353d600806d80d79bd889512179fdc952c88aa6635)
GET /repos/opensha/opensha-ucerf3/contents/src/scratch/UCERF3/data/paleoRateData/UCERF3_OpenIntervals_ver11.xls
  (Accept: application/vnd.github.raw+json, ref=master)
# 论文
curl -sO https://wgcep.org/resources/UCERF3-TD_2015_BSSA_Paper.pdf   # 200, 2,725,218 B
pdftotext UCERF3-TD_2015_BSSA_Paper.pdf ucerf3td.txt                 # Table 1/2/7 逐字抽取
```
