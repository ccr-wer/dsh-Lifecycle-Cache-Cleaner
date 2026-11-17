/**
 * 主循环。宿主只需提供 adapter 的 6 个方法，其余逻辑全部在这里。
 *
 * 铁律：
 *  - 双闸门分开：overflow_guard（入口）与 rebuild_watermark（计划）不共享阈值变量。
 *  - 任何一步失败都滚回 rolled_back，绝不半提交。
 *  - destroyEngine() 是进程级语义；多 slot 时必须整体重建。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PHASES, StateStore, recoveryAction } from './state.js';
import { OverflowGuard, defaultCountTokens } from './overflow-guard.js';
import { appendRawTrace, readRawTraceTail, extractTraceSection } from './raw-trace.js';
import * as wl from './worklog.js';
import { probeAdapter, evaluateGate } from './lib/core/release-gate.js';

export const DEFAULTS = Object.freeze({
  // 计划性重建触发（不是安全阀）
  rebuildWatermark: 0.78,
  rebuildPeriodTurns: 15,
  // 入口闸门（安全阀），与上面完全独立
  singleToolRatio: 0.05,
  overflowPostInsertRatio: 0.95,
  // 其他
  keepLastTurns: 3,
  maxSummaryTokens: 900,
  droppedRatioLimit: 0.3,
  entityJaccardMin: 0.6,
  entryJaccardMin: 0.5,
  nCtx: 8192,
  probeTimeoutMs: 300,
  level: 'ctx', // 'ctx' | 'engine' | 'process'
});

const SUMMARY_INSTRUCTION = `你是会话状态转录器，不是润色器。

把当前工作状态转录为 JSON 数组，每项形如：
  {"status":"todo|done|decision|dropped","text":"...","ref_id":"可选，指向上一版条目 ID"}

硬规则：
1. 不得输出 id 字段；ID 由程序分配。要继续某条旧条目，用 ref_id 指回它。
2. 上一版里每一条都必须出现在输出中，除非你把它标成 dropped 并在 text 里写 "reason: ..."。
3. status 只能前进：todo->done/dropped，done->dropped。禁止 dropped->任意、禁止 done->todo。
4. 已完成的条目，text 必须与上一版逐字一致，不要改写措辞。
5. 否定/否决信息必须保留，不得合并或省略。
6. 输出必须是纯 JSON 数组，不要解释、不要 markdown 围栏。`;

function buildPrompt(prevDoc, traceTail) {
  const prev = prevDoc || '(空，这是第一次固化)';
  return [
    SUMMARY_INSTRUCTION,
    '',
    '=== 上一版工作日志 ===',
    prev.trim(),
    '',
    '=== 最近原始轨迹（供补全细节，不是让你复述）===',
    traceTail || '(无)',
  ].join('\n');
}

function buildSystemPrompt(doc, traceTail, keepLastTurns) {
  return [
    '你在继续一个会话。下面是你的工作日志与最近几轮原文，请据此接着做。',
    '',
    doc.trim(),
    '',
    `## 最近 ${keepLastTurns} 轮原文`,
    traceTail || '(无)',
  ].join('\n');
}

const safeRead = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

export class LifecycleCacheCleaner {
  constructor({ adapter, rootDir, sessionId, config = {} }) {
    if (!adapter) throw new Error('adapter required');
    if (!sessionId) throw new Error('sessionId required (程序生成 UUID，不接受外部字符串)');
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error('sessionId 含非法字符');

    this.adapter = adapter;
    this.cfg = { ...DEFAULTS, ...config };
    this.sessionId = sessionId;
    this.rootDir = rootDir || process.cwd();
    this.worklogPath = path.join(this.rootDir, 'worklogs', `${sessionId}.md`);
    this.backupPath = path.join(this.rootDir, 'worklogs', '.bak', `${sessionId}.md`);
    this.spillDir = path.join(this.rootDir, 'spill');
    this.store = new StateStore(path.join(this.rootDir, 'state.json'), { sessionId });
    this.guard = new OverflowGuard({
      nCtx: this.cfg.nCtx,
      singleToolRatio: this.cfg.singleToolRatio,
      postInsertRatio: this.cfg.overflowPostInsertRatio,
      spillDir: this.spillDir,
    });
    this.turn = 0;
    this.modelId = null;
    this._busy = false;

    // 能力探测：DSH 原生压缩在场时，重建归宿主，我们不再自算水位。
    // 拿不准一律 false（回退到自己触发），绝不假设宿主支持。
    this.caps = {
      compaction: Boolean(adapter?.capabilities?.compaction),
      tokenMeter: Boolean(adapter?.capabilities?.tokenMeter),
    };
    this.mode = this.caps.compaction ? 'compaction-driven' : 'self-triggered';
  }

  get phase() {
    return this.store.phase;
  }

  /* -------------------------------------------------------- 入口闸门（无模型） */

  guardToolOutput(text, opts = {}) {
    return this.guard.guardToolOutput(text, opts);
  }

  /* -------------------------------------------------------------- 每轮主循环 */

  async tick({ userText = '', tools = [] } = {}) {
    this.turn += 1;

    // 廉价微固化：不调模型、不阻塞、失败静默
    appendRawTrace({ logPath: this.worklogPath, turn: this.turn, userText, tools });

    const modelId = await this.adapter.currentModelId?.();
    const switched = Boolean(this.modelId && modelId && modelId !== this.modelId);
    if (modelId) this.modelId = modelId;

    if (switched && !this.caps.compaction) {
      return this.rebuild({ reason: 'model-switch' });
    }

    const ratio = await this.adapter.usageRatio();

    // DSH 原生压缩模式：压缩由宿主发起（pressure / context-overflow），
    // 我们只在 compaction/end 回到 onCompacted()。这里绝不自建重建，避免双重压缩。
    if (this.caps.compaction) {
      return {
        ok: true,
        rebuilt: false,
        ratio,
        turn: this.turn,
        mode: this.mode,
        modelSwitched: switched,
      };
    }

    const due = ratio >= this.cfg.rebuildWatermark && this.turn % Math.max(1, this.cfg.rebuildPeriodTurns) === 0;
    if (due) return this.rebuild({ reason: 'watermark' });

    return { ok: true, rebuilt: false, ratio, turn: this.turn };
  }

  /* ------------------------------------------------------------ 重建（核心） */

  async rebuild({ reason = 'manual' } = {}) {
    if (this._busy) return { ok: false, skipped: 'busy' };
    this._busy = true;
    try {
      return await this.#runRebuild({ reason });
    } finally {
      this._busy = false;
    }
  }

  async #rollback(error) {
    this.store.transition(PHASES.ROLLED_BACK, { last_error: String(error).slice(0, 500) });
    return { ok: false, stage: 'rollback', error: String(error) };
  }

  async #runRebuild({ reason }) {
    const st = this.store;
    if (![PHASES.IDLE, PHASES.COMMITTED, PHASES.ROLLED_BACK].includes(st.phase)) {
      return { ok: false, skipped: `phase:${st.phase}` };
    }

    // 新一轮周期：上一轮已提交或已回滚，必须先回到 idle（迁移合法性保持严格）
    if (st.phase === PHASES.COMMITTED || st.phase === PHASES.ROLLED_BACK) {
      st.transition(PHASES.IDLE);
    }
    st.transition(PHASES.SUMMARIZING, { reason });

    const built = await this.#writeWorklog();
    if (!built.ok) {
      await this.#rollback(built.rollbackMsg);
      return built.final || { ok: false, stage: 'rollback', error: built.rollbackMsg };
    }
    const { doc, traceTail } = built;

    st.transition(PHASES.VALIDATED);

    // 统一闸门：探测不到部署就不动引擎（日志已提交，不走销毁）
    const gate = await this.#gateRelease();
    if (!gate.proceed) {
      await this.#rollback(`gate:${gate.code}`);
      return { ok: false, stage: 'gate', code: gate.code, probeState: gate.probeState };
    }

    st.transition(PHASES.TEARING_DOWN, { committed_log_path: this.worklogPath });

    // 物理清理：只有销毁重建，没有"清缓存"
    const systemPrompt = buildSystemPrompt(doc, traceTail, this.cfg.keepLastTurns);
    try {
      await this.adapter.destroyEngine();
    } catch (err) {
      return this.#rollback(`destroy_failed:${err.message}`);
    }

    st.transition(PHASES.REBUILDING);

    let handleOk = false;
    try {
      await this.adapter.rebuildSession({
        nCtx: this.cfg.nCtx,
        systemPrompt,
        level: this.cfg.level,
      });
      handleOk = (await this.adapter.health?.()) ?? true;
    } catch (firstErr) {
      // 用原 n_ctx 重试一次（保证最坏也不比之前差）
      try {
        await this.adapter.rebuildSession({
          nCtx: this.store.state.target_ctx || this.cfg.nCtx,
          systemPrompt,
          level: this.cfg.level,
          retry: true,
        });
        handleOk = (await this.adapter.health?.()) ?? true;
      } catch (secondErr) {
        return this.#rollback(`rebuild_failed:${firstErr.message} / ${secondErr.message}`);
      }
    }

    // V3：句柄无效 -> 不提交半成品
    if (!handleOk) return this.#rollback('handle_invalid');

    st.transition(PHASES.COMMITTED);
    return { ok: true, rebuilt: true, phase: PHASES.COMMITTED, logPath: this.worklogPath };
  }

  /* ---------------------------------------------------- 压缩驱动（宿主原生） */

  /**
   * 宿主 compaction/end 回调（失败带 error）。
   *
   * 两个动作严格分开：
   *   - 记忆整理（固化工作日志）：失败就不释放显存（沿用 V1「没有有效日志就不清理」）
   *   - 缓存释放：失败不回滚已提交的日志，也不抛给宿主
   */
  async onCompacted({ error = null, droppedTokens = 0 } = {}) {
    if (!this.caps.compaction) {
      return { ok: false, skipped: 'compaction_unavailable' };
    }
    if (error) {
      return { ok: false, skipped: 'compaction_failed', error: String(error).slice(0, 500) };
    }
    if (await this.#compactionOpen()) {
      return { ok: false, skipped: 'compaction_open' };
    }

    const memory = await this.#solidifyOnly('compaction');
    if (!memory.ok) {
      // 日志整理没完成，压缩就不算完成：既不报完成，也不碰引擎。
      return {
        ok: false,
        compactionComplete: false,
        droppedTokens,
        memory,
        cache: { ok: false, skipped: 'memory_failed' },
      };
    }

    // 到这里日志已落盘，压缩才成立；缓存释放是后续动作，失败不影响“压缩完成”。
    const cache = await this.releaseCache({ reason: 'compaction' });
    return { ok: true, compactionComplete: true, droppedTokens, memory, cache };
  }

  /** 只释放引擎，不写日志、不动状态机。失败不外抛。 */
  async releaseCache({ reason = 'manual' } = {}) {
    if (this._busy) return { ok: false, skipped: 'busy' };
    this._busy = true;
    try {
      const gate = await this.#gateRelease();
      if (!gate.proceed) {
        return { ok: false, skipped: gate.code, cause: gate.cause ?? null, probeState: gate.probeState, reason };
      }

      const md = safeRead(this.worklogPath);
      const traceTail = readRawTraceTail({ logPath: this.worklogPath, maxTurns: this.cfg.keepLastTurns });
      const systemPrompt = buildSystemPrompt(md || '(无工作日志)', traceTail, this.cfg.keepLastTurns);

      await this.adapter.destroyEngine();
      await this.adapter.rebuildSession({
        nCtx: this.cfg.nCtx,
        systemPrompt,
        level: this.cfg.level,
        reason,
      });
      const ok = (await this.adapter.health?.()) ?? true;
      return { ok, stage: 'release', reason, probeState: gate.probeState };
    } catch (err) {
      return { ok: false, stage: 'release', reason, error: String(err.message).slice(0, 500) };
    } finally {
      this._busy = false;
    }
  }

  /**
   * 统一闸门：动手前必须探测。
   * 本插件自建引擎，归属采 'adapter-exclusive'；会话删除链路另走 'lease'。
   */
  async #gateRelease() {
    const probeResult = await probeAdapter(this.adapter, { timeoutMs: this.cfg.probeTimeoutMs });
    const verdict = evaluateGate({
      probeState: probeResult.state,
      snapshot: probeResult.snapshot,
      ownership: 'adapter-exclusive',
    });
    return { ...verdict, probeState: probeResult.state, probeCode: probeResult.code };
  }

  /**
   * DSH 用未闭合的 compaction/start 事件当锁。拿不准就当忙——宁可不动。
   */
  async #compactionOpen() {
    if (typeof this.adapter?.isCompactionOpen !== 'function') return false;
    try {
      return Boolean(await this.adapter.isCompactionOpen());
    } catch {
      return true;
    }
  }

  /**
   * 只固化工作日志，不进状态机。
   * compaction-driven 模式下引擎归宿主管，TEARING_DOWN/REBUILDING 无意义。
   */
  async #solidifyOnly(reason) {
    const built = await this.#writeWorklog();
    if (!built.ok) {
      return built.final || { ok: false, stage: 'rollback', error: built.rollbackMsg };
    }
    return { ok: true, stage: 'log_committed', reason, logPath: this.worklogPath };
  }

  /**
   * 摘要 -> L5 校验 -> L6 原子提交。不碰状态机、不碰引擎。
   * 调用方负责根据返回决定回滚与后续动作。
   */
  async #writeWorklog() {
    const prevMd = safeRead(this.worklogPath);
    const prev = prevMd ? wl.parseWorklog(prevMd) : { goal: '', entries: [], negations: [] };
    const traceTail = readRawTraceTail({ logPath: this.worklogPath, maxTurns: this.cfg.keepLastTurns });

    let raw;
    try {
      raw = await this.adapter.summarize(buildPrompt(prevMd, traceTail), {
        maxTokens: this.cfg.maxSummaryTokens,
      });
    } catch (err) {
      return { ok: false, rollbackMsg: `summarize_failed:${err.message}` };
    }

    // V1：总结超长/为空 -> 不清理
    const tokens = defaultCountTokens(raw || '');
    if (!raw || tokens > this.cfg.maxSummaryTokens) {
      return {
        ok: false,
        rollbackMsg: `summary_too_long:${tokens}`,
        final: { ok: false, stage: 'summary-size', tokens },
      };
    }

    let modelEntries;
    try {
      modelEntries = wl.parseModelEntries(raw);
    } catch (err) {
      return {
        ok: false,
        rollbackMsg: `summary_unparseable:${err.message}`,
        final: { ok: false, stage: 'parse', error: err.message },
      };
    }

    const assigned = wl.assignIds(modelEntries, prev.entries);
    const negations = wl.mergeNegations(prev.negations, prev.entries, assigned);
    const trace = prevMd ? extractTraceSection(prevMd) : '';

    const doc = wl.renderWorklog({
      sessionId: this.sessionId,
      goal: prev.goal || '(未声明)',
      entries: assigned,
      negations,
      rawTrace: trace,
    });

    const verdict = wl.validateWorklog({
      prev,
      next: wl.parseWorklog(doc),
      limits: {
        droppedRatioLimit: this.cfg.droppedRatioLimit,
        entityJaccardMin: this.cfg.entityJaccardMin,
        entryJaccardMin: this.cfg.entryJaccardMin,
      },
    });
    if (!verdict.ok) {
      return {
        ok: false,
        rollbackMsg: `l5:${verdict.reasons.join('|')}`,
        final: { ok: false, stage: 'l5', reasons: verdict.reasons },
      };
    }

    // L6 原子提交
    fs.mkdirSync(path.dirname(this.worklogPath), { recursive: true });
    const tmpPath = `${this.worklogPath}.tmp`;
    fs.writeFileSync(tmpPath, doc, 'utf8');
    try {
      wl.commitAtomic({ tmpPath, finalPath: this.worklogPath, backupPath: this.backupPath });
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      return { ok: false, rollbackMsg: `commit_failed:${err.message}` };
    }

    return { ok: true, doc, traceTail };
  }

  /* -------------------------------------------------------------- 崩溃恢复 */

  async recover() {
    const phase = this.store.phase;
    const action = recoveryAction(phase);
    if (action === 'none') return { recovered: false, phase, action };

    if (action === 'discard') {
      this.store.transition(PHASES.ROLLED_BACK, { last_error: 'crash_before_commit' });
      return { recovered: true, phase: this.store.phase, action };
    }

    const logPath = this.store.state.committed_log_path || this.worklogPath;
    const doc = safeRead(logPath);
    if (!doc) {
      this.store.transition(PHASES.ROLLED_BACK, { last_error: 'committed_log_missing' });
      return { recovered: false, action, error: 'committed_log_missing' };
    }

    if (action === 'resume_rebuild') this.store.transition(PHASES.REBUILDING);

    try {
      const systemPrompt = buildSystemPrompt(doc, '', this.cfg.keepLastTurns);
      await this.adapter.rebuildSession({
        nCtx: this.cfg.nCtx,
        systemPrompt,
        level: this.cfg.level,
      });
      const ok = (await this.adapter.health?.()) ?? true;
      if (!ok) throw new Error('handle_invalid');
    } catch (err) {
      this.store.transition(PHASES.ROLLED_BACK, { last_error: `recover_failed:${err.message}` });
      return { recovered: false, action, error: err.message };
    }

    this.store.transition(PHASES.COMMITTED);
    return { recovered: true, phase: this.store.phase, action, logPath };
  }

  /* ---------------------------------------------------- 换模型：加密节奏兜底 */

  /** 宿主无"切换前窗口"时，由宿主每 5 轮调一次。 */
  async periodicSolidify() {
    const ratio = await this.adapter.usageRatio();
    return this.rebuild({ reason: `periodic:${ratio.toFixed(2)}` });
  }

  /** 共享日志写入前的确认队列（模型只能提议，不能直写）。 */
  proposeShared(pending) {
    const dir = path.join(this.rootDir, 'shared', '.pending');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${this.sessionId}.json`),
      JSON.stringify({ ...pending, session: this.sessionId, at: Date.now() }, null, 2),
      'utf8',
    );
  }
}
