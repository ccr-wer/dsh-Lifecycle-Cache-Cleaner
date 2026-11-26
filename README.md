# dsh-lifecycle-cache-cleaner

DSH 本地 Agent 的缓存生命周期管理组合包：**该清的时候清干净，不该清的时候一根手指都不动。**

它管三件事：

1. **上下文重建的残留**——压缩/重建之后，旧 KV cache 还占着显存，得有人收。
2. **会话堆积**——会话目录越攒越多，占磁盘也拖慢启动，得能看见、能删、能反悔。
3. **每次都要重复交代的事**——你怎么被称呼、用什么语气、这个项目有什么约定，
   得有个地方写一次、以后自动带上。

> 核心约束：**探测不到本地部署，就不清理**。所有清理只有一个入口
> （`lib/core/release-gate.js`），除它以外没有任何代码调用 `destroyEngine()`。

## 安装

要求 Node >= 18.17。

本包既是库，也是**可安装的 DSH 组合包**：`package.json` 声明 `dsh.bundle.patch`，
`cordis.patch.yml` 插入一行插件条目，入口 `index.js` 导出 `apply(ctx, config)`。

```text
Plugins → Add plugin → 选本目录
# 或让插件管理器执行 install_bundle
```

装上后无需重启 DSH：工具、侧栏入口、插件页卡片都是热挂载的。
如果界面没刷新出来，刷新一次页面即可（Client bundle 有版本号，重载后会重新拉）。

## 功能总览

| 能力 | 在哪 | 一句话 |
|---|---|---|
| 状态卡 | **Plugins → 本插件** | 引擎/闸门/记忆一行状态 + 一个「释放引擎」按钮 |
| 会话面板 | 侧栏底部 → **会话** | 会话清单 + 标题 + 删除（移到回收站，可反悔） |
| 个性化 | 侧栏底部 → **个性化** | 称呼 / 名字 / 风格 / 长期指令 / 人设，**只有你能写** |
| 记忆面板 | 侧栏底部 → **记忆** | 共享 + 每个工作区一组，模型提议、你点头才落库 |
| `lifecycle_cache_status` | 模型调用 | 只读体检：探测结论、闸门判定、记忆用量 |
| `lifecycle_cache_clean` | 模型调用 | 经闸门释放引擎，`confirm: true` 才动手 |
| `lifecycle_memory_propose` | 模型调用 | 只进「待确认」队列，你接受才写进记忆 |
| 会话删除监听 | 自动 | 会话目录消失 → 释放租约 → 过闸门 |
| 上下文压缩钩子 | 自动 | `compaction/end` 且压缩成功 → 过闸门清一次（失败不清） |
| 清理结果提示 | 自动（全局浮层） | 释放成功弹一条；没探测到本地部署时也弹一条「这次没有清理」 |
| 记忆检索 | 自动 | 注入时按当前问题排序；预算挤掉的条数在面板里可见 |
| 记忆注入 | 自动 | 共享层进全局 prompt，工作区层按会话 cwd 注入 |

## 界面

### 插件页状态卡

```text
生命周期缓存   引擎 absent · 闸门拒绝（skip_absent） · 记忆 0/0   [刷新] [释放引擎(禁用)]
```

- 数据来自同源只读路由 `GET /lifecycle-cache/api/status`，释放走 `POST /clean`。
- **浏览器里没有闸门逻辑**，判定只有 `lib/core/release-gate.js` 一份。
- 闸门不放行时按钮禁用，并说明原因（`skip_absent` / `skip_unknown` / `skip_no_lease` /
  `skip_foreign` / `no_destroy`）；返回 `released: false` 就照实显示，不伪造“已释放”。

### 清理结果提示

钩子触发的清理是**后台**发生的：你删完会话、或者模型调了一次工具，界面不会自己更新。
所以插件在全局浮层（`shell.overlay`）挂了一个提示，**不管你停在哪一页都能看到**：

