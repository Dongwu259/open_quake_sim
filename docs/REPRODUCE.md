# 端到端复现运行手册(v6.0)

> 目标:在任一干净环境(Node ≥ 20,Windows/Linux/macOS)从零复现本
> 仓库声明的全部验证结论,包括 v6.0 的动力学破裂套件。所有门禁是
> 自动判定(退出码),无需人工比对图形。

## 环境

```bash
git clone <本仓库>; cd quake_sim
npm install            # 仅 leaflet/@turf 本地依赖 + git hooks
```

不需要外部网络:全部基准输入、冻结观测与参考数值已入库(许可能入的
部分;NIED 派生量带 DOI 署名,原始数据永不在库)。

## 复现序列(全部命令从仓库根执行)

```bash
# 1. 全量回归(约 930+ 测试 + 5 个 validate 工具;判定行 ℹ fail 0)
npm test

# 2. 版本标记一致性(内容哈希 ?v= 与 SW 派生版本)
node tools/bump-versions.js --check

# 3. 发布级一致性(资产/PWA/研究数据/i18n/可访问性/部署保护,约 24,000 断言)
node tools/validate-release.js

# 4. 实验清单不可变标识(冻结工件 vs 清单哈希)
node tools/build-experiment-manifest.js --check

# 5. v6.0 动力学破裂套件——重跑并自检冻结门禁
node tools/dynamic-rupture/run-experiment.js --suite=all   # 现场复算(约 15 s)
node --test tests/dynamic-rupture.test.js tests/dynamic-rupture-report.test.js
#    如需更新冻结报告:--suite=all --write(随后必须 --write 重冻实验清单)

# 6. (可选,改动过默认参数时)Playwright 精度门
python validate_accuracy.py    # 基线:auto RMS 1.276 / log 参考 3.17,不得回退
```

## 各结论对应的复现入口

| 声明 | 命令 | 冻结工件 |
|---|---|---|
| GMPE 强震动记分卡 | `npm test`(strong-motion 链) | strong-motion-report.json |
| 海啸嵌套/频散/记分卡 | `npm test` + `node tools/validate-nlswe-benchmarks.js` | nlswe-benchmarks / tsunami-scorecard-report |
| 场地反应/集合不确定性 | `npm test`(site-response / ensemble 链) | site-response / ensemble-reliability 报告 |
| 动力学破裂解析锚 | `node --test tests/dynamic-rupture.test.js` | — |
| SCEC TPV5 官方参数 2D 约化 | `run-experiment.js --suite=tpv5` | dynamic-rupture-report.json |
| 震源收支诊断 | `node --test tests/source-budget.test.js` | — |
| 版本综合报告(调参读取审计) | `node tools/build-version-report.js` | version-report.json |

## 独立复现的判定标准

一次"独立环境端到端复现"= 上述 1–5 全部退出码 0,且第 5 步现场复算的
报告与库内冻结版在同一门禁上等价(数值允许跨平台浮点尾差,门禁判定
必须一致)。6.9 的"外部技术审查"即以本文件为入口。
