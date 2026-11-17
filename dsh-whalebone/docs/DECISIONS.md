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
