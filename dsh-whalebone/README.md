# dsh-whalebone

DSH 桌面端「删除会话时释放本地模型显存」的增量实现。

- `session-deleter.js` —— 删除编排（`DELETE_STATE` 九态）
- `lib/core/` —— 宿主无关内核（禁止 `require('dsh')`、禁止直接 `fetch`）
- `adapters/` —— ollama / llama.cpp / dsh 适配器
- `test/` —— V7–V11

单包结构：`lib/core/` 是包内目录，不是独立 npm 包，因此不存在跨包引用。

```bash
cd dsh-whalebone && npm test                    # V7–V11
cd .. && node --test                            # 仓库根：V1–V6（既有，未改动）
```

## 一句话立场

**归属必须在会话建立时登记，删除时只校验、不推断。没有 `engine_ref` 就一律 `unknown`，只删会话、不动引擎。**

---

## 默认不清理：这是特性，不是 bug

几个"看起来该清但不清"的行为，都是有意的：

### 1. 共享 Ollama 无法判定 per-client 归属

Ollama 是**服务级共享**的。`GET /api/ps` 只告诉你"本机现在加载了哪些模型、占了多少显存"，
**不告诉你这个模型被哪个客户端占用**。凭"本机有模型"就发 `keep_alive:0`，会把同一台机器上
别人的会话一起打掉。

所以：**只有在会话建立时登记过 `engine_ref`、且三要素全部对得上时，才允许动引擎。**
否则一律 skip，并记审计。

### 2. llama.cpp 删会话 ≠ 释放 slot

`--parallel N` 把总上下文等分成 N 个 slot，**slot 由 LRU 复用、不可借用**。
删掉某个会话，只是这个会话不再使用它，slot 仍然留在进程里给下一个会话用。

更关键的是：`POST /slots/{id}?action=erase` 走的是 `seq_rm` 语义 —— **只清指针，RSS 不降**。
KV buffer 是 `n_ctx` 预分配的固定块，清空槽位不会还给系统。

本实现因此把 llama.cpp 的 `slot` 档标记为 `unverifiable`，理由码
`slot_erase_does_not_free_rss`，**不会**显示成"已释放"。真要归还内存只有两条路：
`process` 档（结束 dsh 自己派生的进程），或缩小 `n_ctx` 重建实例。

### 3. MLX 统一内存不做显存断言

Apple Silicon 是统一内存，没有独立的"显存"。`footprint` 只能看到进程物理占用，
无法把 KV 和权重分开。因此在 MLX 上验证结果一律是 `unverifiable`，
**不产出"释放了 X GB"这种数字**，避免假精确。

### 4. 释放有延迟

`keep_alive:0` 和进程退出都不是同步完成的。验证采用**轮询 + 超时**（默认 1500ms / 100ms）：

- 观察到下降 → `released_verified`
- 超时仍未下降 → `release_requested`，UI 文案是「**已请求释放**」，不是「已释放」

`release_requested` 是**正常终态**，不是失败。它不阻塞会话删除，也不回滚。

### 5. 旧会话没有 `engine_ref` → 一律 unknown

历史会话在建立时没有登记归属。**不做任何回溯推断**（不同名模型、不看 pid、不看启动时间）。
这些会话删除时判定为 `unknown`，UI 显示禁用态 + 原因，agent 不动引擎。

---

## 归属判定的三要素

`lib/core/ownership.js` 是纯函数，也是唯一安全阀。三要素**同时**命中才算 `owned`：

| # | 要素 | 缺失/矛盾时的结论 |
|---|---|---|
| 1 | 会话在建立时登记过 `engine_ref`（`provider/endpoint/modelId/spawnedBy` 齐全） | 无 → `foreign(no_lease)`；不全 → `unknown(lease_incomplete)` |
| 2 | 探测快照能对上 `modelId`（有 `slotId` 时还要对得上 slot） | 对不上 → `unknown(model_mismatch / slot_mismatch)` |
| 3 | `spawnedBy === 'dsh'`，或 pid 可执行路径在白名单内 | 都不是 → `unknown(spawn_untrusted / pid_not_allowed)` |

**明令禁止**的启发式：同名模型即同一实例、端口相同即同一实例、启动时间接近即同一实例。

---

## 探测层

返回枚举，不返回布尔：

```
absent | foreign | owned_idle | owned_busy | unknown
```

- 异步 + 短超时（默认 **300ms**），**绝不阻塞删除流程**；超时即 `unknown`。
- TTL 缓存（默认 **30s**），`absent` 命中直接短路，不再打引擎。
- **只走只读端点**：`GET /api/ps`、`GET /slots`。探测路径上的写操作会被
  `readOnlyTransport` 直接抛错，归约为 `unknown`（V7 断言零写操作）。
