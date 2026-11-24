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

## D22. 个性化设定：用户写、模型只读

**背景**：用户明确要求借鉴 WorkBuddy 的“个性化”设置——称呼、名字、回复风格、长期指令、人设，
并且**必须由用户在界面上编辑，不能由模型写入**。

**决策**：

1. **独立文件，不进记忆库**。设定存 `<rootDir>/lifecycle-cache/profile.json`，与
   `memory/typed.json` 完全分开：记忆是“模型提议 + 用户确认 + 去重 + 升级”，
   设定是“一份用户所有物”。两套语义混在一起会让“谁写的”变得不可判定。
2. **模型没有写入口**。没有对应工具，也没有任何模型可调用的方法；唯一的写入路径是
   Client 表单 → `PUT /lifecycle-cache/api/profile` → Host 校验后原子写。
3. **合并式写入 + 校验失败不落盘**。只覆盖传进来的字段；超长/类型错误抛 `invalid_profile`，
   `writeFileAtomic` 只在全部校验通过后调用——半次保存不允许落盘。
4. **空设定不占 prompt**。全空返回空串；只填名字就只渲染那一行；风格为 `default` 时不单独成行。
   理由和记忆预算一样：prompt 里的废话会推高重建概率。
5. **复用同一个 prompt section**。`wirePrompt()` 仍是**一个 section**，里面放
   `{{lifecycle_profile}}` 与 `{{lifecycle_memory}}` 两个变量。原因是既有 H7/H9 断言
   `sections.length === 1`，新增第二个 section 会破坏基线；合并变量既满足新需求又不改旧断言。
6. **风格是封闭枚举**（`default` / `concise` / `detailed`）。下拉框不给自由文本，
   prompt 里映射成“默认 / 简洁，先给结论 / 详细，给出推理与依据”。

**代价与已知边界**：

- **只有一份全局设定**，不按工作区、不按会话；要做分层得像记忆那样再来一套归属裁决。
- **没有历史版本**。改了就覆盖，只有 `updatedAt` 留痕；要回滚得自己备份文件。
- 字段上限 4000 字符 ×2，是“防误粘贴”而不是产品约束；真写长文请进记忆或文档。
- 注入的是明文，本文件不做任何加密；共享同一 `rootDir` 的账户能看到。
- `node --test` 只覆盖校验/合并/渲染/接口；**注入后在真实对话里的效果**需要在界面里改一次、
  发一条消息才能确认（R8 只证明变量与 section 接线正确）。
- **踩过的坑**：`makeText(props)` 每次渲染都会返回新函数。把它放进 `useCallback` 的依赖，
  `load` 就每次渲染换新身份，而“打开时加载”的 effect 依赖 `load` → 无限 GET 循环；
  表现是输入框里打字立刻被重置、按钮一直禁用、点保存没反应。修法是把文本函数放 `useRef`，
  `load`/`save` 的依赖里只留真正的状态。这个坑只有真机点一遍才会发现，`node --test` 测不出来。

## D23. prompt 注入必须走 `ctx.get('systemPrompt')`，只靠 `ctx.inject` 是无效的

**背景**：D22 上线后在真机验证时发现，模型完全看不到个性化设定。查会话日志
（`<rootDir>/sessions/<ws>/session-<id>/session.v4.jsonl.zstd`，zstd 帧拼接）里的
`system/message` 记录，**连 0.5.0 就"上线"的记忆注入都不在里面**——说明
`systemPrompt.section()` 从来没注册成功，之前的 H7/H9 只证明了"假 ctx 下注册逻辑没问题"。

**决策**：`apply()` 里两条路都走：

1. `ctx.get('systemPrompt')` —— 服务已经就绪时直接拿（这是实际生效的那条）；
2. 拿不到时才 `ctx.inject(['systemPrompt'], …)` 等它上线。

并且把“走通了哪条路”写进 `runtime.diagnostics`，`lifecycle_cache_status` 能直接看到
（`prompt: 已通过 ctx.get 接上 systemPrompt`）。

