/**
 * DSH 桌面端：删除会话时的本地引擎资源释放编排。
 *
 * 与压缩重建路径**完全分离**：这里只做"删除 + 可能的显存释放"，
 * 不参与 summarize/rebuild，也不等它的锁。
 *
 * 铁律：
 *  - 归属只校验、不推断；没有租约 = 不动引擎。
 *  - 清理失败不回滚、不阻塞会话删除。
 *  - 处于 tearing_down/rebuilding 时直接 skipped_busy，不排队。
 *  - 同一会话并发删除幂等。
 */
import { decide, VERDICT } from '../whalebone-core/ownership.js';
import { cleanAndVerify, CLEAN_LEVELS, CLEAN_STATUS } from '../whalebone-core/vram-cleaner.js';
import { findOrphanWorkspaces } from '../whalebone-core/orphan-scan.js';

export const DELETE_STATE = Object.freeze({
  IDLE: 'idle',
  PROBING: 'probing',
  OWNERSHIP_CHECK: 'ownership_check',
  CLEANING: 'cleaning',
  VERIFIED: 'verified',
  SKIP_CLEAN: 'skip_clean',
  CLEANUP_FAILED: 'cleanup_failed',
  SKIPPED_BUSY: 'skipped_busy',
});

export class SessionDeleter {
  /**
   * @param {object} args
   * @param {import('../whalebone-core/engine-lease.js').LeaseRegistry} args.leases
   * @param {import('../whalebone-core/engine-probe.js').EngineProbe} args.probe
   * @param {object[]} [args.adapters]  引擎适配器列表
   * @param {object} [args.transport]   只读/写都走它；core 不直接 fetch
   * @param {{deleteSession:Function}} args.host
   * @param {(sessionId:string)=>boolean} [args.isBusy] 压缩重建是否占用中
   * @param {object} [args.workspaceRegistry] 工作区→会话索引（可选；缺省则工作区机制全程不介入）
   * @param {object} [args.workspaceMemory]   工作区记忆存储（可选）
   */
  constructor({
    leases,
    probe,
    adapters = [],
    transport,
    host,
    isBusy = () => false,
    audit = () => {},
    now = () => Date.now(),
    config = {},
    workspaceRegistry = null,
    workspaceMemory = null,
  }) {
    this.leases = leases;
    this.probe = probe;
    this.adapters = adapters;
    this.transport = transport;
    this.host = host;
    this.isBusy = isBusy;
    this.audit = audit;
    this.now = now;
    this.workspaceRegistry = workspaceRegistry;
    this.workspaceMemory = workspaceMemory;
    this.cfg = {
      localEngine: 'auto', // auto | on | off
      probeTimeoutMs: 300,
      allowedPidPaths: [],
      orphanMinIdleDays: 30, // 闲置多久才算孤儿候选（仅用于标记，不用于删除）
      ...config,
    };
    this.inflight = new Map();
  }

  /**
   * 会话建立时登记归属。没有这一步，删除时一律 unknown。
   * 传了 workspaceId 才进工作区索引——索引是"还有没有活会话"的唯一依据。
   */
  registerSession(sessionId, engineRef, { workspaceId = null } = {}) {
    if (workspaceId && this.workspaceRegistry) {
      this.workspaceRegistry.noteSession(workspaceId, sessionId);
    }
    return this.leases.register(sessionId, engineRef);
  }

  async delete(sessionId, options = {}) {
    const running = this.inflight.get(sessionId);
    if (running) return running; // 并发删除同一会话：复用同一个 Promise

    const p = this.#run(sessionId, options).finally(() => this.inflight.delete(sessionId));
    this.inflight.set(sessionId, p);
    return p;
  }