```text
┌──────────────────────────────────────────────────────────────┐
│ 已释放本地模型的 KV 缓存（删除会话触发）。        [知道了] │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│ 本机没有探测到本地模型部署，这次没有清理任何东西。 [知道了] │
└──────────────────────────────────────────────────────────────┘
```

两种结局都要说清楚，这是卖点的一部分：

| 情形 | 提示 |
|---|---|
| 真的释放了 | 「已释放本地模型的 KV 缓存（会话删除触发 / 上下文压缩触发 / 你点的释放 / 模型调用释放）」 |
| 本机没部署引擎 | 「本机没有探测到本地模型部署，这次没有清理任何东西」（闸门拒绝，绝非乱删） |
| 有引擎但不属于本插件 | 「有引擎但它不归本插件，按归属规则不清理」 |
| 有引擎但没有租约 | 「有引擎但没有对应租约，无法证明归属，不清理」 |
| 释放报错 | 「释放失败：端口被占用」 |

实现要点：Host 侧 `runtime.lastRelease` 记录最近一次**真正尝试**过的清理（成功、按闸门拒清、
失败都算；`confirm: false` 的预览不算，否则打开面板就会被“没有清理”刷一遍），
`/status` 把它投影出去；Client 每 5 秒轮询一次，只认 `seq` 递增，首轮只对齐不补弹历史。
提示 6 秒自动消失，也可点「知道了」立刻关。

### 侧栏「会话」

```text
会话（删除 = 移到回收站）
--C-Users-…-default-workspace--
  测试称呼提问
  session-37681fcd · 最后活动 2026/11/22 19:45:22 · 56.7 KB        [删除]
  根据交接文档完成任务
  session-9daf7f36 · 最后活动 2026/11/22 19:44:55 · 2.3 MB
  最近 2 分钟内被写过，暂不允许删除                                 [删除(禁用)]
```

**标题**从会话日志的 `session/title` 事件读（拼接 zstd 帧按帧解，取 `seq` 最大的那个）；
读不到就显示短 id。列表里永远带短 id，方便和 URL、日志对得上。

**目录名有兩種**：本机新建是 `session-<uuid>`，**从 App 消息历史导入的会话是裸 `<uuid>`**。
两种都认——只认前者会把整批导入的会话当成“磁盘上没有”，在面板里看不见，
还会被误报成「失效记录」。

**删除是移动，不是抹掉**：

| 步骤 | 做什么 |
|---|---|
| 1 | 目录 `rename` 到 `lifecycle-cache/trash/<时间戳>__<工作区>__session-<id>/`，搬回即可恢复 |
| 2 | 两道护栏：拒绝当前会话；最近 `sessionDeleteMinIdleMs`（默认 **2 分钟**）内写过的一律拒绝 |
| 3 | 立刻走一次租约释放 + 闸门，不等 watcher 下一轮 |
| 4 | 摘掉宿主工作区索引（`workspace.json` 的 `sessionIds`）+ 删投影缓存，否则侧栏还会显示 |
| 5 | 通知客户端移除该行（`api-session/removed`），并刷新会话/工作区列表 |

路径只认 uuid：`session-<id>` 的 id 必须是 uuid 形状，目标必须真的在 `sessions/` 根下。

如果历史遗留了「索引里有、磁盘上没有」的会话，面板顶部会出现
「导航页还有 N 条失效记录」，点「清理失效记录」即可摘掉（`POST /sessions/repair`，幂等）。

### 侧栏「个性化」

| 字段 | 说明 | 上限 |
|---|---|---|
| 它怎么称呼你 | `userName` | 60 字符 |
| 它叫什么名字 | `assistantName` | 60 字符 |
| 回复风格 | `style`：默认 / 简洁 / 详细 | 枚举 |
| 长期指令 | `instructions`，每次对话生效 | 4000 字符 |
| 人设 | `persona`：身份、性格、表达方式 | 4000 字符 |

**模型没有任何写入口**：没有对应工具，也没有模型能调的 HTTP 方法。这样“它怎么称呼你”
不会自己漂移。保存后渲染成一段 prompt；**全空时不生成任何内容**，不占预算。