**为什么**：`ctx.inject` 表达的是"等依赖可用再执行回调"。宿主里 system-prompt 往往
在本插件激活之前就已就绪，此时单靠 inject 的等待语义没有触发回调（实测回调没跑，
`diagnostics` 里连"缺少 variable/section"都没有——因为根本没进 `wirePrompt`）。
`deliverable-file-references` 这类官方包是 `export const inject = ['systemPrompt']` 直接注册，
也说明"必须在服务可用时立刻拿到它"这件事。

**顺带修的**：没有记忆时不再输出空的 `## 记忆` 标题（标题移到变量渲染里，
空则整段消失）。

**验证方式（以后都用这个）**：解压会话日志里最新的 `system/message`，看里面有没有
`## 用户设定的助手设定` 与 `## 记忆`。**光看 UI 或跑单元测试都不算验证。**

**教训**：可选服务"注册成功"不等于"生效"。凡是往 prompt 里塞东西的改动，
必须在真实会话日志里看到那段文本，否则就是自欺欺人。

## D24. 会话列表显示标题：读日志里的 `session/title`，不发明标题

**背景**：第一版会话面板只显示 `session-<uuid>`，用户根本判断不了该删哪一条。

**决策**：

1. **标题来源是会话日志**，不是我们自己起名：`session/title` 事件携带 `data.title`，
   宿主在首轮对话后生成、后续也可能重新生成。取 `seq` 最大的那个。
2. **zstd 拼接日志按帧解**。日志是 `session.v4.jsonl.zstd`，由多帧拼接；一次性
   `zstdDecompressSync` 只能解第一帧（第一帧往往只有 header 245 字节）。用魔数
   `28 B5 2F FD` 切帧后逐帧解。
3. **只解需要的帧**：前段按累计解压字节推进（上限 1MB，找到就停），后段看最后 24 帧
   （可能被重新生成过）。实测：本机 6 个会话、其中包含一个 2.4MB / 2188 帧的日志，
   冷启动整体 92ms，之后按“文件 + 大小 + mtime”缓存。
4. **永远带短 id**：标题之下仍显示 `session-<id 前 8 位>`，方便和 URL / 日志 / 错误信息对齐；
   没有标题时标题位直接显示短 id。

**代价**：标题更新有延迟（同一次打开面板会缓存，重新打开或刷新才重读）；日志很大时
前段扫描有上限，极端情况下标题可能读不到，此时退回短 id，不会报错。

## D25. 记忆的用户写入路径：归属听用户的，规则不听

**背景**：记忆原来只有 `propose()`（模型提议 + 程序裁决归属）一条写入口，界面里什么都改不了。
用户要求“共享记忆和工作区记忆都能在 UI 里编辑”。

**决策**：

1. **新开 `addUserEntry()`，与 `propose()` 并存**。区别只有归属：用户选哪层就写哪层，
   不再跑 `classifyScope`。理由：那条裁决是拦模型的（防止本机路径污染共享层），
   用户是数据所有者，且界面本来就分了两栏，程序再改归属只会让人困惑。
2. **消重 / 取代 / 冲突规则完全复用**：完全相同只刷新时间；≥0.9 相似走 supersede；
   同骨架不同数字两条都留并互标冲突。不允许“用户写的就绕过规则”，否则同一份数据会有两套语义。
3. **用户写入不触发跨工作区自动升级**。升级是“同一事实被 ≥2 个工作区独立确认”的模型链路规则；
   用户手动写一条不该被自动复制到共享层。
4. **`removeEntry()` 真删，但把被取代的旧版本恢复回来**，并清掉指向它的冲突标记。
   否则删掉新版本会让旧版本永远停在 `supersededBy` 里，成为看不见的孤儿。
5. **工作区整段文档走 `WorkspaceMemoryStore`**（`write({confirmed:true})` / `archive()`），
   空内容拒绝保存——“清空”这个动作应该走归档，而不是留一个 0 字节文档。

**代价与已知边界**：

- 用户在共享层写的条目**不经过本地绑定检查**：如果他自己把 `D:\repo` 的约定放进共享层，
  其他工作区会读到。这是“听用户的”的直接代价，界面上的标签页文案做了提示。
