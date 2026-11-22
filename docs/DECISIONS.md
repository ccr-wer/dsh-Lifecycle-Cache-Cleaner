# 实现决策记录

> 记录"为什么这样保守"，以及已知缺口。每条都标注了可验证的落点（测试或文件）。

## D1. 探测返回 `owned_*`，但安全阀只在 `ownership.js`

**背景**：需求同时要求"探测返回枚举（含 `owned_idle/owned_busy`）"和"`ownership.js` 是唯一安全阀"。
这两件事听起来冲突。

**取舍**：双层。探测给的 `owned_*` 只是**给 UI 的粗分类**（决定勾选框长什么样）；
真正决定"能否动引擎"的只有 `decide()`，它重新校验三要素，可以把探测的乐观结论降级为 `unknown`。

**落点**：`engine-probe.js:classify()` → 仅 UI；`session-deleter.js` 清理前必过 `decide()`。

**如果简化成一层会怎样**：探测层需要读租约并做归属判断，等于把安全阀拆成两处，
只要有一处遗漏就是误删。

---

## D2. 探测缓存：`absent` 缓存，`unknown` 不缓存

**取舍**：`absent` 命中直接短路（省钱、省时，且"没有引擎"这个事实不会瞬间反转）。
`unknown` 不写缓存——它代表"这次没测准"，缓存 30s 会让一次网络抖动变成半分钟的永久失效。

**落点**：`engine-probe.js` 的 `if (result.state !== PROBE_STATE.UNKNOWN)`。
**验证**：V9-5（unknown 后重新探测）。

---

## D3. `slot` 档对 llama.cpp 返回 `unverifiable`，而不是"成功"

**背景**：`POST /slots/{id}?action=erase` 有 HTTP 200，看起来"成功了"。

**取舍**：它走 `seq_rm`，只清指针，RSS 不变。返回 `verifiable:false` +
理由码 `slot_erase_does_not_free_rss`，状态为 `unverifiable`，**不显示释放量**。

**代价**：llama.cpp 用户勾了"释放显存"却看到"未验证"，体验偏冷淡。
这是刻意的——撒谎的进度条比冷淡的提示更糟。

**落点**：`adapters/llamacpp.js`；`vram-cleaner.js` 的 `release.verifiable === false` 分支。
**验证**：V8-4。

---

## D4. Ollama 的 `slot` 档直接 `blocked`

Ollama 没有 per-slot 概念。"slot 档"对它而言是无意义动作，与其发一个空请求装作做过，
不如明确 `blocked(ollama_has_no_slot_level)`，让 UI 引导用户选 `model` 档。

**落点**：`adapters/ollama.js:release()`。

---

## D5. 状态机保持 5 态，三种收敛塞进 `releaseStatus`

需求固定了 `idle → probing → ownership_check → cleaning → verified`。
但 `verified` 实际有三种含义：真降了 / 请求了但没等到 / 根本不可测。

**取舍**：不新增状态，用 `releaseStatus ∈ {released_verified, release_requested, unverifiable}`
区分。**绝不把后两者写成 `verified: true`**。

**落点**：`session-deleter.js` 末尾；V8-4 断言 `r.verified === false`。

---

## D6. 互斥用"跳过"，不排队

需求明确"不排队等锁"。压缩重建在 `tearing_down`/`rebuilding` 时，删除直接 `skipped_busy`，
仍然删会话、仍然释放租约。排队会带来两个新问题：用户点了删除却卡住、以及重建失败后
排队的删除把半成品状态清掉。

**落点**：`session-deleter.js` 的 `isBusy()` 分支；V10-1。

---

## D7. 并发删除复用同一个 Promise

`this.inflight` 存的是 Promise 本身，第二个调用直接拿到同一个结果对象。
比"加锁 + 第二次返回空"更好：两个 UI 入口拿到一致的结果，且不会重复写引擎。

**落点**：`session-deleter.js:delete()`；V10-2 断言 `a === b` 且 `writes === 1`。

---

## D8. 清理失败不回滚

会话删除和显存释放是**两个独立目标**。引擎炸了不应该让用户删不掉会话。
失败只落审计 + 非阻塞提示，租约照常释放（避免留下幽灵归属）。

**落点**：`#run()` 的 `finish()` 无条件执行；V10-4。

---

