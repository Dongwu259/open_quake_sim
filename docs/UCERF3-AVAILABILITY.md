# UCERF3 区域特征断层源 — 数据可得性报告(2026-10-07)

> 队列来源:HANDOVER-2 §4 第 2 项「区域特征断层源(UCERF3 加州试点)」的**立项前置件**——
> 「先调研 UCERF3 公开数据获取通道(fault-section recurrence rates),再定 schema;需先出数据可得性报告再立项」。
> 本报告只回答「数据可不可得、以什么代价、什么格式」,不做 schema 终稿、不改任何引擎代码。
> 所有实测数字(文件大小/内容计数/可达性)均为 2026-10-07 本机实测,非转述。

## 1. 结论(TL;DR)

**可得、小体积、stdlib 可解析,立项数据风险清除。** 推荐通道 = **Zenodo DOI 10.5281/zenodo.5519802**
的分支平均解(branch-averaged)FM3.1+FM3.2 两个 zip(合计 ~37 MB,CC BY 4.0,本机直连可达),
Legacy Fault System Solution 格式(zip 内 XML 几何 + 大端 double/int 二进制率表)——
已实际下载 FM3_1 并用 Python stdlib 端到端解析出 **253,706 条破裂的年率/震级/子段索引**,
并完成「段级参与率」推导演示(§4)。主仓侧预计 1 个数据批 + 1 个集成批可完成试点(§5)。

## 2. 通道清单(2026-10-07 可达性实测)

| 通道 | 实测 | 角色 |
|---|---|---|
| `http://wgcep.org/UCERF3-Fault-System-Solutions.html` | **200** | 元数据/文件清单权威页;文件宿主都指向 opensha.usc.edu |
| `http://opensha.usc.edu/ftp/...`(WGCEP 页的全部直链宿主) | **000(连接失败)** | 本机不可达;WGCEP 直链不可用作下载通道 |
| `https://zenodo.org/records/5519802`(DOI 10.5281/zenodo.5519802) | **200,文件端点 200(content-length 与记录页一致)** | **推荐下载通道**:DOI 稳定、许可明示、文件齐全 |
| `https://opensha.org/Legacy-Fault-System-Solution.html` + 记录内 `file_format.md`(18.4 kB) | **200** | Legacy FSS 二进制格式权威描述(两处内容一致) |
| OpenSHA「Modular Fault System Solution」(NSHM23 新格式) | 200(preview) | **不适合现在**:页面自述 pending formal release on ScienceBase;NSHM23 解需申请;列为未来观察项 |

## 3. Zenodo 记录文件与许可(全部 5.7 GB 组)

| 文件 | 大小 | 内容 | 时间依赖 |
|---|---|---|---|
| `branch_averaged_ucerf3_sol_FM3_1.zip` | 17.4 MB | FM3.1 分支平均(720 支加权平均) | **兼容** |
| `branch_averaged_ucerf3_sol_FM3_2.zip` | 19.5 MB | FM3.2 分支平均 | **兼容** |
| `true_mean_ucerf3_sol(_FM3_x).zip` | 105.2 / 67.5 / 75.0 MB | 真均值(保留变异,复制破裂) | **不兼容**(官方注记) |
| `full_ucerf3_compound_sol.zip` | 849.0 MB | 全 1,440 逻辑树分支 | — |
| `full_..._with_individual_runs.zip` | 4.5 GB | 另含每支 10 次退火反演率 | — |
| `file_format.md` / `relm_gridded_region.csv` | 18.4 kB / 176.2 kB | 格式文档 / 网格区定义 | — |

许可 **CC BY 4.0**。UCERF3 学术引用:Field et al. (2014), USGS Open-File Report 2013-1165 /
BSSA 104(3)(公版 USGS 作品;Zenodo 打包方另持 CC BY 4.0)。

**推荐取件**:分支平均 FM3.1+FM3.2(原因:①体积最小;②官方注记与时间依赖 UCERF3 兼容——
本项目 PSHA 卡已带 BPT 时间依赖通道,真均值解的「复制破裂率分摊」会使它失效;③率=720 支加权平均,
与引擎「mean hazard」语义直接对口,无需在仓内实现逻辑树聚合)。