- 删除是物理删除（`typed.json` 里直接 splice），没有回收站；只有“恢复被取代版本”这一层保护。
- 工作区文档归档后只能人工从 `memory/.archive/` 搬回，UI 还没做“恢复”。
- `node --test` 覆盖了归属/消重/取代/删除恢复与两条接口；**注入到真实 prompt 的最终效果**
  仍需在会话日志的 `system/message` 里确认（见 D23 的验证方式）。

## D26. 模型提议 → 待确认队列；记忆面板按工作区自动成组

**背景**：D25 只给用户开了写入口，模型侧的“提议”在库里有（`propose()`）但**没有任何工具**，
等于死代码；同时面板只有“共享 / 本工作区”两个固定标签，新建项目不会出现在记忆管理里。

**决策**：

1. **模型只用工具排队，不直接写**。新增 `lifecycle_memory_propose({ text, scope, workspace, reason })`，
   把建议写进 `memory/pending.json`（`ProposalStore`），返回文案明确写“还没有进长期记忆”。
   用户在面板里点接受才走 `addUserEntry()` 落库，点拒绝直接丢弃。
2. **工作区提议必须自带路径**。`scope=workspace` 时 `workspace` 必填，否则拒收。
   面板是全局的，“当前工作区”在宿主里没有唯一答案；让模型把它看得见的绝对路径写下来，
   比让程序猜更可审计，也不会出现无主建议。
3. **同一目标下相同文本只排一条**；队列上限 50 条（`pending_full`）。避免模型反复提议刷屏。
4. **面板按宿主 `workspaceRegistry` 自动建组**，再并上 `typed.json` 里出现过的工作区：
   新建项目只要被 DSH 登记，记忆面板自动多一组可折叠的条目管理区，无需手动“创建记忆”。
   组内可加/删条目、编辑并保存整段文档、归档文档。
5. **工作区 id 统一用路径**（`workspaceId` = 工作区绝对路径）。之前用的是插件的
   `config.workspaceId ?? process.cwd()`，桌面进程里那等于 profile 目录，所有项目挤在一组，
   等于第二层共享记忆——这次一并改掉。

**代价与已知边界**：

- 接受提议时**不再跑归属裁决**（用户在界面里已经确认目标），所以模型如果把本机路径提议成
  `shared`，用户点了接受就会真的进共享层。文案里写了 scope，最终责任在点击的人。
- 提议队列是文件（`memory/pending.json`），不接受多进程并发写；与 `typed.json` 同一前提。
- 面板里的“当前”只是插件自己的工作区标记，不代表写目标；新建的工作区组要等宿主登记后才会出现。
- `node --test` 覆盖了排队/去重/上限/接受拒绝/分组；**真实注入效果**仍以会话日志里的
  `system/message` 为准（见 D23）。

## D27. 工作区记忆按 agent 的 cwd 注入，而不是插件自己的 workspaceId

**背景**：D26 把记忆面板改成按工作区分组、条目按工作区路径存；但注入还在用插件的
`workspaceId`（桌面进程里等于 profile 目录）。结果是**界面里分好了，模型读到的还是混在一起的一份**。

**决策**：

1. **全局 section 只渲染共享层**（`runtime.memoryText()` 改为 `render({workspaceId:null})`）。
2. **工作区层按 agent 注册 scoped section**：`agent/created` 时读 `agent.session.header.cwd`，
   在 `agent.ctx` 里 `inject(['systemPrompt'])` 注册 `plugin:lifecycle-workspace-memory`（order 9210），
   `text` 用 `runtime.workspaceMemoryText(cwd)` 渲染该工作区的条目（不含共享层，避免重复）。
3. **热重载补注册**：插件重启时已有 agent 不会再发 `agent/created`，所以同时用
   `ctx.get('agents').list()` 补一遍；这样改代码/重启插件后当前会话也能立刻拿到。
4. 拿不到 cwd 的 agent 不注册（共享层照常注入）。

**代价与已知边界**：

- 依赖 `agent.session.header.cwd` 与 `agents.list()` 这两个宿主内部形状；宿主改了要跟着改。
- 工作区**整段 Markdown 文档**目前仍然只落盘、不进 prompt（注入的只有条目）。
  要不要把文档也注进去是下一个决定——它会和 2KB 预算抢空间。