## D9. 采样器只认 `footprint` / `nvidia-smi`

`top` 的 RSS 在 macOS 上漏 compressor、对 `malloc_zone` 归还迟钝，是"假释放"的主要来源。
`makeSampler()` 对未知 kind 直接抛错，**没有绕过路径**。

**落点**：`vram-cleaner.js:makeSampler()`；V8-1。

---

## D10. 验证一律轮询

单次快照会因为"释放正在异步进行"给出假阴性，也会因为一次抖动给出假阳性。
默认 1500ms / 100ms 轮询，观察到 ≥50% 下降才认。

**落点**：`vram-cleaner.js` 主循环；V8-2 断言 `attempts >= 1`。

---

## D11. 旧会话不回填租约

见 `engine-ref-schema.md` §3。任何回溯匹配都是启发式，在共享 Ollama 场景下必误伤。

**落点**：`planLegacyMigration()`；V7-1。

---

## 已知缺口 / TODO

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| T1 | **llama.cpp 缺省档位偏低效**：用户勾了释放却得到 `unverifiable` | 体验 | 对 `spawnedBy==='dsh'` 的 llama.cpp 引擎，UI 默认推荐 `process` 档，`slot` 降级为次要选项 |
| T2 | **MLX 无显存断言** | 只能给"已请求" | 接入 `mx.get_active_memory()` 作为补充信号（需宿主暴露），仍不产出"释放了 X GB" |
| T3 | **多引擎并发探测未并行** | 多个引擎时串行，最坏 N×300ms | 探测已按短超时兜底；可改为 `Promise.allSettled` 并保留"首个非 absent"语义 |
| T4 | **`allowedPidPaths` 缺省为空** | `spawnedBy !== 'dsh'` 的外部引擎一律 unknown | 这是安全的默认值；宿主若想支持外部引擎，需显式配置白名单 |
| T5 | **租约 TTL 到期未自动清理** | 长期运行会积累 released 记录 | 增加 `prune()`，按 `releasedAt` 归档 |
| T6 | **`estimateBytes` 依赖 `/api/ps` 的 `size_vram`** | 部分 Ollama 版本字段缺失 | 缺失时不显示 GB 数，只显示"N 个引擎" |
| T7 | **进程级杀进程未做优雅退出** | `kill` 由宿主注入，可能直接 SIGKILL | 宿主侧应实现 SIGTERM → 等待 → SIGKILL |
| T8 | **工作区记忆只归档不回收** | `.archive/` 只增不减 | 归档保留期由用户/UI 决定；插件不自动清空归档（那是真删除，必须人工） |
| T9 | **`workspaceId` 由宿主提供** | 宿主不传就完全不进索引 | 有意如此：宁可机制不介入，也不由插件猜 cwd 归属 |

---

## D12. 工作区记忆：只标记、只归档、永不自动删

**背景**：删除会话时要不要顺手把工作区日志也删了？

**决策**：不。分三步，且每一步都不通向自动删除：

1. `WorkspaceRegistry` 在会话建立时登记 `workspaceId`，删除成功后 `markDeleted`。
2. `findOrphanWorkspaces()` 只在"活会话=0 且 记忆存在 且 闲置≥`orphanMinIdleDays`（默认 30 天）"时返回候选，**零写操作**。
3. `archiveWorkspaceMemory()` 必须 `confirmed:true`，用 `rename` 移到 `.archive/`，可 `restore`。

**理由**：

- 记忆存的是项目约定，价值恰恰在跨会话；删会话不等于想遗忘项目。
- "零会话"是瞬时状态（关掉全部会话准备重开、删一条再建一条，中途都会出现）。
- 按 `cwd` 归属会漂移（子目录、monorepo、目录改名），所以 `workspaceId` 由宿主给，插件不猜（T9）。
- 不用状态机锁：`delete()` 与归档是两条独立路径，归档失败不影响删除。

**可验证落点**：V11-1（删光不删记忆）、V11-3（扫描零写）、V11-5（无 confirmed 拒绝）、V11-6（移动+可 restore）、V11-7（残留索引不误报）。

---

## D13. 清理一律过闸门；探测不到部署就不动引擎

**背景**：探测只存在于“删除会话”链路，压缩链路与水位重建链路直接调 `destroyEngine()`，三条路的行为不一致。

**决策**（用户拍板）：

