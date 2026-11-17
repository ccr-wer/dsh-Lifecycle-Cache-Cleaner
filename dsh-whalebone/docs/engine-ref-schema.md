# `engine_ref` schema 与旧会话迁移

## 1. 结构

```json
{
  "provider":  "ollama",
  "endpoint":  "http://127.0.0.1:11434",
  "modelId":   "qwen3:32b",
  "slotId":    0,
  "pid":       4242,
  "pidPath":   "/opt/homebrew/bin/ollama",
  "spawnedBy": "dsh",
  "ttlMs":     21600000
}
```

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `provider` | ✅ | string | `ollama` / `llamacpp` / `dsh` / `mlx` / `vllm` |
| `endpoint` | ✅ | string | 形如 `http://127.0.0.1:11434`，用于探测路由 |
| `modelId` | ✅ | string | 引擎侧标识。Ollama 用 `name`（含 tag），llama.cpp 用启动时模型名 |
| `spawnedBy` | ✅ | string | `dsh` \| `user` \| `host`。**只有 `dsh` 允许进程级释放** |
| `slotId` | ⬜ | number \| string | `--parallel N` 下的槽位号；Ollama 无此概念 |
| `pid` | ⬜ | integer | 持有进程；进程级释放需要 |
| `pidPath` | ⬜ | string | 可执行文件路径，用于白名单校验 |
| `ttlMs` | ⬜ | number | 默认 6h，超期视为失效租约 |

### 校验规则

`validateEngineRef()` 只做形状校验，**不猜语义**：

- 缺任一必填字段 → `ref_incomplete`，**拒绝登记**（宁可 unknown，也不留半截租约）
- `slotId` 非 number/string → `ref_bad_slot`
- `pid` 非整数 → `ref_bad_pid`

### 存储

`LeaseRegistry` 落盘为一个 JSON：

```json
{
  "version": 1,
  "leases": {
    "<sessionId>": {
      "sessionId": "...",
      "ref": { "...": "见上" },
      "state": "active",
      "createdAt": 1730000000000,
      "renewedAt": 1730000000000,
      "ttlMs": 21600000
    }
  }
}
```

释放是**标记**（`state: "released"` + `releasedAt` + `releaseReason`），不删记录——
审计需要看到"曾经租过什么"。

---

## 2. 登记时机（唯一入口）

```js
// 会话建立时，宿主必须显式登记
deleter.registerSession(sessionId, {
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  modelId:  'qwen3:32b',
  spawnedBy: 'dsh',
  pid: proc.pid,
  pidPath: proc.spawnfile,
});
```

**没有这一步 = 该会话永远不可清理。** 这是设计意图，不是缺陷。

---

## 3. 旧会话迁移

历史会话没有 `engine_ref`。方案是**只标记、不回填**：

```js
import { planLegacyMigration } from '../whalebone-core/engine-lease.js';

const plan = planLegacyMigration(sessions);
// [
//   { sessionId: 'old-1', action: 'mark_unknown', reason: 'no_engine_ref', cleanupAllowed: false },
//   { sessionId: 'new-1', action: 'keep',         reason: 'has_engine_ref', cleanupAllowed: false }
// ]
```

### 步骤

1. 遍历会话元数据，产出迁移清单（纯函数，不写库）。
2. UI 对这些会话的删除确认框：清理项显示为**禁用态**，原因 `无法确认该引擎归属本会话，已跳过释放`。
3. 删除时正常走 `decide()`：`lease === null` → `foreign(no_lease)` → `skip_clean`。
4. **不写租约、不推断、不回溯匹配**。下一次同类会话由新版本在建立时登记。

### 为什么不做回溯

可用的"线索"全是启发式：同名模型、同端口、启动时间接近、`createdAt < session.endAt`。
任意一条在共享 Ollama 场景下都会误伤他人。误伤一次 = 别人的会话被卸载，代价远大于
"这个旧会话多占了一会儿显存"。

### `cleanupAllowed: false` 的含义

即使用户在 UI 上手动勾选，旧会话也**不会**被清理——`decide()` 第一关就拦住。
这个字段是给审计和 UI 用的显式说明，不是可覆盖的开关。