- `node --test` 覆盖了隔离渲染与 section 注册（N9/N10）；真实效果仍要看会话日志的 `system/message`。

## D28. 砍掉 UI 里的“整段工作区文档”：它既重复又不生效

**背景**：D25 给工作区记忆同时开了两条路——一条是整段 Markdown 文档（`WorkspaceMemoryStore`），
一条是条目（`typed.json`）。用户实际用了一次就发现：同一个事实写了两份。

**问题不是“看起来重复”，而是文档这一条根本不生效**：

- 注入只读条目（`TypedMemoryStore.render`），`memory/workspaces/<key>.md` 从来没进过 prompt；
- 于是文档里写的东西，模型永远读不到，用户却以为自己记住了；
- 两条路还表达同一件事，用户无法判断该写哪边。

**决策**：**UI 只保留条目**。工作区记忆 = 一组条目（有去重、取代、冲突、预算、按会话 cwd 注入）。
`WorkspaceMemoryStore` 与 `PUT /memory/doc`、`POST /memory/doc/archive` 保留给库用法和手工维护，
但界面里不再暴露——宁可少一个入口，也不要一个“写了没人读”的入口。

**代价**：长文形式的背景资料没有地方写了。真要写，应当进条目（一条一句事实）或工作区里的
文档文件（由人手工维护、不承诺进 prompt）。如果将来决定把文档也注入，再一起处理预算分配。

**顺带清掉的**：决策落地时用户已经写了一份 44 B 的重复文档，用 `WorkspaceMemoryStore.archive()`
移到 `memory/.archive/`（可人工搬回），没有直接删。

## D29. 工作区组的显示名：标题优先，重名补父目录

**背景**：D26 用路径最后一段当组名，不同盘下同名目录（`C:\a\default-workspace` 与
`D:\b\default-workspace`）在面板里长得一模一样，用户分不清在管哪个。

**决策**：

1. **标题优先**：宿主 `workspaceRegistry` 登记了 `title` 就用它，没有才退回路径最后一段。
2. **重名消歧**：显示名冲突时补上父目录名（`default-workspace (one)` / `default-workspace (two)`）。
3. **分段不用 `path.basename`**：它只认当前平台的分隔符，测试里传 Windows 路径在 POSIX 上会整段返回。
   统一按 `[\\/]+` 切段，跨平台一致。
4. **悬停显示完整路径**：显示名再短也不怕，`title` 属性里放的是完整 id。
5. **补后缀后重排**：排序用最终显示名，否则列表顺序和肉眼看到的不一致。

**代价**：改标题会改变分组顺序（按名字排）；同名工作区的组名比路径短但仍有歧义残留时，
只能靠悬停看全路径。

## D30. 删会话要连导航页的记录一起摘掉

**背景**：0.8.0 的删除只把会话目录搬进回收站。用户在导航页仍然看到那条会话，点进去报
`session "…" not found (session/not-found)`。原因不是 UI 缓存，而是**宿主工作区索引**
（`storages/workspace.json` 的 `sessionIds`）根本不知道文件被搬走了。

**决策**：删除成功后补三步，缺一不可：

1. **摘索引**：`workspaceRegistry.list()` 里找到包含该 id 的工作区，调 `workspace.detachSession(id)`。
   这是宿主自己提供的持久化 API，不是改文件。
2. **清投影缓存**：删 `<rootDir>/storages/session_projcache/sessions/session-<id>.json`。
   留着不会报错，但宿主重开时会拿旧缓存去拼一个已不存在的会话。
3. **让界面重读**：Client 侧除了 `ctx.sessions.refresh()`，再调 `ctx.workspaces.refresh()`；
   侧栏的工作区列表就是从后者来的。

**存量脏数据**：索引里已经记着、目录却不在的会话（本机就有一条），删除时不会再扫到它，
于是永远挂在侧栏。补一个显式入口：

- `GET /sessions` 附带 `orphans`（索引里有、磁盘上没有）；
- 面板顶部显示「导航页还有 N 条失效记录」，点「清理失效记录」调 `POST /sessions/repair`，
  逐个 detach，幂等。

**代价与已知边界**：

