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
4. 跑 `node --test` 确认 91 项通过

不实现 `probeEngine()` 也能装——代价是永远 `skip_unknown`，什么都不清理。

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
node --test               # 全部：91 项，89 pass / 2 skip
```

V1–V6 日志流水线，V7–V11 引擎释放与工作区记忆，S 系列压缩接缝，I 系列闸门不变量。

更多取舍见 [`docs/DECISIONS.md`](docs/DECISIONS.md)，压缩挂载点见 [`docs/whalebone.md`](docs/whalebone.md)。

MIT © ccr-wer
