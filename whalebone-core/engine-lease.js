/**
 * 引擎租约登记表。
 *
 * 铁律：归属必须在**会话建立时**登记，删除时只校验、不推断。
 * 没有 engine_ref 的会话一律视为 unknown —— 这是 v7 的安全阀地基。
 */
import fs from 'node:fs';
import path from 'node:path';

const nowDefault = () => Date.now();
const empty = () => ({ version: 1, leases: {} });

const REQUIRED_FIELDS = ['provider', 'endpoint', 'modelId', 'spawnedBy'];

/** 只做形状校验，不猜语义。 */
export function validateEngineRef(ref) {
  if (!ref || typeof ref !== 'object') return { ok: false, code: 'ref_missing', missing: REQUIRED_FIELDS };
  const missing = REQUIRED_FIELDS.filter((k) => typeof ref[k] !== 'string' || ref[k].trim() === '');
  if (missing.length) return { ok: false, code: 'ref_incomplete', missing };
  if (ref.slotId !== undefined && typeof ref.slotId !== 'number' && typeof ref.slotId !== 'string') {
    return { ok: false, code: 'ref_bad_slot', missing: ['slotId'] };
  }
  if (ref.pid !== undefined && !Number.isInteger(ref.pid)) {
    return { ok: false, code: 'ref_bad_pid', missing: ['pid'] };
  }
  return { ok: true, code: 'ok', missing: [] };
}

export class LeaseRegistry {
  constructor({ file = null, defaultTtlMs = 6 * 3600_000, now = nowDefault } = {}) {
    this.file = file;
    this.ttl = defaultTtlMs;
    this.now = now;
    this.data = file && fs.existsSync(file) ? readJson(file) : empty();
  }

  /** 会话建立时调用。形状不合法直接拒绝登记（宁可 unknown，也不留半截租约）。 */
  register(sessionId, ref) {
    const v = validateEngineRef(ref);
    if (!v.ok) return { ok: false, code: v.code, missing: v.missing };
    const t = this.now();
    this.data.leases[sessionId] = {
      sessionId,
      ref: {
        provider: ref.provider,
        endpoint: ref.endpoint,
        modelId: ref.modelId,
        slotId: ref.slotId,
        pid: ref.pid,
        pidPath: ref.pidPath,
        spawnedBy: ref.spawnedBy,
      },
      state: 'active',
      createdAt: t,
      renewedAt: t,
      ttlMs: Number.isFinite(ref.ttlMs) ? ref.ttlMs : this.ttl,
    };
    this.#flush();
    return { ok: true, code: 'registered', lease: this.get(sessionId) };
  }

  renew(sessionId, ttlMs) {
    const l = this.data.leases[sessionId];
    if (!l || l.state !== 'active') return { ok: false, code: 'no_active_lease' };
    l.renewedAt = this.now();
    if (Number.isFinite(ttlMs)) l.ttlMs = ttlMs;
    this.#flush();
    return { ok: true, code: 'renewed' };
  }

  /** 释放=标记，不删除记录：审计需要看到"曾经租过什么"。 */
  release(sessionId, reason = 'session_deleted') {
    const l = this.data.leases[sessionId];
    if (!l) return { ok: false, code: 'no_lease' };
    if (l.state === 'released') return { ok: true, code: 'already_released' };
    l.state = 'released';
    l.releasedAt = this.now();
    l.releaseReason = reason;
    this.#flush();
    return { ok: true, code: 'released' };
  }

  get(sessionId) {
    const l = this.data.leases[sessionId];
    if (!l || l.state !== 'active') return null;
    return { ...l, ref: { ...l.ref } };
  }

  list() {
    return Object.values(this.data.leases)
      .filter((l) => l.state === 'active')
      .map((l) => ({ ...l, ref: { ...l.ref } }));
  }

  #flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

function readJson(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d || typeof d !== 'object' || !d.leases) return empty();
    return d;
  } catch {
    return empty();
  }
}

/**
 * 旧会话迁移方案（**不自动补登记**）。
 * 没有 engine_ref 的历史会话，一律 unknown，只标记、不猜测。
 */
export function planLegacyMigration(sessions = []) {
  return sessions.map((s) => ({
    sessionId: s.sessionId ?? s.id,
    action: s.engineRef ? 'keep' : 'mark_unknown',
    reason: s.engineRef ? 'has_engine_ref' : 'no_engine_ref',
    cleanupAllowed: false,
  }));
}
