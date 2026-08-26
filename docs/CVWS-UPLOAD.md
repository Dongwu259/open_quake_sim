# SCEC CVWS 官方参考解获取与上传运行手册(用户动作)

> 背景:v6.0 的 R6-2 离线动力学破裂求解器(`tools/dynamic-rupture/`)以解析锚
> (辐射阻尼 μ/2cs、静态位错核、离散能量闭合、收敛性)完成验证;SCEC TPV5
> 官方参数已逐字转录并运行(TPV5-AP 反平面约化,`tools/data/dynamic-rupture-report.json`)。
> **尚未完成的一环**是与 CVWS(Code Validation Web Server)上的官方多代码
> 参考解逐站对比——该数据在登录墙后,账号申请是用户动作。

## 为什么需要它

- 解析锚验证的是"求解器物理正确",官方参考解验证的是"与社区其他 10+ 个
  独立代码在同一基准上逐站一致(SCEC 的容差惯例)";
- 特别是我们记录的诚实缺口:**PSV 模式 II 的 Burridge–Andrews 超剪切转换
  出现得比 Zheng & Rice (1998) 经典估计更早**(见 PHYSICS_BENCHMARKS.md
  v6.0 段)。官方 TPV 站点序列是判定该行为真伪的唯一权威。

## 步骤

1. **申请账号**(免费):浏览器打开 https://strike.scec.org/cvws/ →
   "Upload Data" → 按页面指引联系 SCEC(历史联系人是 Michael Barall /
   Ruth Harris,页面为准)。学术邮箱通常当天-数日通过。
2. **登录查看参考解**:https://strike.scec.org/cvws/cgi-bin/cvws.cgi →
   "View Data" → 选择 TPV5(3D)→ 选择任一参加组(如 Barall/Dalguer/
   Taborda)→ 站点 `faultstXXXdpXXX` → "Raw Data" 下载文本时序。
   对照站选与深度 7.5 km 同排的官方站点。
3. **对比我们的 TPV5-AP 站点序列**:`tools/data/dynamic-rupture-report.json`
   → `experiments.tpv5apHalfspace.stationSeries`(10 站,0.1 s 采样,
   [t, slip, slipRate, shearStressMPa])。注意我们的 2D 反平面约化与 3D
   参考解在幅值上**不**逐点可比(3D 沿走向扩展 vs 2D 沿走向均匀),定性
   对比对象:到时序列形态、最终滑移沿深度分布的包络、震源区滑移速率量级。
4. **(可选)正式参与**:CVWS 也接受 2D 结果上传(TPV105-2D 有先例,需
   联系管理员开第二个账号)。我们的 SH 求解器输出格式距官方 11 列格式
   仅一步之遥——若用户有意愿,由 agent 按官方 uploadTPV5_v2.pdf 规范
   补导出器。
5. **结论回填**:对比结论(含负结果)写回 PHYSICS_BENCHMARKS.md v6.0 段,
   并在 ROADMAP 6.9 勾掉"TPV 基准逐项容差验证"或如实记录差异。

## 相关链接

- 基准列表:https://strike.scec.org/cvws/benchmark_descriptions.html
- 套件论文(公开 PDF):https://strike.scec.org/cvws/download/HarrisetalSRL2018.pdf
  (Harris et al., SRL 2018, doi:10.1785/0220170222)
- 本地归档:TPV5/TPV10/11 官方描述 PDF 已存 `.cache/`(会话产物,不入库;
  本文件与 configs.js 中的参数表是可复现的持久记录)。