  async #run(sessionId, options) {
    const trail = [];
    const emit = (state, extra = {}) => {
      const e = { sessionId, state, at: this.now(), ...extra };
      trail.push(e);
      this.audit(e);
      return e;
    };
    const finish = async (result) => {
      // 无论清理成败：释放租约 + 删会话。绝不因为引擎而卡住删除。
      this.leases.release(sessionId, result.state);
      try {
        await this.host.deleteSession(sessionId);
      } catch (err) {
        emit('delete_failed', { message: err.message });
        return { ...result, deleted: false, trail };
      }
      // 只更新索引。删除流程**绝不**碰工作区记忆——删会话不等于遗忘项目约定。
      try {
        this.workspaceRegistry?.markDeleted(sessionId);
      } catch (err) {
        emit('index_update_failed', { message: err.message });
      }
      return { ...result, deleted: true, trail };
    };

    emit(DELETE_STATE.IDLE);

    if (this.cfg.localEngine === 'off') {
      emit(DELETE_STATE.SKIP_CLEAN, { code: 'local_engine_off' });
      return finish({ state: DELETE_STATE.SKIP_CLEAN, cleaned: false, code: 'local_engine_off' });
    }

    // 与压缩重建互斥：不排队等锁
    if (this.isBusy(sessionId)) {
      emit(DELETE_STATE.SKIPPED_BUSY, { code: 'compression_in_progress' });
      return finish({ state: DELETE_STATE.SKIPPED_BUSY, cleaned: false, code: 'compression_in_progress' });
    }

    const lease = this.leases.get(sessionId);

    if (!options.releaseVram) {
      emit(DELETE_STATE.SKIP_CLEAN, { code: 'release_not_requested' });
      return finish({ state: DELETE_STATE.SKIP_CLEAN, cleaned: false, code: 'release_not_requested' });
    }

    // ---- 探测（不阻塞风险由 probe 的短超时兜住）
    emit(DELETE_STATE.PROBING);
    const probeResult = await this.#probeFor(lease);

    emit(DELETE_STATE.OWNERSHIP_CHECK, { probeState: probeResult.state });
    const verdict = decide({
      lease,
      snapshot: probeResult.snapshot,
      probeState: probeResult.state,
      allowedPidPaths: this.cfg.allowedPidPaths,
    });

    if (verdict.verdict !== VERDICT.OWNED) {
      emit(DELETE_STATE.SKIP_CLEAN, { verdict: verdict.verdict, code: verdict.code });
      return finish({
        state: DELETE_STATE.SKIP_CLEAN,
        cleaned: false,
        code: verdict.code,
        verdict: verdict.verdict,
        probeState: probeResult.state,
      });
    }

    // ---- 清理（任何异常都不外抛）
    emit(DELETE_STATE.CLEANING, { level: options.level || CLEAN_LEVELS.SLOT });
    const adapter = this.adapters.find((a) => a.provider === lease.ref.provider);
    let outcome;
    try {
      outcome = await cleanAndVerify({
        level: options.level || CLEAN_LEVELS.SLOT,
        lease,
        adapter,
        snapshot: probeResult.snapshot,
        sampler: options.sampler || null,
        confirmed: options.confirmModel === true,
        timeoutMs: options.verifyTimeoutMs ?? 1500,
        intervalMs: options.verifyIntervalMs ?? 100,
        minDropBytes: options.minDropBytes ?? null,
        audit: this.audit,
      });
    } catch (err) {
      emit(DELETE_STATE.CLEANUP_FAILED, { message: err.message });
      return finish({ state: DELETE_STATE.CLEANUP_FAILED, cleaned: false, code: 'clean_threw' });
    }

    if (outcome.status === CLEAN_STATUS.BLOCKED) {
      emit(DELETE_STATE.SKIP_CLEAN, { code: outcome.code });
      return finish({ state: DELETE_STATE.SKIP_CLEAN, cleaned: false, code: outcome.code });
    }
    if (outcome.status === CLEAN_STATUS.FAILED) {
      emit(DELETE_STATE.CLEANUP_FAILED, { code: outcome.code });
      return finish({ state: DELETE_STATE.CLEANUP_FAILED, cleaned: false, code: outcome.code });
    }

