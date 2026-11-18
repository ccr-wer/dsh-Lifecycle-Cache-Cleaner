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

/**
 * 路径归一。默认不做 IO（resolve + win32 下转小写）；
 * 调用方可以传 realpath 解决软链/junction 别名问题。
 *
 * Windows / macOS 文件系统大小写不敏感，Linux 敏感：不归一的话，同一个路径
 * 换个大小写写法就会被判成"不在允许目录内"，导致该清的不清。
 */
export function canonicalPath(p, { platform = process.platform, realpath = null } = {}) {
  const abs = path.resolve(String(p));
  let resolved = abs;
  if (typeof realpath === 'function') {
    try {
      const r = realpath(abs);
      if (r) resolved = String(r);
    } catch {
      // 路得不存在时保留 resolve 结果，不因归一失败而改变判定
    }
  }
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 预绑定平台/realpath 的归一器，供宿主层注入。 */
export function makeCanonicalizer({ platform = process.platform, realpath = null } = {}) {
  return (p) => canonicalPath(p, { platform, realpath });
}

const defaultCanonicalize = (p) => canonicalPath(p);

function pidAllowed(lease, allowedPidPaths, canonicalize) {
  if (lease.spawnedBy === 'dsh') return true; // 三要素 3 的最强形式
  const p = lease.pidPath;
  if (!p || !Array.isArray(allowedPidPaths) || allowedPidPaths.length === 0) return false;
  const target = canonicalize(p);
  return allowedPidPaths.some((root) => {
    const r = canonicalize(root);
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
 * @param {(p:string)=>string} [args.canonicalize] 路径归一函数（默认 resolve + win32 小写）
 */
export function decide({
  lease,
  snapshot,
  probeState,
  allowedPidPaths = [],
  canonicalize = defaultCanonicalize,
} = {}) {
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
  if (!pidAllowed(lease.ref, allowedPidPaths, canonicalize)) {
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