### 侧栏「记忆」

```text
▾ 共享记忆（所有工作区共享）                  3 条 · 1 条待确认
    写一条要记住的事实…                        [添加]
    模型建议写入（等你确认）
    │  部署前必须跑完整测试套件   理由：跨仓库通用      [接受] [拒绝]
    └ 发布前必须跑完整测试套件  你写的 · 更新于 …      [删除]
▸ alpha                                       0 条
▸ default-workspace                           2 条
```

- **工作区组自动出现**：来自宿主 `workspaceRegistry`，新建项目被 DSH 登记后就会多一组；
  再并上 `typed.json` 里已出现过的工作区（历史数据不丢）。面板开着时每 5 秒静默重拉一次，
  新建工作区最多 5 秒后出现，不用关掉重开。
- **组名**：优先用宿主登记的工作区标题，没有才用路径最后一段；重名补父目录
  （`default-workspace (one)`），悬停显示完整路径。
- **只有条目，没有整段文档编辑器**：文档不参与注入，写进去模型也读不到（D28）。
- **上次注入可见**：面板顶部显示「上次注入：共享 3/3 条 · 工作区 5/8 条」，
  被预算挤掉的条目标黄提示——记了却没生效，一眼能看出来。

谁写、写到哪：

| 谁 | 入口 | 归属 |
|---|---|---|
| 用户 | 面板「添加」 | 哪个组就写哪个组 |
| 用户 | 面板「接受」 | 提议自带的目标 |
| 模型 | `lifecycle_memory_propose` | 只进 `memory/pending.json`，接受前不进记忆 |

提议参数：`text`、`scope`（`shared` / `workspace`）、`workspace`（工作区绝对路径，workspace 时必填）、
`reason`。同一目标下相同文本只排一条；队列上限 50；工作区提议缺路径直接拒收。

## 一条最重要的规则

```text
探测结果 absent  -> 不清理（只整理日志）
探测结果 unknown -> 不清理（fail-closed）
探测结果 present + 归属成立 -> 才允许动引擎
```

- 会话删除走 `ownership: 'lease'`（必须有租约且三要素匹配）；
- 本包自建引擎走 `ownership: 'adapter-exclusive'`（适配器即所有者）。
- **适配器不实现 `probeEngine()` = 永远不清理**。拿不到证据就不许删，这是有意的。

## 配置

```yaml
- id: lifecycle-cache-cleaner
  name: 'dsh-lifecycle-cache-cleaner'
  config:
    rootDir: 'C:\\Users\\you\\.dsh'   # 不填则取 DSH_HOME，再退到 ~/.dsh
    ownership: adapter-exclusive       # 或 lease
    engine:
      kind: auto                       # auto | ollama | llamacpp | none
      baseUrl: 'http://127.0.0.1:11434'
    releaseOnDelete: true              # 删除会话后是否经闸门释放引擎
    releaseOnCompact: true             # 上下文压缩成功后是否经闸门清理
    compactDebounceMs: 1500            # 连续压缩的合并窗口
    watchIntervalMs: 5000              # 会话目录扫描间隔
    watchSessions: true                # false 则完全不开监听
    sessionDeleteMinIdleMs: 120000     # 最近 2 分钟有写入就拒绝删除；0 = 关掉
```

**压缩钩子挂在 `compaction/end`**（不是解析 checkpoint 消息）：

| 事件 | data | 处理 |
|---|---|---|
| `compaction/end`（成功） | `{ compactionId, turn, sourceCommandId? }` | 过闸门清一次 |
| `compaction/end`（失败） | 同上 + `error` | **不清**——压缩失败上下文没变，清了只会让下一次重新算 |
| 其它事件 | — | 忽略 |

一次压缩事务只发一个 `compaction/end`。`compactDebounceMs` 合并的是**多来源短时间接连落地**
（多个会话同时压缩、手动压完又自动压、自动/手动交替）——清理目标是同一个全局引擎，
这一串里清一次就够了。

