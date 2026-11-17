/**
 * 孤儿工作区扫描。
 *
 * 只回答"哪些工作区看起来已经没有活会话、且记忆闲置够久"，
 * **不做任何变更**。归档必须由调用方显式确认后单独执行。
 *
 * 三项同时满足才算候选：
 *   1) 该工作区活会话数 = 0（索引已正确回收，不是"只增不删"的假象）
 *   2) 工作区记忆文件存在
 *   3) 最后一次活动距今 >= minIdleDays
 */
const DAY = 86_400_000;

export function findOrphanWorkspaces({
  registry,
  memoryStore,
  minIdleDays = 30,
  now = () => Date.now(),
} = {}) {
  if (!registry || !memoryStore) return [];
  const t = now();
  const out = [];

  for (const ws of registry.list()) {
    const live = registry.liveSessions(ws.workspaceId);
    if (live.length > 0) continue;
    if (!memoryStore.exists(ws.workspaceId)) continue;

    const last = registry.lastActivityAt(ws.workspaceId);
    if (!Number.isFinite(last)) continue;
    const idleMs = t - last;
    if (idleMs < minIdleDays * DAY) continue;

    out.push({
      workspaceId: ws.workspaceId,
      liveSessions: 0,
      sessionCount: ws.sessionCount,
      lastActivityAt: last,
      idleDays: Math.floor(idleMs / DAY),
      memoryPath: memoryStore.fileFor(ws.workspaceId),
      bytes: memoryStore.sizeOf(ws.workspaceId),
    });
  }

  return out;
}
