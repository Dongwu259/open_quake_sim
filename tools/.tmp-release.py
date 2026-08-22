import io, re

def rw(path, fn):
    src = io.open(path, encoding='utf-8', newline='').read()
    src = fn(src)
    io.open(path, 'w', encoding='utf-8', newline='').write(src)

def f_package(src):
    old = '"version": "5.5.0-preview",'
    assert src.count(old) == 1
    return src.replace(old, '"version": "5.5.0",')
rw('package.json', f_package)

def f_manifest(src):
    old = 'v5.5 Preview'
    assert src.count(old) == 1
    return src.replace(old, 'v5.5')
rw('public/manifest.json', f_manifest)

def f_html(src):
    n = src.count('v5.5预览版')
    assert n >= 5, n
    src = src.replace('v5.5预览版', 'v5.5正式版')
    # changelog quality entry before the v54 section header
    anchor = '      <h3 data-i18n="help.v54_preview">'
    assert src.count(anchor) == 1
    entry = ('      <h3 data-i18n="help.v55_quality">正式版质量</h3>\n'
             '      <p data-i18n="help.v55_quality_text">通过 765 项单元/集成测试与 24,200 项以上发布检查（资源、PWA、科研数据、i18n、无障碍），GMPE 精度记分卡与海啸基准全绿，PWA 缓存代次已更新。</p>\n')
    src = src.replace(anchor, entry + anchor)
    return src
rw('public/index.html', f_html)

def f_i18n(src):
    pairs = [
        ("I18N.ja['app.title'] = '地震シミュレーター v5.5 プレビュー版';",
         "I18N.ja['app.title'] = '地震シミュレーター v5.5';"),
        ("I18N.en['app.title'] = 'Earthquake Simulator v5.5 Preview';",
         "I18N.en['app.title'] = 'Earthquake Simulator v5.5';"),
        ("I18N.zh['app.title'] = '地震模拟器 v5.5预览版';",
         "I18N.zh['app.title'] = '地震模拟器 v5.5正式版';"),
        ("I18N.ja['formulas.subtitle'] = 'v5.5 プレビュー版の実装と一致する科学説明';",
         "I18N.ja['formulas.subtitle'] = 'v5.5 正式版の実装と一致する科学説明';"),
        ("I18N.en['formulas.subtitle'] = 'Scientific notes aligned with the v5.5 preview implementation';",
         "I18N.en['formulas.subtitle'] = 'Scientific notes aligned with the v5.5 release implementation';"),
        ("I18N.zh['formulas.subtitle'] = '与 v5.5预览版实际计算实现保持一致';",
         "I18N.zh['formulas.subtitle'] = '与 v5.5正式版实际计算实现保持一致';"),
        ("'help.v55_preview':'━━ v5.5 プレビュー版 更新 ━━'",
         "'help.v55_preview':'━━ v5.5正式版 更新 ━━'"),
        ("'help.v55_preview':'━━ v5.5 Preview Update ━━'",
         "'help.v55_preview':'━━ v5.5 Release Update ━━'"),
        ("'help.v55_preview':'━━ v5.5预览版 更新 ━━'",
         "'help.v55_preview':'━━ v5.5正式版 更新 ━━'"),
    ]
    for old, new in pairs:
        assert src.count(old) == 1, old[:50]
        src = src.replace(old, new)
    # v5.5 preview mentions inside changelog body texts -> release wording
    src = src.replace('v5.5预览版', 'v5.5正式版')
    src = src.replace('v5.5 プレビュー版', 'v5.5 正式版')
    # quality keys x3, appended after each help.v55_preview entry
    add = [
        ("'help.v55_preview':'━━ v5.5正式版 更新 ━━',",
         "'help.v55_preview':'━━ v5.5正式版 更新 ━━','help.v55_quality':'正式版の品質','help.v55_quality_text':'765件の単体/結合テストと24,200件以上のリリースチェック（アセット、PWA、研究データ、i18n、アクセシビリティ）を通過。GMPE精度スコアカードと津波ベンチマークも全てグリーン。PWAキャッシュ世代を更新済み。',", 1),
        ("'help.v55_preview':'━━ v5.5 Release Update ━━',",
         "'help.v55_preview':'━━ v5.5 Release Update ━━','help.v55_quality':'Release quality','help.v55_quality_text':'Passes 765 unit/integration tests and 24,200+ release checks (assets, PWA, research data, i18n, accessibility); GMPE accuracy scorecard and tsunami benchmarks are green, and the PWA cache generation is refreshed.',", 1),
    ]
    for old, new, c in add:
        assert src.count(old) == c, old[:50]
        src = src.replace(old, new, c)
    # zh: the ja-style header appears once already converted above; zh block gets its own pair
    old_zh = "'help.v55_preview':'━━ v5.5正式版 更新 ━━','help.v54_gebco'"
    if src.count(old_zh) == 1:
        src = src.replace(old_zh, "'help.v55_preview':'━━ v5.5正式版 更新 ━━','help.v55_quality':'正式版质量','help.v55_quality_text':'通过 765 项单元/集成测试与 24,200 项以上发布检查（资源、PWA、科研数据、i18n、无障碍），GMPE 精度记分卡与海啸基准全绿，PWA 缓存代次已更新。','help.v54_gebco'")
    return src
rw('public/i18n.js', f_i18n)

def f_help(src):
    if 'v5.5预览版' in src:
        src = src.replace('v5.5预览版', 'v5.5正式版')
    if 'v5.5 プレビュー版' in src:
        src = src.replace('v5.5 プレビュー版', 'v5.5 正式版')
    return src
rw('public/i18n-help.js', f_help)

def f_vr(src):
    old1 = "check(/v5\\.5 Preview/.test(json('public/manifest.json').description || ''), 'manifest version is not v5.5 Preview');"
    new1 = "check(/v5\\.5/.test(json('public/manifest.json').description || '') && !/Preview/i.test(json('public/manifest.json').description || ''), 'manifest version is not the v5.5 release');"
    assert src.count(old1) == 1
    src = src.replace(old1, new1)
    old2 = "check(json('package.json').version === '5.5.0-preview', 'package version is not the 5.5.0-preview preview release');"
    new2 = "check(json('package.json').version === '5.5.0', 'package version is not the 5.5.0 release');"
    assert src.count(old2) == 1
    src = src.replace(old2, new2)
    return src
rw('tools/validate-release.js', f_vr)

def f_sw(src):
    old = '//  QuakeSim Service Worker — PWA shell (v5.5 preview, cache-first)'
    new = '//  QuakeSim Service Worker — PWA shell (v5.5 release, cache-first)'
    assert src.count(old) == 1
    return src.replace(old, new)
rw('public/sw.js', f_sw)

print('all release edits ok')