## 4. 格式与解析验证(FM3_1 实测,Python stdlib,零依赖)

Legacy FSS = zip{ `fault_sections.xml`(子段几何/滑移率/倾角走向/深度/parent 段)+ 二进制率表 }。
二进制只有三种原语(记录内 `file_format.md` 与 opensha.org 页逐字一致):

- **Double array**:大端 float64 平铺(mags/rates/rakes/rup_areas/sect_slips…,一值一破裂/一子段);
- **Integer array list**:大端 int32,首值=数组个数,其后每数组「长度前缀+元素」(rup_sections/close_sections);
- **MFD binary**:函数个数前缀 + 每函数(x 数组+y 数组,各带 int32 长度前缀)。

**本机解析实测**(FM3_1 分支平均,zip sha256 `6804ba8e76bf65b2c18ca4b665f900db79c8d84e51639e23515a6e3e2b5902ce`):
253,706 条破裂(M 5.08–8.34,断层总率 0.469/yr,`info.txt`:BRANCH AVERAGED SOLUTION FOR 720 SOLUTIONS);
`rup_sections.bin` 数组数与破裂数严格相等;`fault_sections.xml` 含 2,606 条 FaultTrace(子段)与
2,379 个 ZonePolygon;子段 XML 属性齐备(sectionId/sectionName/aveLongTermSlipRate/aveDip/aveRake/
上下深度/aseismicSlipFactor/parentSectionName/parentSectionId)。

**段级参与率推导演示**(特征源率表的直接来源):对每子段 s,`participationRate(s) = Σ rates[r]`,
r 为包含 s 的破裂。实测 top 子段 1922–1926 = **San Andreas (Parkfield)**(XML parentSectionName 实证),
参与率 ~0.045/yr(Mmax 8.34)——路线可行,无格式障碍。

## 5. 立项建议(供 schema/批次设计,非终稿)

**数据面**
1. `tools/fetch-ucerf3-sections.js`(零依赖,照 fetch-comcat/fetch-region-obs 先例):下载两 zip →
   stdlib 解析 → 输出冻结件 `tools/data/ucerf3-sections-california.json`
   (schema 如 `quake-sim-ucerf3-sections-v1`:parent 段级聚合——几何折线/滑移率/dip/rake/Mmax/参与率,
   破裂级明细不入仓,由 zip 溯源字段 {doi, zip sha256, extractedAt} 可复现)。
2. 计数锚预注册(照 psha-region FROZEN 先例):FM3.1 2,606 子段 / FM3.2 对应数 / San Andreas
   (Parkfield) 参与率 0.045/yr@Mmax 8.34 等,入 tests/ucerf3-sections.test.js。

**schema 面**
3. 区域包升 `quake-sim-psha-source-v3`:新增可选 `characteristicSources[]`
   ({sectionRefs, mw(特征或分段 Mmax), rate(参与率,可选分段截断), rake/dip/trace, provenance});
   v1|v2 包字节不动,loader 三接受(照 v1|v2 修复先例,锁契约进 tests/psha-region)。
4. **核心设计题(立项后第一批要解的)**:特征断层与既有网格 GR 源的**重复计账**——UCERF3 率表是
   全加州断层系的闭合分账,直接叠加在现存平滑网格 GR 上会双重计数同一地震矩/率。候选:
   网格源在特征段缓冲区内减账(UCERF3 网格与断层率本就联合反演,需用 `grid_sources.bin` 对账)
   或特征源只取「网格欠 represented 的大 M 端」。此题必须在写 schema 前定案,报告不预判。

**引擎面**
5. scenario 通道已存在(日本 Nankai/首都直下情景源、equal-area Rrup 代理、genSubSources 有限断层
   patch 集)——特征源优先复用 scenario patch 语义,增量最小。