1. **合并为单包**：不再拆 core。跨包相对引用会让 npm 发布再次断裂，而两个包本质上就是一个插件。
2. **探测缺失 = `unknown` = 不清理**（fail-closed）。适配器不实现 `probeEngine()` 就永远不清理。
3. **日志整理完成才算压缩完成**：`onCompacted()` 的 `compactionComplete` 只取决于日志固化；缓存释放是后置动作，失败不影响“压缩完成”。

**结构**：

```
会话删除 delete()  ┐
压缩完成 onCompacted() ├─▶ lib/core/release-gate.js ─▶ 探测 ─▶ 归属 ─▶ 放行/拒绝
水位重建 rebuild()   │        （唯一入口，唯一安全阀出口）
手动 / 崩溃续跑      ┘
```

归属有两种模式：`lease`（会话删除，三要素必中）与 `adapter-exclusive`（本包自建引擎，适配器即所有者）。

**可验证落点**：`test/release-gate.test.js` 的 I1–I5；`test/compaction-seam.test.js` 的 S1–S10；合并后全量 91 项（89 pass / 2 skip）。

---

## T10. 适配器尚未实现 `probeEngine()`

`adapters/dsh.js` 仍是空壳，因此真实 DSH 环境下闸门会持续返回 `skip_unknown` —— **这是当前期望行为**（宁可不动），但不代表功能可用。实测环境就绪后必须实现 `probeEngine()`，否则“能清理”这件事从未被真正验证过。

---

## D14. 跨平台：验证采样、路径归一、rename 重试

**背景**：审计发现三处“只在某个平台成立”的假设。判定逻辑本身是跨平台的（路径全注入、core 不起进程、引擎控制走 HTTP），但验证环节不是。

**决策**：

1. **补全采样器**（`vram-cleaner.js`）
   - `footprint` —— macOS，`vmmap` 的 Physical footprint（含 compressor）
   - `nvidia-smi` —— Linux / Windows + NVIDIA，按进程 `used_memory`
   - `proc-rss` —— Linux，`/proc/<pid>/smaps_rollup` 的 Pss，回退 `status` 的 VmRSS
   - `win-rss` —— Windows，`tasklist` 的 Mem Usage（工作集）
   - `pickSamplerKind()` 选型：有 NVIDIA 优先显存取数；未知平台返回 `null`，结果归 `unverifiable`（**不假装验证过**）。
   - `top` 仍然硬拒绝。
2. **路径归一**（`ownership.js`）
   - `canonicalPath()`：`path.resolve` + win32 转小写，可选注入 `realpath` 解软链/junction 别名。
   - 默认不做 IO，保持 `decide()` 可测；宿主层（`session-deleter`）注入 `realpathSync.native`。
   - 归一失败不改变判定语义（该拒就拒），只是把“写法不同”从“不存在”里排除出去。
3. **rename 重试**（`lib/core/atomic.js`）
   - 只对 `EPERM` / `EBUSY` / `EACCES` 线性退避重试（默认 5 次，最坏 300ms）。
   - `ENOENT` / `EXDEV` 等真实错误**一次就抛**，不许吞掉变成“看起来成功”。
   - 五处 `tmp -> rename` 全部改为 `writeFileAtomic()` / `renameWithRetry()`。

**可验证落点**：`test/cross-platform.test.js` 的 X1–X7；全量 98 项（96 pass / 2 skip）。

---

## D15. 记忆分层：模型提议、程序裁决、写入前消重

**背景**：希望模型自动决定“这条该写工作区还是写共享”。直接交给模型不行——共享层被单个工作区的临时约定污染后，所有工作区都会读到错的东西。

**决策**：

1. **归属程序算，模型只给建议**。裁决顺序：命中本地绑定信号（盘符路径、POSIX 绝对路径、`localhost:port`、端口号、文件名后缀）→ 强制工作区；否则採模型建议；再否则保守落工作区。不一致时把 `scopeReason` 存进条目。
2. **写入前消重**，阈值 0.9（字符二元组 Jaccard，中英文都适用，不依赖分词）：
   - 完全相同 → 不新增，只刷新 `updatedAt`
   - 高相似 → `supersedes` 链，旧条目标 `supersededBy`，**不删**
   - 骨架相同但数字全不同 → 两条并存、互标 `conflict`（端口 11434 vs 11435 这类）
