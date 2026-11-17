/**
 * 归属判定：唯一安全阀。纯函数，无 IO。
 *
 * 三要素同时命中才算 owned：
 *   1) 会话在建立时登记过 engine_ref（现取租约）
 *   2) 探测快照能对上 modelId / slotId
 *   3) pid 可执行路径在允许清单内，或 spawnedBy === 'dsh'
 * 任一项缺失或矛盾 -> unknown（只写审计、不清理）。
 * 禁止"同名模型即同一实例"这类启发式。
 */
import path from 'node:path';

export const VERDICT = Object.freeze({
  OWNED: 'owned',
  FOREIGN: 'foreign',
  UNKNOWN: 'unknown',
});

const REASON = {
  OK: 'ok',
  NO_LEASE: 'no_lease',
  LEASE_INCOMPLETE: 'lease_incomplete',
  ENGINE_ABSENT: 'engine_absent',
  PROBE_UNKNOWN: 'probe_unknown',
  MODEL_MISMATCH: 'model_mismatch',
  SLOT_MISMATCH: 'slot_mismatch',
  PID_NOT_ALLOWED: 'pid_not_allowed',
  SPAWN_UNTRUSTED: 'spawn_untrusted',
};

const out = (verdict, code, detail = {}) => ({ verdict, code, ...detail });

function pidAllowed(lease, allowedPidPaths) {
  if (lease.spawnedBy === 'dsh') return true; // 三要素 3 的最强形式
  const p = lease.pidPath;
  if (!p || !Array.isArray(allowedPidPaths) || allowedPidPaths.length === 0) return false;
  const target = path.resolve(String(p));
  return allowedPidPaths.some((root) => {
    const r = path.resolve(String(root));
    const rel = path.relative(r, target);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/**
 * @param {object} args
 * @param {object|null} args.lease       租约（null = 会话从未登记）
 * @param {object|null} args.snapshot    探测快照
 * @param {string} [args.probeState]     probe 的枚举，用于 absent/unknown 快速归约
 * @param {string[]} [args.allowedPidPaths]
 */
export function decide({ lease, snapshot, probeState, allowedPidPaths = [] } = {}) {
  if (probeState === 'unknown') return out(VERDICT.UNKNOWN, REASON.PROBE_UNKNOWN);
  if (probeState === 'absent') return out(VERDICT.FOREIGN, REASON.ENGINE_ABSENT);

  // 要素 1：必须登记过
  if (!lease) return out(VERDICT.FOREIGN, REASON.NO_LEASE);
  if (!lease.ref || !lease.ref.provider || !lease.ref.endpoint || !lease.ref.modelId) {
    return out(VERDICT.UNKNOWN, REASON.LEASE_INCOMPLETE);
  }

  // 要素 2：现场必须对得上
  const models = Array.isArray(snapshot?.models) ? snapshot.models : [];
  const slots = Array.isArray(snapshot?.slots) ? snapshot.slots : [];
  if (models.length === 0 && slots.length === 0) {
    return out(VERDICT.FOREIGN, REASON.ENGINE_ABSENT);
  }

  const modelHit =
    models.some((m) => m.modelId === lease.ref.modelId) ||
    slots.some((s) => s.modelId && s.modelId === lease.ref.modelId);
  if (!modelHit) return out(VERDICT.UNKNOWN, REASON.MODEL_MISMATCH);

  if (lease.ref.slotId !== undefined && lease.ref.slotId !== null) {
    const hit = slots.some((s) => String(s.slotId) === String(lease.ref.slotId));
    if (!hit) return out(VERDICT.UNKNOWN, REASON.SLOT_MISMATCH);
  }

  // 要素 3：进程归属
  if (!pidAllowed(lease.ref, allowedPidPaths)) {
    return lease.ref.spawnedBy === 'dsh'
      ? out(VERDICT.UNKNOWN, REASON.PID_NOT_ALLOWED)
      : out(VERDICT.UNKNOWN, REASON.SPAWN_UNTRUSTED);
  }

  return out(VERDICT.OWNED, REASON.OK, {
    modelId: lease.ref.modelId,
    slotId: lease.ref.slotId ?? null,
  });
}

export const OWNERSHIP_REASON = REASON;