**宿主没有「会话已删除」事件**：删除是 UI/其它插件做的文件级操作。所以删除链路靠轮询
`sessions/<工作区>/session-<uuid>/` 实现：目录消失 → 释放租约 → 过闸门。
清理失败不回滚删除，也不阻塞它。

## HTTP 接口

全部同源、owner-only：每个请求先过 `ctx.connection.admit(req)`，`connection` 缺席直接 503。

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/lifecycle-cache/api/status` | 引擎 / 闸门 / 记忆投影 |
| `POST` | `/lifecycle-cache/api/clean` | `{ confirm: true }` 经闸门释放 |
| `GET` | `/lifecycle-cache/api/sessions` | 会话清单 + `minIdleMs` + `orphans` |
| `POST` | `/lifecycle-cache/api/sessions/delete` | `{ id, confirm: true, currentSessionId? }` |
| `POST` | `/lifecycle-cache/api/sessions/repair` | 摘掉「索引有、目录没了」的失效记录 |
| `GET` | `/lifecycle-cache/api/profile` | 读用户设定 + 风格枚举 |
| `PUT` | `/lifecycle-cache/api/profile` | 保存（合并式，校验失败不落盘） |
| `GET` | `/lifecycle-cache/api/memory` | 共享组 + 工作区组 + 待确认提议 + 预算 |
| `POST` | `/lifecycle-cache/api/memory/entry` | `{ scope, workspaceId?, text }` |
| `POST` | `/lifecycle-cache/api/memory/entry/remove` | `{ id, confirm: true }`（可恢复被取代版本） |
| `POST` | `/lifecycle-cache/api/memory/pending/accept` | `{ id }` 接受提议 |
| `POST` | `/lifecycle-cache/api/memory/pending/reject` | `{ id }` 拒绝提议 |
| `PUT` | `/lifecycle-cache/api/memory/doc` | `{ workspaceId, text }`（UI 不暴露，留给库/手工） |
| `POST` | `/lifecycle-cache/api/memory/doc/archive` | `{ workspaceId, confirm: true }`（同上） |

## 数据放在哪

| 内容 | 路径 |
|---|---|
| 用户设定 | `<rootDir>/lifecycle-cache/profile.json` |
| 记忆条目 | `<rootDir>/memory/typed.json` |
| 待确认提议 | `<rootDir>/memory/pending.json` |
| 工作区文档 | `<rootDir>/memory/workspaces/<key>.md` |
| 文档归档 | `<rootDir>/memory/.archive/` |
| 删除的会话 | `<rootDir>/lifecycle-cache/trash/` |

**记忆两层，写入权限不同**：

- 归属由程序裁决：模型给的是建议，命中本地绑定信号（盘符路径、POSIX 绝对路径、
  `localhost:port`、端口号、文件后缀）就强制落工作区；
- 写入前去重（相似度 0.9）：完全相同只刷新时间；高相似则新条目 `supersedes` 旧的，
  旧条目不删；骨架相同但数字全不同则互标 `conflict`，等你裁决；
- 同一事实在 ≥2 个工作区被独立确认后，自动复制一份到共享层；
- 注入预算：共享 1KB / 工作区 2KB，超出截断并计数（不静默丢）。

**注入按会话走**：共享层进全局 prompt section；工作区层按**会话自己的 cwd** 给每个 agent
注册一段 scoped section，所以 A 项目的条目不会出现在 B 项目的对话里。

**注入顺序按当前问题排**（不是“最新的塞满预算”）：插件记住该工作区最近一条用户消息，
用字符二元组覆盖度给条目打分——被这条消息问到的地方多的排前面，完全无关的按时间兜底。
**没有任何向量检索、没有 embedding 依赖**：这样卸载即净，也不需要你本地有 embedding 模型。
条目多到预算放不下时，面板会显示丢弃了几条。

## 目录结构

| 路径 | 职责 |
|---|---|
| `index.js` | 插件入口：注册工具、记忆注入、会话监听、UI 的 HTTP 面 |
| `client.js` | Client 半边：状态卡 + 三个侧栏面板（React + 主题变量，无宿主 Client 包） |
| `cordis.patch.yml` | 组合包 patch：插入一行插件条目 |
| `lib/host/runtime.js` | 运行时：探测 → 闸门 → 释放，记忆文本与删除后处理 |
| `lib/host/tools.js` | 三个工具定义与文本渲染 |
| `lib/host/web-api.js` | UI 的 HTTP 面：认证 → 路由（不做判定） |
| `lib/host/session-store.js` | 会话清单与「移到回收站」：uuid 收敛、空闲窗口、占用检测、标题读取 |
| `lib/host/session-watcher.js` | 会话目录监听（轮询，跨平台一致） |
| `lib/host/compaction-hook.js` | 上下文压缩钩子：`compaction/end` 成功才清，失败忽略 |
| `lib/host/profile-store.js` | 用户设定：校验、原子写、渲染 prompt 片段 |
| `lib/host/proposal-store.js` | 模型提议队列：去重、上限、接受/拒绝 |
| `lib/core/memory-store.js` | 记忆条目：归属裁决 / 消重 / 升级 / 注入预算 |
| `lib/core/release-gate.js` | **统一清理闸门** |
| `lib/core/ownership.js` | 归属判定（唯一安全阀，纯函数） |
| `lib/core/engine-probe.js` | 只读探测（零写操作） |
| `lib/core/vram-cleaner.js` | 分级释放 + 采样验证（禁用 `top`） |
| `lib/core/atomic.js` | 原子写 + rename 重试（Windows 瞬时锁） |
| `adapters/engine-http.js` | 本地引擎探测（只读 GET）与 ollama 卸载 |
| `cleaner.js` `session-deleter.js` `worklog.js` 等 | 日志流水线、删除编排、工作日志固化 |

## 测试

```bash
node --test               # 243 项，241 pass / 2 skip
```

skip 的两项是 macOS-only 的真实下降断言（V2/V2b）。

覆盖：V 系列日志流水线与引擎释放，S 压缩接缝，I 闸门不变量，X 跨平台采样/归一/重试，
M/N 记忆归属与消重，H 宿主接入（工具、注入、删除监听），U/W/Z 会话接口与回收站，
R/F 用户设定，Y/J 记忆面板与提议队列，K 清理提示依据（成功 / 没部署 / 预览不记录 / seq 递增），
L 压缩钩子（成功才清 / 失败不清 / 合并窗口 / 卸载），Q 记忆检索（相关度排序 / 时间兜底 / 丢弃可见），C Client 半边。

> 界面验收分两半：`node --test` 只证明接线与文案；卡片是否真的长在页面上，
> 必须在装好的界面里看。

## 跨平台

| 能力 | Windows | Linux | macOS |
|---|---|---|---|
| 闸门 / 日志固化 / 状态机 | ✅ | ✅ | ✅ |
| 引擎释放（HTTP） | ✅ | ✅ | ✅ |
| 释放验证采样 | `tasklist` | `/proc` Pss | `vmmap` |
| 显存口径 | `nvidia-smi` | `nvidia-smi` | 不适用 |

路径一律经 `canonicalPath()` 归一（`realpath` 解软链/junction，win32 转小写）。

**已知边界**：真实下降断言只在 macOS 跑过；Windows/Linux 采样器目前只有单元测试覆盖。

## 作为库使用

1. 适配器至少实现 `probeEngine()` 与 `destroyEngine()`，前者返回
   `owned_idle | owned_busy | foreign | absent`，抛错即视为 `unknown`；
2. 会话创建时登记 `engine_ref`（租约），删除时只校验、不推断；
3. 跑 `node --test`。

不实现 `probeEngine()` 也能装——代价是永远 `skip_unknown`，什么都不清理。

更多取舍见 [`docs/DECISIONS.md`](docs/DECISIONS.md)。

MIT © ccr-wer
