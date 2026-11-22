/**
 * 宿主运行时：把核心模块拼成插件能直接用的能力。
 *
 * 刻意不 import 任何 `@deepseek-ai/*`：第三方组合包在 profile 里解析不到宿主包
 * （`dsh-session-manager` 也只依赖 node 内建 + cordis 的 peer），
 * 所以访问宿主一律通过注入的 ctx 与 config。
 */
import { TypedMemoryStore } from '../core/memory-store.js';
import { WorkspaceMemoryStore } from '../core/workspace-memory.js';
import { probeAdapter, evaluateGate } from '../core/release-gate.js';

const SKIP_REASON = Object.freeze({
  skip_absent: '本机没有探测到本地引擎（absent），按闸门规则不动它。',
  skip_unknown: '探测失败或适配器没有实现 probeEngine（unknown），fail-closed，不清理。',
  skip_no_lease: '有引擎但没有对应租约，无法证明归属，不清理。',
  skip_foreign: '引擎归属对不上（foreign），不清理。',
  confirm_required: '闸门已放行，但缺少 confirm=true，未执行释放。',
  no_destroy: '适配器没有实现 destroyEngine()，无法释放。',
});

export class HostRuntime {
  /**
   * @param {object} options
   * @param {string} options.rootDir   插件数据目录（memory/、worklogs/ 等都落在这里）
   * @param {string|null} [options.workspaceId]
   * @param {object|null} [options.adapter] 引擎适配器（probeEngine / destroyEngine）
   * @param {'lease'|'adapter-exclusive'} [options.ownership]
   * @param {object} [options.config]
   */
  constructor({ rootDir, workspaceId = null, adapter = null, ownership = 'adapter-exclusive', config = {} } = {}) {
    if (!rootDir) throw new Error('HostRuntime: rootDir required');
    this.rootDir = rootDir;
    this.workspaceId = workspaceId || null;
    this.adapter = adapter;
    this.ownership = ownership;
    this.config = config ?? {};
    this.diagnostics = [];
    this.memory = new TypedMemoryStore({ rootDir });
    this.docs = new WorkspaceMemoryStore({ rootDir });
  }

  /** 注入到 system prompt 的记忆文本（已按预算截断）。 */
  memoryText() {
    try {
      return this.memory.render({ workspaceId: this.workspaceId }).text;
    } catch (err) {
      this.diagnostics.push(`memory.render: ${err?.message ?? err}`);
      return '';
    }
  }

  async probe() {
    try {
      return await probeAdapter(this.adapter, {
        timeoutMs: this.config.probeTimeoutMs ?? 300,
      });
    } catch (err) {
      this.diagnostics.push(`probe: ${err?.message ?? err}`);
      return { state: 'unknown', snapshot: null, code: 'probe_failed' };
    }
  }

  /** 只读体检：不写任何文件，不碰引擎。 */
  async status() {
    const probe = await this.probe();
    const gate = evaluateGate({
      probeState: probe.state,
      snapshot: probe.snapshot,
      ownership: this.ownership,
    });
    const rendered = this.memory.render({ workspaceId: this.workspaceId });
    const docBytes = this.workspaceId ? this.docs.sizeOf(this.workspaceId) : 0;

    return {
      rootDir: this.rootDir,
      workspaceId: this.workspaceId,
      engine: {
        state: probe.state,
        code: probe.code,
        models: (probe.snapshot?.models ?? []).map((m) => m?.name ?? String(m)),
        ownership: this.ownership,
      },
      gate: { proceed: gate.proceed, code: gate.code },
      memory: {
        shared: rendered.counts.shared,
        workspace: rendered.counts.workspace,
        truncated: rendered.truncated,
        workspaceDocBytes: docBytes,
      },
      diagnostics: [...this.diagnostics],
    };
  }

  /**
   * 释放引擎。必经闸门；闸门不放行就不动手。
   * @param {{confirm?: boolean}} [options]
   */
  async clean({ confirm = false } = {}) {
    const probe = await this.probe();
    const gate = evaluateGate({
      probeState: probe.state,
      snapshot: probe.snapshot,
      ownership: this.ownership,
    });

    if (!gate.proceed) {
      return { released: false, code: gate.code, probeState: probe.state, reason: SKIP_REASON[gate.code] ?? gate.code };
    }
    if (confirm !== true) {
      return { released: false, code: 'confirm_required', probeState: probe.state, reason: SKIP_REASON.confirm_required };
    }
    if (!this.adapter || typeof this.adapter.destroyEngine !== 'function') {
      return { released: false, code: 'no_destroy', probeState: probe.state, reason: SKIP_REASON.no_destroy };
    }

    try {
      await this.adapter.destroyEngine();
      return { released: true, code: 'released', probeState: probe.state, reason: '引擎已释放。' };
    } catch (err) {
      return {
        released: false,
        code: 'release_failed',
        probeState: probe.state,
        reason: `释放失败：${err?.message ?? err}`,
      };
    }
  }
}

export { SKIP_REASON };