- `workspaceRegistry` 是可选服务，拿不到时 `detach` 与 `repair` 都回 503（`workspace_unavailable`），
  删除本身仍然成功——目录已经搬走，只是导航页会残留，需要重启宿主让持久化层重扫磁盘。
- `repair` 只摘「目录不存在」的 id，不动任何磁盘文件；真删仍然是删除流程的事。
- **id 形状必须归一化**：宿主 `sessionIds` 里存的是 `session-<uuid>`（带前缀），
  磁盘目录名与我们的列表用裸 uuid。第一版实现直接比较，结果把全部 6 条都判成失效——
  点一次「清理」就会清空工作区索引。现在两边都 `replace(/^session-/)` 再比，
  但**交给 `detachSession` 的仍是宿主那份原值**。这条要有测试盯着（W10）。
- 宿主内部方法名（`detachSession` / `sessionIds`）属于实现细节，宿主改了我们跟着改。

## D31. 「未分组」残留：删除只摘了归属，没通知客户端重拉列表

**背景**：D30 之后删除会把会话从工作区索引里摘掉，但用户看到它从「默认工作区」掉进
「未分组」，而不是消失。查下来是两层数据源各管一半：

| 层 | 来源 | D30 后 |
|---|---|---|
| 分组归属 | `storages/workspace.json` 的 `sessionIds` | 已摘；会话因此落进「未分组」 |
| 会话行 | 客户端 `sessions.list()`（宿主 `sessionQuery.listSessions()` → `persistence.list()` 扫盘） | 没变；行还在 |

并且**客户端列表是缓存**：只有收到 `api-session/removed` 才会少一行；而历史会话没有 live
agent，宿主不会发这个事件（它只在 `session/disposed` 时发）。

**决策**：

1. **补发事件**：删除成功后由 Host 侧 `ctx.emit('api-session/removed', id)`。
   该事件在 `api-remotes` 的转发白名单里，客户端会立刻移除那一行。
2. **显式刷新客户端列表**：`client.js` 通过 `ctx.inject(['sessions'])` / `(['workspaces'])`
   拿 scoped ctx，删除/清理后调 `refresh()`。**不能裸读 `ctx.sessions`**：未在 inject 里声明
   的服务，取值本身抛 `cannot get property "sessions" without inject`，包 try 也拦不住——
   这正是 D30 之后「刷新没生效」的真正原因（异常被 catch 吞掉）。
   拿不到服务时降级成空函数，不影响插件激活。
3. 两条路互为保险：事件即时，refresh 兜底（页面重拉时持久化层扫盘，已删目录自然不在列表里）。

**代价**：`api-session/removed` 是宿主事件契约，payload 是裸 sessionId（不带 `session-` 前缀），
宿主改签名我们要跟。存量残留（本机那条）刷新页面就会消失，不必重启。

## D32. 清理结果要有回声：成功和“没部署所以没清”都弹一条

**背景**：钩子触发的清理发生在后台——删完会话、模型调完工具，界面上什么都没有。
用户不知道缓存到底清没清；更糟的是，卖点本来就是“**没部署就不清**”，
可这条最值得炫耀的克制，用户完全看不见，反而像是功能没生效。

**决策**：

1. **Host 记一条 `lastRelease`**：`{ seq, at, trigger, released, code, probeState, reason }`。
   - `trigger` 说明是谁触发的（`manual` / `tool` / `session-deleted`），提示里直接写出来；
   - **成功、按闸门拒清、释放失败都记**；只有 `confirm: false` 的预览不记——
     否则用户打开面板就会被“没有清理”刷一遍，提示贬值。
2. **`/status` 投影 `lastRelease`**，不带任何路径与内部字段（沿用 U10 的白名单风格）。
3. **Client 挂在 `shell.overlay`**（root scope 的 list slot，不阻塞页面交互），
   每 5 秒轮询 `/status`，只认 `seq` 递增，首轮只对齐不补弹历史（插件重载后不会补弹旧结果）。
4. **文案按结局分支**：成功 / 没部署（`skip_absent`、`skip_unknown`、`no_destroy`）/
   不是自己的引擎（`skip_foreign`）/ 没有租约（`skip_no_lease`）/ 失败（带原因）。
   三种视觉调性：成功绿、克制黄、失败红。
