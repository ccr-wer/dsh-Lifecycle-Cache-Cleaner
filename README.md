# dsh-lifecycle-cache-cleaner

DSH 本地 Agent 的 KV cache 生命周期管理（单包）。

六件事：

- **入口闸门**：单条工具输出过大 / 插入后水位越界 → 落盘，不调模型。
- **工作日志固化**：摘要 → L5 校验（一致性）→ L6 原子提交（失败即回滚）。
- **统一清理闸门**：所有清理路径共用一条规则——**探测不到本地部署就不动引擎**。
- **记忆分层**：工作区 / 共享两层；模型只提议、归属由程序裁决；写入前消重，≥2 工作区自动升级；删光会话不删记忆，归档可撤销。
- **插件页状态卡**：一行状态 + 一个「释放引擎」按钮；读的是同一个 `runtime`，走的还是同一道闸门。
- **侧栏会话面板**：列出会话，删除 = 把会话目录移到回收站（可按回），最近有写入的会话拒绝删除。

## 一条最重要的规则

```
探测结果 absent  -> 不清理（只整理日志）
探测结果 unknown -> 不清理（fail-closed）
探测结果 present + 归属成立 -> 才允许动引擎
```

`present` 是闸门层的归并结果：`engine-probe` 实际返回的 `owned_idle` / `owned_busy` / `foreign`
都算"已部署"，`absent` / `unknown` 原样保留。

会话删除走 `ownership: 'lease'`（必须有租约且三要素匹配）；
本包自建引擎的路径走 `ownership: 'adapter-exclusive'`（适配器即所有者）。
两条都必经 `lib/core/release-gate.js`，除闸门以外没有任何代码调用 `destroyEngine()`。

**适配器不实现 `probeEngine()` = 永远不清理**。这是有意的：拿不到证据就不许删。

## 接入

要求 Node >= 18.17。

本包同时是一个**可安装的 DSH 组合包**：`package.json` 声明了 `dsh.bundle.patch`，
patch（`cordis.patch.yml`）插入一行插件条目，入口 `index.js` 导出 `apply(ctx, config)`。

安装：**Plugins → Add plugin** 选本目录，或让插件管理器执行 `install_bundle`。
从 npm 装同理——`npm install dsh-lifecycle-cache-cleaner` 后以目录方式添加。

装上之后有四个可验证的能力：

| 能力 | 触发方式 | 行为 |
|---|---|---|
| `lifecycle_cache_status` 工具 | 让模型调用，或直接说“看下缓存状态” | 只读：引擎探测结论、闸门判定、记忆用量、会话监听状态 |
| `lifecycle_cache_clean` 工具 | 模型调用，`confirm: true` 才真释放 | 必经统一闸门；探测不到就不动 |
| 删除会话后自动清理 | 自动（监听 `sessions/` 目录） | 发现会话目录消失 → 释放租约 → 经闸门尝试释放引擎 |
| 记忆注入 | 自动 | 把共享/工作区记忆写进 system prompt（预算 1KB / 2KB） |
| 插件页状态卡 | **Plugins → 本插件** | 一行状态 + 「释放引擎」按钮；按钮禁用时给出 `skip_*` 原因 |
| 侧栏「会话」面板 | 侧栏底部 → 会话 | 列出会话；删除 = 移到回收站，最近有写入的拒绝 |

配置写在 `cordis.patch.yml` 的插件行里：

```yaml
- id: lifecycle-cache-cleaner
  name: 'dsh-lifecycle-cache-cleaner'
  config:
    rootDir: 'C:\\Users\\you\\.dsh'   # 不填则取 DSH_HOME，再退到 ~/.dsh
    ownership: adapter-exclusive        # 或 lease
    engine:
      kind: auto                        # auto | ollama | llamacpp | none
      baseUrl: 'http://127.0.0.1:11434'
    releaseOnDelete: true               # 删除会话后是否经闸门释放引擎
    watchIntervalMs: 5000               # 会话目录扫描间隔
    watchSessions: true                 # false 则完全不开监听
```

**宿主没有“会话已删除”事件**：删除是 UI/其它插件做的文件级操作
（`dsh-session-manager` 就是自己 rm 目录）。所以删除链路靠监视
`sessions/<工作区目录>/session-<uuid>/` 来实现：目录消失 → 释放租约 → 过闸门。
清理失败不回滚删除，也不阻塞它。

作为库使用：

1. 适配器至少实现 `probeEngine()` 与 `destroyEngine()`；前者返回
   `owned_idle | owned_busy | foreign | absent`，抛错即视为 `unknown`
2. 会话创建时登记 `engine_ref`（租约），删除时只校验、不推断
3. 跑 `node --test` 确认全部通过

不实现 `probeEngine()` 也能装——代价是永远 `skip_unknown`，什么都不清理。

## 插件页界面