3. **自动升级**：同一事实在 ≥ 2 个工作区被独立确认 → 复制一条到共享层（`source: 'promoted'`）。先自动，后期再做 UI 人工编辑。
4. **存储不拆文件**：`memory/typed.json` 单文件 + 条目数组。拆成 rules/decisions/facts 会让“该写哪类”的判断成本盖过收益。
5. **读取硬预算**：共享 1KB / 工作区 2KB，超出截断并计数。预算不能去掉——记忆进 systemPrompt 会与溢出闸门形成正反馈。

**为什么阈值是 0.9**：0.85 在“长文本只说了一半”时误合并风险偏高；短文本靠 0.9 判不出来时，由骨架+数字冲突规则兜底。

**可验证落点**：`test/memory-store.test.js` 的 M1–M9；全量 108 项（106 pass / 2 skip）。

---

## T12. 记忆只做到“写入与读取”，UI 还没提供编辑

升级目前是自动的（≥2 工作区），冲突条目只标 `conflict` 等用户裁决，**插件没有提供裁决入口**。UI 补上人工编辑/合并/忽略之前，冲突项会一直挂着。

---

## D16. npm 包名补上 DSH 前缀

初始发布用的是 `lifecycle-cache-cleaner`，与仓库名 `dsh-Lifecycle-Cache-Cleaner` 不一致。npm 不支持改名，所以采取“新名发布 + 旧包 deprecate”而不是整包删除：

- 新包：`dsh-lifecycle-cache-cleaner`（首个版本 0.3.1，与 git tag 对齐）
- 旧包：`lifecycle-cache-cleaner` 保留，但打上 deprecation 提示指向新名；不删，避免已引用方直接中断

GitHub 仓库名不改（本来就对）。

---

## D17. 作为 DSH 组合包发布（而不是只当一个库）

**背景**：把包放进 DSH 目录直接报 `declares no dsh.bundle`——宿主的判定是“`package.json` 里有 `dsh.bundle.patch` 的才叫组合包”（原文见 `dsh-doc/references/host-plugin.md`）。此前我们只有库，没有清单，README 却说“放进插件目录即可”，是错的。

**决策**：补最小可安装骨架，但不伪造能力。

- `package.json`：`dsh.bundle.patch` → `./cordis.patch.yml`；`main` 改 `index.js`；补 `icon`、`exports`（locale / icon / patch / 库子路径）；`files` 覆盖全部运行资源
- `cordis.patch.yml`：单条 `insert`，`id: lifecycle-cache-cleaner`
- `index.js`：导出 `apply(ctx, config)`，**只打一行诊断日志，不注册任何钩子**；同时 `export *` 保留原库接口
- `locale/en.json`、`locale/zh.json`：`meta.title` + `meta.description`，描述里写明“引擎释放尚未接入宿主 API，清理一律跳过”
- 不声明 `dsh.bundle.platforms`：本包是跨平台的，省略即全平台

`apply()` 留空的理由与 T10 一致：注册哪个钩子取决于宿主真实的会话/压缩/引擎 API，未确认就不填。空实现 + 诚实描述，好过猜接口的假实现。

清单合规性由 `test/manifest.test.js`（P1–P6）持续守住——包括 patch 语法、exports 指向、icon 尺寸、locale 字段、`files` 覆盖面。

---

## D18. 宿主接入：不用 import，只靠 ctx 与 config

**背景**：把 `apply()` 留空等于装了个空壳。真实接入要回答两个问题：插件的代码凭什么能拿到宿主 API。

**决策**：

1. **不 import 任何 `@deepseek-ai/*`**。profile 的 `node_modules` 里只有 profile 安装的组合包，解析不到宿主包；对比 `dsh-session-manager@0.7.8`，它也只声明 `@deepseek-ai/cordis` 的 peer 并只 import node 内建。一切通过 `ctx.tools` / `ctx.systemPrompt` / config 访问。
2. **工具用普通对象定义**。读 `dsh-tools` 源码确认：`register()` 只校验 `output.schema` 与 `output.render`，不要求经过 `defineTool()`，因此无需 import 宿主包就能定义工具。
3. **`inject = ['tools']` 是硬依赖；`systemPrompt` 走 `ctx.inject()` 可选接入**。没有 prompt 服务的 profile 里插件仍能工作，只是不注入记忆。
4. **引擎释放默认 `adapter-exclusive` + 必须 `confirm: true`**。探测只读（GET），释放只对 ollama（`keep_alive: 0`）成立；llama.cpp server 没有卸载接口，就直接抛错，不伪造“已释放”。