5. 6 秒自动消失 + 「知道了」手动关。

**为什么不复用宿主的 toast slot**：`workspace.toast` 是 keyed slot，`kind` 是宿主固定的
业务枚举，第三方加不进新 kind。`shell.overlay` 才是给第三方留的“自己的浮层座位”。

**代价与已知边界**：

- 轮询是 5 秒一次的同源 `GET /status`；不想轮询的话可以改成事件推送，但那要宿主开放转发白名单。
- 提示只覆盖“清理”这一个事件；记忆提议、失效记录清理仍然在面板里就地反馈。
- 目前**上下文压缩**触发的清理还没接线（`cleaner.js` 在包里但 `index.js` 未实例化），
  所以 `trigger` 现在只会出现 `manual` / `tool` / `session-deleted`。
  接上压缩钩子后无需改 UI——加一个 `trigger: 'compact'` 的文案即可。

## D33. 压缩钩子挂在 `compaction/end`，并且只认成功

**背景**：卖点之一是“上下文压缩后清 KV 缓存”，但 `cleaner.js` 那套日志流水线
从来没有被 `index.js` 实例化过——`releaseOnCompact` 一直是死配置。D32 加提示时
`trigger` 只可能出现 `manual` / `tool` / `session-deleted`。

**挂载点选择**：DSH 的 compaction 没有“压缩完成”的全局事件，只有：

| 事件 | 何时 | data |
|---|---|---|
| `compaction/start` | 开始 | `{ compactionId, turn, sourceCommandId? }` |
| `compaction/summary` | 摘要写入 | `{ compactionId, ... }` |
| `compaction/end` | 成功**或**失败关闭 | 成功：`{ compactionId, turn }`；失败：多一个 `error` |
| `user/message`（source.kind=`compact-checkpoint`） | 成功后才写 | checkpoint 消息 |

选 `compaction/end` 而不是解析 `user/message` 的 source：

1. 一次事件就够，不用扫 surface 消息；
2. **失败也会发 `compaction/end`（带 `error`），正好用来区分“要不要清”**——
   压缩失败意味着上下文没变，清了只会让下一次请求重新算一遍，纯亏；
3. `compaction/end` 的 data 形状稳定，不依赖消息内容。

**决策**：

1. 新模块 `lib/host/compaction-hook.js`：监听 `ctx.on('session/event', …)`（`{ global: true }`），
   只处理 `compaction/end` 且 `data.error` 不存在的情况，调
   `runtime.clean({ confirm: true, trigger: 'compact' })`。
2. **1.5 秒合并窗口**（`compactDebounceMs`）：一次手动压缩可能连续收尾多个 span，
   或者用户连着压两次，没必要每次都走一遍探测 + 闸门。
3. 配置开关 `releaseOnCompact`（默认 `true`），关掉就完全不监听。
4. 卸载时摘监听 + 清未执行的定时器；`clean` 抛错只进 `diagnostics`，不外抛。
5. UI 无需改动：D32 的提示按 `trigger` 取文案，加一句 `toast.trigger.compact` 即可。

**代价与已知边界**：

- 依赖 `compaction/end` 这个事件契约；宿主换实现要跟着改（失败判据是 `data.error`）。
- 钩子只覆盖“成功压缩”；如果宿主某天改成成功也写 `error: null`，判据仍成立（falsy）。
- `cleaner.js`（日志固化流水线）仍然没有接线，那是另一条产品线，不在本次范围。

## T11. 非 macOS 尚未做过真机显存断言

采样器补齐后，Windows/Linux 的解析逻辑有单元测试覆盖，但**没有在真机上验证过“删除会话 -> 显存真的掉下来”**。V2/V2b 在非 macOS 上 skip，这是目前唯一跑过真实下降断言的平台。

发布说明里不许把 `proc-rss` / `win-rss` 写成“已验证跨平台释放”——它们只是“有了采样口径”。要摘掉这条 T11，需要：Windows 或 Linux 真机 + 至少一个本地引擎实例，跑一遍 `cleanAndVerify` 并留下 delta 证据。
