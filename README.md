# lifecycle-cache-cleaner

DSH 本地 Agent 的 KV cache 生命周期管理（单包）。

四件事：

- **入口闸门**：单条工具输出过大 / 插入后水位越界 → 落盘，不调模型。
- **工作日志固化**：摘要 → L5 校验（一致性）→ L6 原子提交（失败即回滚）。
- **统一清理闸门**：所有清理路径共用一条规则——**探测不到本地部署就不动引擎**。
- **工作区记忆**：删光会话不删记忆；孤儿只标记；归档需确认且可撤销。

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

1. 把包放进 DSH 插件目录，或 `npm install <本仓库>`
2. 适配器至少实现 `probeEngine()` 与 `destroyEngine()`；前者返回
   `owned_idle | owned_busy | foreign | absent`，抛错即视为 `unknown`
3. 会话创建时登记 `engine_ref`（租约），删除时只校验、不推断
4. 跑 `node --test` 确认 108 项通过

不实现 `probeEngine()` 也能装——代价是永远 `skip_unknown`，什么都不清理。

## 跨平台

| 能力 | Windows | Linux | macOS |
|---|---|---|---|
| 溢出闸门 / 日志固化 / 状态机 | ✅ | ✅ | ✅ |
| 统一清理闸门（判定逻辑） | ✅ | ✅ | ✅ |
| 引擎释放（HTTP） | ✅ | ✅ | ✅ |
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
| `cleaner.js` | 主循环：tick / rebuild / onCompacted / releaseCache |
| `session-deleter.js` | 会话删除编排（`DELETE_STATE` 九态） |
| `lib/core/release-gate.js` | 统一清理闸门（探测 + 放行判定） |
| `lib/core/ownership.js` | 归属判定（唯一安全阀，纯函数） |
| `lib/core/engine-probe.js` | 只读探测（零写操作） |
| `lib/core/vram-cleaner.js` | 分级释放 + 采样验证（禁用 `top`） |
| `lib/core/workspace-registry.js` `workspace-memory.js` | 工作区索引 / 记忆（归档可撤销） |
| `lib/core/orphan-scan.js` | 孤儿扫描（只标记，不删除） |
| `adapters/` | 日志流水线适配器；`adapters/engine/` 为引擎适配器 |

## 测试

```bash
node --test               # 全部：108 项，106 pass / 2 skip
```

V1–V6 日志流水线，V7–V11 引擎释放与工作区记忆，S 系列压缩接缝，I 系列闸门不变量，X 系列跨平台采样/归一/重试，M 系列记忆归属与消重。

更多取舍见 [`docs/DECISIONS.md`](docs/DECISIONS.md)，压缩挂载点见 [`docs/whalebone.md`](docs/whalebone.md)。

MIT © ccr-wer