**验证边界**：工具与闸门逻辑由 H1–H11 覆盖（假 ctx 捕获注册）；`systemPrompt.variable/section` 的真实签名、`ctx.inject` 的调度时机未经宿主实跑验证——这两处是装进 DSH 后才能确认的部分。

**踩到的坑（0.5.1 修）**：直接读 `ctx.systemPrompt` 会抛 `cannot get property "variable" without inject`，包在 `try` 里也没用——取值本身就抛。正确做法是完全不碰属性，只在 `ctx.inject(['systemPrompt'], sp => …)` 回调里用 `sp`。H10 用会抛错的 getter 固化了这个约束。

---

## D19. 删除会话：监视目录，而不是接管删除

**背景**：宿主没有“会话已删除”事件。`dsh-session-manager` 的做法是自己做文件级删除（连活会话的安全停止都是它自己处理），说明删除是各插件/UI 自己实现的操作，不是宿主提供的单一入口。

**决策**：

1. **不接管删除**。删除仍然由宿主 UI / 会话管理器做，我们不碰 `sessions/` 下的文件（写入零风险）。
2. **监听目录差异**。轮询 `sessions/<工作区目录>/session-<uuid>/` 两层，发现目录消失才触发；首次扫描只建基线，不报删除。
3. **删除后只做两件事**：释放租约 + 经闸门尝试释放引擎。保留 `releaseOnDelete: false` 开关。
4. **失败不回滚**。清理异常写进 `recentDeletions` 与 `diagnostics`，不影响已经完成的删除。

**代价**：轮询有最长 `watchIntervalMs`（默认 5s）的延迟；如果会话是被“移动”（重写 cwd）而不是删除，目录仍在，不会误触发。

---

## D20. 插件页 UI：同源只读 HTTP，而不是 Remote

**背景**：Host 半边（工具 / 记忆注入 / 删除监听）已经能用，但人在界面里看不到状态。
要补的是“一行状态 + 一个释放按钮”。

**决策**：

1. **不做 Remote**。读 `@deepseek-ai/dsh-api-remotes` 的 README 与源码确认：Remote 能力集合是
   **构建期**由显式 value import 固定的（“the Client does not discover the Host's active
   Services or Remote definitions at runtime”），第三方组合包无法在运行时加一个
   `remote.lifecycleCache` 命名空间。能用的第三方路径只有宿主本就暴露的 HTTP 面。
2. **同源只读 HTTP 面**。Host 用 `ctx.webServer.register({ kind: 'prefix', path: '/lifecycle-cache/api' })`
   注册两条路由：`GET /status` 投影 `runtime.status()`，`POST /clean` 转 `runtime.clean()`。
   `dsh-session-manager` 的 `/session-manager/api` 验证过这条路可行。
3. **认证复用宿主 Connection**。每个请求先 `connection.admit(req)`，只要 `principal.kind === 'owner'`；
   `connection` 缺席时回 503（fail-closed），不是“谁都能点”。
4. **闸门只有一份**。浏览器不算 `proceed`：按钮的 `disabled` 直接来自 `gate.proceed`，
   点击只提交 `{ confirm: true }`，判定仍然只发生在 `lib/core/release-gate.js`。
   释放返回 `released: false` 就照实显示 code，不伪造“已释放”。
5. **卡片注册进 `plugins.bundle.config`**（key = 包名）。读 `dsh-client-ui-plugin-manager`
   的 `slot-contract.ts` 确认：这个 keyed slot 只以 `view: 'page'` 渲染在
   **本包的插件页**上，正好是“插件页能看到状态行”要的位置；`summary` 只回一行文本。
6. **不发本机路径**。`publicStatus()` 只投影 engine / gate / memory / 会话监听 / 最近一次删除，
   `rootDir`、`workspaceId`、`diagnostics` 一概不给浏览器。
7. **不做删除入口**。删除仍归宿主 / `dsh-session-manager`；Client 不碰 `sessions/`。

**代价与已知边界**：