```text
生命周期缓存   引擎 absent · 闸门拒绝（skip_absent） · 记忆 0/0      [刷新] [释放引擎(禁用)]
```

- **注册位置**：Client 半边（`client.js`）把卡片注册进 `plugins.bundle.config`，
  key 是本包名，所以它出现在 **Plugins → dsh-lifecycle-cache-cleaner** 页面里。
- **数据从哪来**：Host 用 `ctx.webServer.register()` 开一条同源只读路由
  `GET /lifecycle-cache/api/status`，投影 `runtime.status()`；释放走
  `POST /lifecycle-cache/api/clean`，body `{ "confirm": true }`，转给同一个
  `runtime.clean()`。**浏览器里没有闸门逻辑**，判定只有 `lib/core/release-gate.js` 一份。
- **为什么不是 Remote**：宿主的 `api-remotes` 在构建期固定能力集合，第三方组合包
  加不进新命名空间；同源 HTTP 是 `dsh-session-manager` 验证过的第三方路径。
- **认证**：每个请求先过 `ctx.connection.admit(req)`，只要 owner Peer；
  `connection` 服务缺席时直接 503（fail-closed），不是“谁都能点”。
- **按钮语义**：闸门不放行时按钮禁用，并显示 `skip_absent` / `skip_unknown` /
  `skip_no_lease` / `skip_foreign` / `no_destroy` 的原因；点一次只提交一次
  `confirm: true`，返回 `released: false` 就照实显示，不伪造“已释放”。
- **不做的事**：不在浏览器里删任何文件；删除请求只到 Host，由
  `lib/host/session-store.js` 做路径收敛和移动（见下一节）。

## 会话面板（删除会话）

侧栏底部多一个 **会话** 入口（`sidebar.footer.action`）。点开是会话列表，按工作区
分组，每行显示 `session-<uuid>`、最后活动时间、占用字节数：

```text
会话（删除 = 移到回收站）
ws-a
  session-94f60096-…   最后活动 2026/11/19 18:13:32 · 324 KB
  session-9daf7f36-…   最后活动 2026/11/22 14:19:38 · 1.1 MB   [删除(禁用)]
```

删除语义：

1. **移动而不是删除**。会话目录整段 `rename` 到
   `<rootDir>/lifecycle-cache/trash/<时间戳>__<工作区>__session-<id>/`，
   后悔时把目录搬回 `sessions/<工作区>/` 即可。
2. **两道护栏**。UI 传 `currentSessionId` 时 Host 直接拒当前会话；
   另外 `sessionDeleteMinIdleMs`（默认 120000）内有过写入的会话一律拒绝——
   正在跑的会话本来就在写文件，不需要猜“它是不是活的”。文件被占用
   （Windows rename 的 `EPERM`/`EBUSY`）同样拒绝。
3. **删完立刻收尾**。目录搬走等于“会话被删除”，Host 当场调一次
   `runtime.handleSessionsRemoved()`：释放租约 → 走统一闸门尝试释放引擎，
   不用等 watcher 下一个轮询周期。
4. **路径只认 uuid**。`session-<id>` 的 id 必须是 uuid 形状，目标目录必须真的
   在 `sessions/` 根下，`../` 这类写法进不来。

配置项：

```yaml
- id: lifecycle-cache-cleaner
  name: 'dsh-lifecycle-cache-cleaner'
  config:
    sessionDeleteMinIdleMs: 120000   # 最近 2 分钟有写入就拒绝删除；0 = 关掉这条护栏
```

