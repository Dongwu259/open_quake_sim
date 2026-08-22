# Contributing / 参与贡献

[中文](#中文) | [English](#english)

## 中文

欢迎 Issue 和 Pull Request！中英文均可。

**开始之前**：
1. 先开 Issue 讨论较大的改动（新功能、架构调整），小修复可直接 PR。
2. 开发环境：`npm install && node server.js`，见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

**PR 必须满足**：
- `npm test` 全绿，`node tools/validate-release.js` 与 `node tools/bump-versions.js --check` 通过（CI 会跑同一套）。
- 改了 `public/` 下任何文件 → 必须运行 `node tools/bump-versions.js` 并一并提交（版本指纹规则见开发指南，忘记 bump 会让用户缓存旧代码一年）。
- 行尾 LF（仓库用 `.gitattributes` 强制，别绕过）。
- i18n 键在 ja/en/zh 三个语言块都要加。
- 提交信息：`Feature:` / `Fix:` 单行英文摘要 + 正文要点。

**报告 Bug 请附上**：浏览器与版本、控制台报错截图、复现步骤（预设/参数/操作顺序）。

## English

Issues and pull requests are welcome, in Chinese or English.

**Before you start**:
1. Open an issue first for larger changes (features, architecture); small fixes can come straight as PRs.
2. Dev setup: `npm install && node server.js` — see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

**Every PR must**:
- Pass `npm test`, `node tools/validate-release.js` and `node tools/bump-versions.js --check` (CI runs the same chain).
- Run `node tools/bump-versions.js` and commit the result whenever anything under `public/` changed (stale `?v=` fingerprints pin old code in browsers for a year).
- Keep LF line endings (enforced via `.gitattributes`).
- Add new i18n keys to all three language blocks (ja/en/zh).
- Commit style: `Feature:` / `Fix:` one-line English summary + bullet points.

**Bug reports**: browser + version, console errors (screenshot), and exact reproduction steps (preset, parameters, actions).