- 同源 HTTP 是宿主实现细节。将来宿主如果给第三方开 Remote，这里应迁移；迁移只影响
  `client.js` 与 `lib/host/web-api.js` 两个文件。
- Electron 壳把 fetch 走 IPC 桥（`dsh-host-webserver` README），这条路**只在 Web 页面验证过**，
  桌面壳里未验证。
- 可选服务用 `ctx.inject(['webServer', 'connection'], …)` 接入；但 `ctx.inject` 只在真正的
  Cordis Context 上有意义，纯对象假 ctx（测试）没有 `ctx.get`。所以注册第二个 inject 前先看
  `typeof ctx.get === 'function'`——既有 H9 断言（`inject` 调用序列只能是 `['systemPrompt']`）
  因此一字未改，代价是这条分支写得比理想状态啰嗦。
- `node --test` 只能证明接线、投影与拒绝路径；卡片是不是真的长在插件页上、图标与中英文标题
  是否正常，必须在装好的页面里看。发布说明里不许拿 U/C 系列冒充界面验收。

## D21. 自己实现会话删除：移动而不是删除（部分推翻 D19）

**背景**：D19 写下“不接管删除”，前提是删除由会话管理器负责。实际使用里这个前提不成立：
`dsh-session-manager` 一旦不在 profile 里，界面上就没有任何删除入口；而宿主本身没有删除 API
（`@deepseek-ai/dsh-session` 无 remove/delete；ACP 的 `session_delete` 是另一套协议）。

**决策**：

1. **删除由本包提供，但仍然不接管“删除后如何收拾”**：目录搬走之后照旧走
   `runtime.handleSessionsRemoved()` → 释放租约 → 统一闸门，和 watcher 发现目录消失是同一条路。
2. **移动，而不是 `rm -rf`**。`session-store.trashSession()` 把整个会话目录 rename 到
   `<rootDir>/lifecycle-cache/trash/<时间戳>__<工作区>__session-<id>/`。副作用可控、可原样搬回；
   `dsh-session-manager` 是直接 rm，我们不做那个选择。
3. **三道护栏**：
   - `currentSessionId`（UI 传当前会话）命中即拒；
   - `sessionDeleteMinIdleMs`（默认 120s）内有写入即拒——正在跑的会话本来就在写文件，
     不去猜“它是不是活的”；
   - `rename` 返回 `EPERM`/`EBUSY`/`EACCES` 即判 `busy`，不重试、不降级成 rm。
4. **路径只认 uuid**。`session-<id>` 的 id 走 `^[0-9a-fA-F][0-9a-fA-F-]{7,63}$`，目标目录必须
   真的在 `sessions/` 根下（`path.resolve` 后再做前缀比对），`../` 与符号链接都进不来。
5. **UI 侧不判断**。浏览器只负责 `POST /lifecycle-cache/api/sessions/delete`；是否允许删、
   删成没删成，全由 Host 返回（`409 + result.code`）。

**代价与已知边界**：

- 删除的是**文件**，不是宿主索引。宿主如果还有指向该会话的索引行，重启后可能报一次“找不到”，
  与 `dsh-session-manager` 的 `rm` 行为一致——这是宿主没有删除 API 的必然结果。
- “最近有写入”的窗口是启发式：刚写完但已经关闭的会话会被误判为忙，最多等一个窗口
  （可把 `sessionDeleteMinIdleMs` 调成 0 关掉）。宁可误拒，不可误删。
- 删除当前正在使用的会话会被拒（这本来也是我们不想支持的动作）；要删它请先切到别的会话。
- 与 D19 的关系：**D19 的“不接管删除”从此只对 watcher 成立**；UI 入口归本包，链路不变。

## T11. 非 macOS 尚未做过真机显存断言

采样器补齐后，Windows/Linux 的解析逻辑有单元测试覆盖，但**没有在真机上验证过“删除会话 -> 显存真的掉下来”**。V2/V2b 在非 macOS 上 skip，这是目前唯一跑过真实下降断言的平台。

发布说明里不许把 `proc-rss` / `win-rss` 写成“已验证跨平台释放”——它们只是“有了采样口径”。要摘掉这条 T11，需要：Windows 或 Linux 真机 + 至少一个本地引擎实例，跑一遍 `cleanAndVerify` 并留下 delta 证据。