接口（同源、owner-only）：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/lifecycle-cache/api/sessions` | 会话清单 + `minIdleMs`（不含绝对路径） |
| `POST` | `/lifecycle-cache/api/sessions/delete` | `{ id, confirm: true, currentSessionId? }` |

## 跨平台

| 能力 | Windows | Linux | macOS |
|---|---|---|---|
| 溢出闸门 / 日志固化 / 状态机 | ✅ | ✅ | ✅ |
| 统一清理闸门（判定逻辑） | ✅ | ✅ | ✅ |
| 引擎释放（HTTP） | ✅ | ✅ | ✅ |
| 插件页状态卡（同源 HTTP） | ✅ | ✅ | ✅ |
| 释放验证采样 | `tasklist` 工作集 | `/proc` 的 Pss（回退 VmRSS） | `vmmap` 的 footprint |
| 显存口径验证 | `nvidia-smi` | `nvidia-smi` | 不适用 |

`pickSamplerKind()` 按环境选采样器：有 NVIDIA 优先 `nvidia-smi`，否则按平台落到
`footprint` / `proc-rss` / `win-rss`；未知平台不选——结果是 `unverifiable`，
即“能清理但不声称已验证”。`top` 始终被拒绝。

路径一律经 `canonicalPath()` 归一（`realpath` 解软链/junction，win32 转小写），
否则同一目录的另一种写法会被判成“不在允许清单”，该清的不清。

**已知边界**：真实下降断言（V2/V2b）只在 macOS 跑过，非 macOS 会 skip；
Windows/Linux 采样器目前只有单元测试覆盖，没有真机显存断言。

## 记忆

两层，写入权限不同：

| 层 | 文件 | 写入口 |
|---|---|---|
| 整段文档（人工） | `memory/workspaces/<key>.md` | `WorkspaceMemoryStore.write({ confirmed: true })` |
| 条目（模型提议） | `memory/typed.json` | `proposeShared()` → `approveShared({ confirmed: true })` |

**归属由程序裁决，不听模型的**：模型只给 `scope` 建议，命中本地绑定信号
（盘符路径、POSIX 绝对路径、`localhost:port`、端口号、文件名后缀）就强制落工作区。

**写入前去重**（相似度阈值 0.9）：

| 情形 | 动作 |
|---|---|
| 完全相同 | 不新增，只刷新 `updatedAt` |
| 高相似（≥ 0.9） | 新条目 `supersedes` 旧的，旧条目标 `supersededBy`——**不删** |
| 骨架相同但数字全不同 | 两条都留，互标 `conflict`，等用户裁决 |

**升级**：同一事实在 ≥2 个工作区被独立确认后，自动复制一条到共享层。

**读取**：重建时注入 `## 共享记忆`（≤1KB）+ `## 本工作区记忆`（≤2KB），超预算截断并计数。
预算不能去掉——记忆越长越容易触发重建，重建又塞进更长的记忆，会形成正反馈。

## 结构

| 路径 | 职责 |
|---|---|
| `index.js` | 插件入口：`apply(ctx, config)`，注册工具、记忆注入、会话监听、UI 的 HTTP 面 |
| `client.js` | Client 半边：插件页状态卡 + 侧栏会话面板（React 与主题变量，无宿主 Client 包） |
| `cordis.patch.yml` | 组合包 patch：插入一行插件条目 |
| `locale/` `icon.svg` | 插件管理器里显示的标题、描述、图标 |
| `lib/host/runtime.js` | 运行时：探测 → 闸门 → 释放，以及记忆文本与删除后处理 |
| `lib/host/tools.js` | 两个模型的工具定义与文本渲染 |
| `lib/host/session-watcher.js` | 会话目录监听（轮询，跨平台一致） |
| `lib/host/web-api.js` | UI 的 HTTP 面：认证 → 路由 → `runtime` / `session-store`（不做判定） |
| `lib/host/session-store.js` | 会话清单与「移到回收站」：uuid 收敛、路径包含、空闲窗口、占用检测 |
| `adapters/engine-http.js` | 本地引擎探测（只读 GET）与 ollama 卸载 |
| `cleaner.js` | 主循环：tick / rebuild / onCompacted / releaseCache |
| `session-deleter.js` | 会话删除编排（`DELETE_STATE` 九态） |
| `lib/core/release-gate.js` | 统一清理闸门（探测 + 放行判定） |
| `lib/core/ownership.js` | 归属判定（唯一安全阀，纯函数） |
| `lib/core/engine-probe.js` | 只读探测（零写操作） |
| `lib/core/vram-cleaner.js` | 分级释放 + 采样验证（禁用 `top`） |
| `lib/core/memory-store.js` | 记忆条目：归属裁决 / 消重 / 自动升级 / 注入预算 |
| `lib/core/atomic.js` | 原子写 + rename 重试（Windows 瞬时锁） |
| `lib/core/workspace-registry.js` `workspace-memory.js` | 工作区索引 / 记忆（归档可撤销） |
| `lib/core/orphan-scan.js` | 孤儿扫描（只标记，不删除） |
| `adapters/` | 日志流水线适配器；`adapters/engine/` 为引擎适配器 |

## 测试

```bash
node --test               # 全部：164 项，162 pass / 2 skip
```

V1–V6 日志流水线，V7–V11 引擎释放与工作区记忆，S 系列压缩接缝，I 系列闸门不变量，
X 系列跨平台采样/归一/重试，M 系列记忆归属与消重，P 系列组合包清单，
H 系列宿主接入（工具、记忆注入、删除监听），U 系列 UI 的 HTTP 面（认证 / 投影 / 拒绝路径），
C 系列 Client 半边（清单、注册、渲染一次），Z 系列会话清单与回收站，W 系列会话接口（确认 / 409 / 触发清理）。

> 界面验收分两半：`node --test` 只证明接线与文案；卡片是不是真的长在插件页上、
> 图标与中英文标题是否正常，必须在装好的页面里看（见 `docs/DECISIONS.md` D20）。

更多取舍见 [`docs/DECISIONS.md`](docs/DECISIONS.md)，压缩挂载点见 [`docs/whalebone.md`](docs/whalebone.md)。

MIT © ccr-wer
