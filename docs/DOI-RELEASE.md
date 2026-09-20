# Zenodo DOI 发布流程（R7-2，用户执行）

> **状态：✅ 已执行（2026-09-18）**。实际发布版本 **v6.3.3**（远端 v6.3.2 tag/release 已存在且定格于 09-11 旧提交 32bf388，按 tag 不可移规则开新号）；**DOI `10.5281/zenodo.22828697`**（概念 DOI `10.5281/zenodo.22828696`，引所有版本）。CITATION.cff / README×2 已回填，镜像 validate-release 的包版本钉同步 6.3.3。后续版本循环：release → Zenodo 自动草稿 → Publish → 回填 CITATION.cff `doi:`+`version:`。以下为原始流程记录。

> Agent 已准备 `CITATION.cff`（仓库根）与 `.zenodo.json`（Zenodo 元数据：标题/
> 摘要/作者/许可/关键词）。实际发布需要 Zenodo 账号操作——按本项目 Git 政策，
> 一切对外发布动作由用户手动执行。本文档是操作清单。

## 目标

满足 R7-2 验收「≥1 个 DOI 发布」：把 **open_quake_sim**（GitHub 公开镜像，
MIT）的 v6.0 tag 归档成 Zenodo software record，取得 DOI 并回填引用信息。

## 步骤

1. **前置**：open_quake_sim 已同步到 v6.0（含 `CITATION.cff` 与 `.zenodo.json`），
   且用户已在 GitHub 上将仓库设为 public。
2. 登录 <https://zenodo.org>（GitHub 账号 OAuth）。
3. 右上角用户菜单 → **GitHub** → Repository 列表里找到 `Dongwu259/open_quake_sim`
   → 开启（On）。
4. **发布 tag**：在 GitHub 上打 tag（例如 `v6.0.0`）并推送——Zenodo 会自动抓取
   该 tag 生成新 version。`.zenodo.json` 提供元数据；若 Zenodo 界面要求补齐，
   按 `.zenodo.json` 内容填写（title/creators/license MIT/upload type software）。
5. 到 Zenodo Uploads 页检查草稿 → **Publish**。
6. 把取得的 DOI（形如 `10.5281/zenodo.XXXXXXX`）回填：
   - `CITATION.cff` 增加 `doi:` 与 `version:` 字段；
   - open 仓库 README 增加引用段；
   - 本仓 `ROADMAP.md` R7-2 状态更新为 ✅。
7. 后续版本：每次 release tag 重复 4–6，Zenodo 自动形成 version 链。

## 注意

- Zenodo 归档的是 **tag 当时的代码快照**（不含 LFS 大文件；本仓库无 LFS）。
  波形包/测井等 account-gated 数据本来就不在库内，不受影响。
- 私有仓库 quake_sim 不接入 Zenodo；引用与 DOI 指向 open 镜像。
- `CITATION.cff` 同时被 GitHub 识别（仓库页右侧 "Cite this repository"），
  与 Zenodo DOI 互补。