- 任何异常 / 超时 / 字段缺失 → `unknown`，**不外抛**。
- `unknown` **不进缓存**：下次删除必须重新探测，避免一次抖动永久失效。
- `localEngine: auto | on | off`，`off` 时整条链路不加载。

---

## 清理分级

| 档位 | 适用 | 前提 | 结果语义 |
|---|---|---|---|
| `slot`（默认） | llama.cpp / dsh | 归属 owned | 多半是 `unverifiable`（只清指针） |
| `model` | Ollama | **必须显式勾选** `confirmModel` | `keep_alive:0`，会波及同实例其它客户端 |
| `process` | 仅 dsh 派生 | `spawnedBy === 'dsh'`，单独确认 | `destroyEngine()` 是**进程级**语义 |

`destroyEngine()` 从来不是 slot 级。多 slot 场景下调用它意味着所有会话一起消失，
所以调用前必须确认归属。

### UI 契约

- 删除确认框：`同时释放本地模型显存（检测到 N 个 DSH 管理的引擎，约 X GB）`
- `absent` → **不渲染**这一项
- `foreign` / `unknown` → 渲染为**禁用态 + 原因**，不得静默隐藏
- `release_requested` → 提示「已请求释放」，不显示具体释放量

---

## 状态机

```
idle → probing → ownership_check → cleaning → verified
         ↓           ↓                ↓
      skip_clean  skip_clean    cleanup_failed
```

另有 `skipped_busy`：压缩重建处于 `tearing_down` / `rebuilding` 时**直接跳过**，不排队等锁。

- 清理失败**不回滚、不阻塞**会话删除，仅落审计 + 非阻塞提示。
- 同一会话并发删除幂等（复用同一个 inflight Promise）。
- `verified` 的三种收敛：`released_verified` / `release_requested` / `unverifiable`，
  差异放在 `releaseStatus` 字段里，**不把"已请求"伪装成"已验证"**。

---

## engine_ref 与旧会话迁移

见 [`docs/engine-ref-schema.md`](docs/engine-ref-schema.md)。
登记发生在**会话建立时**（`SessionDeleter.registerSession()`），删除时只读。

---

## 实现取舍与 TODO

见 [`docs/DECISIONS.md`](docs/DECISIONS.md)。

---

## 测试

| 用例 | 覆盖 | 断言要点 |
|---|---|---|
| **V7** | 假归属 | 同名模型无租约 → `foreign`；模型不符 → `unknown`；`spawnedBy` 不可信 → `unknown`；**全部零写操作**；UI 禁用态 |
| **V8** | 假释放 | 轮询检测真实下降才 `verified`；不降 → `release_requested`；llama.cpp slot → `unverifiable`；采样器拒绝 `top` |
| **V9** | 探测失败 | 抛错 / 非法 JSON / 超时 / 缺字段 → `unknown`，不清理，删除照常完成；`unknown` 不缓存 |
| **V10** | 并发 | 与重建互斥 → `skipped_busy` 不排队；并发删除幂等；清理失败不回滚；租约必释放 |
| **V11** | 工作区记忆 | 删光会话**不删**记忆；扫描零写；闲置未达标不报；归档需 `confirmed`；归档是移动可 restore；索引残留只漏报不误报 |

`node --test`，34 项全绿。V1–V6（`lifecycle-cache-cleaner`）保持 35 pass / 2 skip，断言未改动。

---

## 工作区记忆的生命周期

> 结论先说：**没有**"工作区会话删光就删工作区日志"这种机制，也不应该有。

记忆是资产，不是会话的附属物。删除会话 ≠ 用户想遗忘项目约定；而且"零会话"是个瞬时状态（关掉所有会话准备重开也会出现）。

本插件只提供三段，每一段都刻意不通向"自动删除"：

```
① 索引   WorkspaceRegistry     会话建立时 noteSession，删除成功后 markDeleted
② 标记   findOrphanWorkspaces  活会话=0 且 记忆存在 且 闲置≥N 天 -> 只返回候选
③ 归档   WorkspaceMemoryStore  必须 confirmed:true，rename 到 .archive/，可 restore
```

关键约束：

- `SessionDeleter.delete()` 成功删会话后**只更新索引**，不碰任何记忆文件（V11-1）。
- 扫描是纯读（V11-3），不会因为"扫过一次"就改变状态。
- 归档没有对应的 `delete()`，故意不给——想真正腾空间，由用户在归档目录里自己动手。
- 索引若出现残留 live 条目，结果只会**漏报**候选，不会凭空多出孤儿（V11-7）。宁可不动，也不误伤。