    // released_verified / release_requested / unverifiable 都算"终端成功路径"，
    // 差异放在 releaseStatus 里，不伪装成 verified。
    emit(DELETE_STATE.VERIFIED, { releaseStatus: outcome.status, verified: outcome.verified });
    return finish({
      state: DELETE_STATE.VERIFIED,
      cleaned: true,
      code: outcome.code,
      releaseStatus: outcome.status,
      verified: outcome.verified,
      deltaBytes: outcome.deltaBytes,
    });
  }

  /* ------------------------------------------- 工作区记忆：只标记、归档需显式确认 */

  /** 只列候选，不改动任何文件。活会话数 >0、记忆不存在、闲置不足，都不算。 */
  scanOrphans({ minIdleDays = this.cfg.orphanMinIdleDays, now = this.now } = {}) {
    if (!this.workspaceRegistry || !this.workspaceMemory) return [];
    return findOrphanWorkspaces({
      registry: this.workspaceRegistry,
      memoryStore: this.workspaceMemory,
      minIdleDays,
      now,
    });
  }

  /** 归档 = 移动。没有 confirmed:true 直接拒。这里**没有** delete 接口，故意不给。 */
  archiveWorkspaceMemory(workspaceId, { confirmed = false } = {}) {
    if (!this.workspaceMemory) return { ok: false, code: 'memory_store_unavailable' };
    return this.workspaceMemory.archive(workspaceId, { confirmed });
  }

  restoreWorkspaceMemory(archivePath, workspaceId, { confirmed = false } = {}) {
    if (!this.workspaceMemory) return { ok: false, code: 'memory_store_unavailable' };
    return this.workspaceMemory.restore(archivePath, workspaceId, { confirmed });
  }

  async #probeFor(lease) {
    const candidates = lease
      ? this.adapters.filter((a) => a.provider === lease.ref.provider)
      : this.adapters;
    if (candidates.length === 0) {
      return { state: 'unknown', snapshot: null, code: 'no_adapter' };
    }
    let first = null;
    for (const adapter of candidates) {
      const r = await this.probe.probe({ adapter, lease, transport: this.transport });
      if (!first) first = r;
      if (r.state !== 'absent') return r; // 有东西就先看它，别把 absent 当结论
    }
    return first;
  }

  /**
   * 删除确认框的渲染描述。
   * absent 不渲染；foreign/unknown 渲染为禁用态 + 原因（不得静默隐藏）。
   */
  describeCleanupOption({ probeResult, lease, estimateBytes = null } = {}) {
    const fmtGb = (b) => (b ? `${(b / 1024 ** 3).toFixed(1)} GB` : null);
    if (!probeResult || probeResult.state === 'absent') {
      return { render: false, reason: 'engine_absent' };
    }
    const v = decide({
      lease,
      snapshot: probeResult.snapshot,
      probeState: probeResult.state,
      allowedPidPaths: this.cfg.allowedPidPaths,
    });
    if (v.verdict === VERDICT.OWNED) {
      const size = estimateBytes ?? probeResult.snapshot?.models?.[0]?.sizeBytes ?? null;
      return {
        render: true,
        enabled: true,
        level: CLEAN_LEVELS.SLOT,
        label: `同时释放本地模型显存（检测到 ${probeResult.snapshot?.models?.length ?? 1} 个 DSH 管理的引擎${
          size ? `，约 ${fmtGb(size)}` : ''
        }）`,
        reason: 'owned',
      };
    }
    return {
      render: true,
      enabled: false,
      reason: v.code,
      label:
        v.verdict === VERDICT.FOREIGN
          ? '本地模型正被其它程序使用，已跳过释放'
          : '无法确认该引擎归属本会话，已跳过释放',
      verdict: v.verdict,
    };
  }
}

export { CLEAN_LEVELS, CLEAN_STATUS, VERDICT };