6. 锚:加州五城 RP475/RP2500 + UHS 重冻(照 v6.8/v6.9 先例),变化如实记录;E2E probe 扩 PSHA 卡。

**批次划分建议**:批 A=1+2(数据批,纯增量);批 B=3+4(schema+集成,触锚);批 C=5+6(引擎+E2E)。

## 6. 诚实边界

- 本报告未评估 UCERF3 与本项目「简化自算」区域包的方法论相容性(UCERF3 是联合反演产物,含
  子地震ogenic MFD 分账;直接取段级参与率隐含接受其分账语义)——留批 B 设计。
- NSHM23(2023 美国国家模型)是 UCERF3 的后继,Modular FSS 新格式 pending ScienceBase;
  若立项排期晚于其正式发布,建议直接评 NSHM23 通道(本报告通道表已留观察项)。
- opensha.usc.edu 当前不可达是本机网络事实(000),不代表服务永久下线;若未来恢复,WGCEP 直链
  与 Zenodo 内容等同(同一产物双发布),不影响结论。

## 7. 复现

```
curl -sO "https://zenodo.org/records/5519802/files/branch_averaged_ucerf3_sol_FM3_1.zip?download=1"
# sha256 6804ba8e76bf65b2c18ca4b665f900db79c8d84e51639e23515a6e3e2b5902ce
python - <<'PY'   # 大端 float64 / int32 数组列表,见 file_format.md
import struct
rates = open('rates.bin','rb').read(); n = len(rates)//8   # 253,706
...
PY
```

## 8. 批 B 定案记录(2026-10-12,追加)

§5 item 4 的**重复计账设计题已定案**。批 A 数据批落地(`tools/fetch-ucerf3-sections.js` →
`tools/data/ucerf3-sections-california.json` + `ucerf3-grid-mfd.json`)后,批 B-1 以
`tools/ucerf3-reconcile.js` 做三方对账(冻结报告 `tools/data/ucerf3-reconcile-report.json`):

| 带 | A 断层 | B 网格无关联 | C 准断层 | A+B+C | D 本包(RELM bbox) | D/total | 断层份额 |
|---|---|---|---|---|---|---|---|
| M≥5.0 | 0.652 | 3.601 | 4.199 | 8.451 | 4.247 | 0.503 | 0.077 |
| M≥6.5 | 0.336 | 0.068 | 0.003 | 0.407 | 0.251 | **0.616** | **0.825** |
| M≥7.5 | 0.095 | ~0 | 0 | 0.095 | 0.040 | 0.421 | 0.9997 |

(A/B/C 为 FM3.1/FM3.2 0.5/0.5 均值;FM3.1 单模型 D/total@M6.5=0.957。)

**判读**:本包 ComCat 平滑 GR 在危险量级已携带 UCERF3 闭合分账的同级总量——**直接叠加特征源=
对主导项(断层份额 0.825@M6.5)双重计数**。v2 包 provenance 记的「长 RP 近断层低估」是**空间涂抹**
问题(GR 把断层率摊进 0.25° 格),非总量不足。

**定案 γ = RELM 内置换**:RELM 多边形内的 ComCat 格(1,269 格)由 UCERF3 闭合分账**置换**
(特征断层源 + 网格 MFD 节点),区域外 apron 不变——**构造上零双重计数**。否决项:α 缓冲区减账
(两套不同平滑核的率基无法审计地对齐);β 只取大 M 端(我包大 M 端率并不缺,缺的是空间集中)。
诚实边界:两分账在 RELM 边界缝不做调和(跨界率不连续可能,闭合行可见);UCERF3 为时间独立
分支平均率,UCERF3-TI 时间依赖视图有意不复制。

落地:加州包升 `quake-sim-psha-source-v3`(批 B),引擎 `_pshaV3SourcesEach` 三处消费;
LA RP475 PGA 303.7→**618.3 gal**(Vs30 600,~0.63 g,落官方 NSHM 量级——非调参匹配,
是已发表源模型本身的效果),deagg 主导 bin=M7.2@4 km 特征源。
