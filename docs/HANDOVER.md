# 交接：给 `dsh-lifecycle-cache-cleaner` 补 Client 侧 UI

写给**在 DSH 里接手的 agent**。你只需要读这一份，不必翻会话记录。

---

## 1. 一句话目标

这个插件目前只有 Host 半边：两个模型工具 + 记忆注入 + 删除会话后的清理监听。
**任务：给它补 Client 半边**，让用户在界面里看得见状态、点得到“释放引擎”。

---

## 2. 源码在哪

| 项 | 值 |
|---|---|
| 本地目录 | `C:\Users\Admin2\.sclaw\workspace\lifecycle-cache-cleaner` |
| 仓库 | `https://github.com/ccr-wer/dsh-Lifecycle-Cache-Cleaner` |
| 分支 / HEAD | `main` / `520887e` |
| 标签 | `v0.6.0` |
| npm | `dsh-lifecycle-cache-cleaner@0.6.0`（latest） |
| 安装方式 | 本地目录：**Plugins → Add plugin** 选上面那个目录（链接安装，改完重启生效） |
| 测试 | `node --test` → 130 项，128 pass / 2 skip（skip 是 macOS-only 的 V2/V2b，别去动） |

当前 `package.json` 的关键字段：

```json
{
  "name": "dsh-lifecycle-cache-cleaner",
  "version": "0.6.0",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

---

## 3. 代码结构

```
index.js                      插件入口：apply(ctx, config)
cordis.patch.yml              组合包 patch（insert 一行插件条目）
icon.svg  locale/{en,zh}.json 插件管理器里显示的图标与文案
lib/host/runtime.js           HostRuntime：探测 → 闸门 → 释放；记忆文本；删除后处理
lib/host/tools.js             两个工具的定义与文本渲染
lib/host/session-watcher.js   监听 sessions/ 目录变化（轮询，跨平台一致）
adapters/engine-http.js       本地引擎探测（只读 GET）+ ollama 卸载（keep_alive: 0）
lib/core/*                    与宿主无关的核心：闸门、归属、显存采样、记忆存储、原子写
cleaner.js                    库入口：日志流水线主循环（工具链尚未接宿主）
session-deleter.js            库：会话删除编排（尚未接宿主）
test/*.test.js                V / S / I / X / M / P / H 七组测试
tools/asar-extract.mjs        从 app.asar 里取出宿主文档（见第 6 节）
tools/asar-list.mjs           列出 app.asar 内的路径
```

### Host 侧现状（已验证）

`index.js` 的 `apply(ctx, config)` 做三件事：

1. `ctx.tools.register(...)` 注册两个工具：`lifecycle_cache_status`、`lifecycle_cache_clean`
2. `ctx.inject(['systemPrompt'], sp => …)` 注入记忆变量 `lifecycle_memory` + 一个 prompt section
3. 起 `SessionWatcher` 轮询 `$DSH_HOME/sessions/<工作区>/session-<uuid>/`，目录消失 → 释放租约 → 过闸门

配置项（写在 profile 的 `cordis.patch.yml` 插件行里）：

```yaml
- id: lifecycle-cache-cleaner
  name: 'dsh-lifecycle-cache-cleaner'
  config:
    rootDir: 'C:\Users\Admin2\.dsh'
    ownership: adapter-exclusive        # 或 lease
    engine: { kind: auto, baseUrl: 'http://127.0.0.1:11434' }
    releaseOnDelete: true
    watchIntervalMs: 5000
    watchSessions: true
```

---

## 4. 这次要做什么

**只加 UI，不改 Host 行为。**

### 4.1 清单

```json
{
  "icon": "./icon.svg",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg", "lib/", "adapters/", "docs/"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-slots"] }
  }
}
```

`dsh.client.inject` 只用于**排序激活**，不要去 `require` 那些包（宿主文档明确禁止）。

### 4.2 UI 内容（最小版）

一行状态 + 一个按钮：

```
生命周期缓存  引擎 absent · 闸门拒绝(skip_absent) · 记忆 0/0   [释放引擎]
```

- 状态数据来自 Host：新增一条 wire/projection 或在 Client 侧调用工具同名逻辑均可，
  **优先做法**是 Host 暴露一个只读查询（`ctx.slots` 的 props 里拿），不要在前端重算闸门。
- 按钮必须走同一套闸门语义：`confirm: true` 才会真的释放；探测 absent/unknown 时按钮禁用并给出原因。

### 4.3 不在本次范围

- **删除会话的 UI**。本包不提供删除入口；删除由宿主/会话管理器做（`dsh-session-manager` 是文件级实现，没有可调用的 API）。不要在 Client 里自己 delete 会话文件。
- 任何绕过 `lib/core/release-gate.js` 的清理路径。

---

## 5. 硬约束（违反即回退）

1. **不 import 任何 `@deepseek-ai/*` 包**。profile 的 `node_modules` 里只有 profile 安装的 bundle，解析不到宿主包。现有一切都靠 `ctx` 与 config。
2. **所有清理必须经 `lib/core/release-gate.js`**。仓库里除闸门以外没有任何代码调用 `destroyEngine()`。
3. **不写 `sessions/` 下的任何文件**。删除链路只观察，不接管。
4. **不放宽测试断言、不加 skip**。现有 130 项是基线，新功能自己补用例。
5. **core 不 `require('dsh')`、不直接 `fetch`**；HTTP 只能在 `adapters/` 里。
6. **别动 `C:\Users\Admin2\.sclaw\workspace\codex-memory-cleaner`**，那是另一个项目。
7. 验证显存只用 `footprint` / `vmmap` / `nvidia-smi`，**禁用 `top`**。

---

## 6. 宿主文档怎么读

宿主把所有规范打在 `app.asar` 里，读之前先解出来：

```powershell
$asar = 'C:\Users\Admin2\AppData\Local\Programs\DeepSeek Harness\resources\app.asar'
$base = 'dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/dsh-doc'

# 列出某类文档
node tools/asar-list.mjs $asar 'dsh-doc/references/.*\.md$'

# 取出某一篇
node tools/asar-extract.mjs $asar "$base/references/ui-plugin.md"
```

必读顺序：

| 文档 | 用途 |
|---|---|
| `references/ui-plugin.md` | Client 侧插件怎么写、slot 怎么注册 |
| `references/host-plugin.md` | 清单、`dsh.client`、locale、icon、`files` |
| `references/practices.md` | 扩展点强弱、别做什么（UI 一节尤其重要） |
| `references/verification.md` | 装完怎么验 |
| `templates/decoration/` | 一个可跑的最小 Client 模板（`client.js` + `package.json`） |

---

## 7. 已知坑（都是踩过的）

| 坑 | 表现 | 处理 |
|---|---|---|
| 未注入就读服务属性 | `cannot get property "variable" without inject`，`try/catch` 拦不住 | 只用 `ctx.inject([...], cb)` 回调里的对象 |
| `ctx.tools.register` 不需要 `defineTool()` | 想 import 宿主包才能定义工具 | 普通对象即可，只校验 `output.schema` + `output.render` |
| npm 11 暂存发布 | `npm publish` 立刻返回成功，registry 上先只有 `0.0.0-stage` | 轮询 `registry.npmjs.org`，实测 20 秒到 3 分钟不等 |
| PowerShell 引号 | `git commit -m "..." -m "多行含括号"` 会被拆成 pathspec | 提交信息用单行，或写文件再 `-F` |
| `APPDATA` 为空 | `npm` / `gh` 拼出字面量 `${APPDATA}` 路径，误报未登录 | 先显式 `$env:APPDATA = "$env:USERPROFILE\AppData\Roaming"` |

---

## 8. 验收标准

1. `node --test` 仍然 130 项全绿（新用例另计），既有断言一字未改
2. 装进 `C:\Users\Admin2\.dsh\profiles\desktop` 后，**插件页能看到状态行**，图标与中英文标题正常
3. 引擎 absent 时“释放引擎”按钮禁用，并显示 `skip_absent` 原因；不出现“已释放”的假成功
4. 卸载插件后 Host 侧工具消失、监听停止（不留定时器）
5. 报告里明确写：哪些验证过、哪些只能靠用户在界面上确认

---

## 9. 交付要求

- 改动提交到 `main`，版本按语义化升（加 UI = minor，`0.7.0`）
- 打 tag 并推：`git push origin main --follow-tags`
- 发布 npm：`npm publish --access public`，然后轮询确认 `dist-tags.latest` 已切换
- 文档同步：`README.md` 的「接入」与能力表、`docs/DECISIONS.md` 加一条 D20
- 中文写文档，代码注释保持现有风格（说明“为什么”，不复述“做了什么”）
