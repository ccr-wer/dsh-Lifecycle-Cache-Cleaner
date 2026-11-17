# lifecycle-cache-cleaner

DSH 本地 Agent 的 KV cache 生命周期管理（单包）。

四件事：

- **入口闸门**：单条工具输出过大 / 插入后水位越界 → 落盘，不调模型。
- **工作日志固化**：摘要 → L5 校验 → L6 原子提交，任何一步失败都回滚。
- **统一清理闸门**：所有清理路径共用一条规则——**探测不到本地部署就不动引擎**。
- **工作区记忆**：删光会话不删记忆；孤儿只标记；归档需确认且可撤销。

## 一条最重要的规则

```
探测结果 absent  -> 不清理（只整理日志）
探测结果 unknown -> 不清理（fail-closed）
探测结果 present + 归属成立 -> 才允许动引擎
```

会话删除走 `ownership: 'lease'`（必须有租约且三要素匹配）；
本包自建引擎的路径走 `ownership: 'adapter-exclusive'`（适配器即所有者）。
两条都必经 `lib/core/release-gate.js`，除闸门以外没有任何代码调用 `destroyEngine()`。

**适配器不实现 `probeEngine()` = 永远不清理**。这是有意的：拿不到证据就不许删。

## 结构

| 路径 | 职责 |
|---|---|
| `cleaner.js` | 主循环：tick / rebuild / onCompacted / releaseCache |
| `session-deleter.js` | 会话删除编排（`DELETE_STATE` 九态） |
| `lib/core/release-gate.js` | 统一清理闸门（探测 + 放行判定） |
| `lib/core/ownership.js` | 归属判定（唯一安全阀，纯函数） |
| `lib/core/engine-probe.js` | 只读探测（零写操作） |
| `lib/core/vram-cleaner.js` | 分级释放 + 采样验证（禁用 `top`） |
| `lib/core/workspace-*.js` `orphan-scan.js` | 工作区索引 / 记忆 / 孤儿扫描 |
| `adapters/` | 日志流水线适配器；`adapters/engine/` 为引擎适配器 |

## 测试

```bash
node --test               # 全部：91 项，89 pass / 2 skip
```

V1–V6 日志流水线，V7–V11 引擎释放与工作区记忆，S 系列压缩接缝，I 系列闸门不变量。

更多取舍见 [`docs/DECISIONS.md`](docs/DECISIONS.md)，压缩挂载点见 [`docs/whalebone.md`](docs/whalebone.md)。
