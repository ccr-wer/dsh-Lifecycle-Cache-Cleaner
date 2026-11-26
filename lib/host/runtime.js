/**
 * 宿主运行时：把核心模块拼成插件能直接用的能力。
 *
 * 刻意不 import 任何 `@deepseek-ai/*`：第三方组合包在 profile 里解析不到宿主包
 * （`dsh-session-manager` 也只依赖 node 内建 + cordis 的 peer），
 * 所以访问宿主一律通过注入的 ctx 与 config。
 */
import path from 'node:path';

import { TypedMemoryStore } from '../core/memory-store.js';
import { WorkspaceMemoryStore } from '../core/workspace-memory.js';
import { ProfileStore } from './profile-store.js';
import { ProposalStore } from './proposal-store.js';
import { probeAdapter, evaluateGate } from '../core/release-gate.js';
import { sessionIdOf } from './session-watcher.js';

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
  constructor({ rootDir, workspaceId = null, adapter = null, ownership = 'adapter-exclusive', config = {}, leases = null } = {}) {
    if (!rootDir) throw new Error('HostRuntime: rootDir required');
    this.rootDir = rootDir;
    this.workspaceId = workspaceId || null;
    this.adapter = adapter;
    this.ownership = ownership;
    this.config = config ?? {};
    this.leases = leases;
    this.diagnostics = [];
    this.recentDeletions = [];
    this.watcher = null;
    /**
     * 最近一次**真正尝试过**的清理（成功或按闸门拒清）。
     *
     * UI 靠 `seq` 变化弹提示：成功弹一条“已释放”，未部署弹一条“没探测到，所以没清”。
     * 预览式调用（`confirm: false`）不算一次尝试，不写这里——否则用户点开面板就会
     * 被“没有清理”的提示刷一遍。
     * @type {{seq:number, at:number, trigger:string, released:boolean, code:string|null,
     *         probeState:string|null, reason:string}|null}
     */
    this.lastRelease = null;
    this.releaseSeq = 0;
    /**
     * 每个工作区“最近一条用户消息”，只用于注入时按相关度排序。
     * 注入发生在 systemPrompt 组装期，那里拿不到当前请求的消息，
     * 所以由 `session/event` 的 `user/message` 提前记下来。
     * @type {Map<string, {text:string, at:number}>}
     */
    this.promptHints = new Map();
    /** 上一次真实注入的统计，面板用来显示“丢弃了 N 条”。 */
    this.injection = null;
    this.memory = new TypedMemoryStore({ rootDir });
    this.docs = new WorkspaceMemoryStore({ rootDir });
    /** 用户自有的助手设定（只有 UI 能写，模型没有写入口）。 */
    this.profiles = new ProfileStore({ rootDir });
    /** 模型的记忆提议暂存（等待用户在面板里接受/拒绝）。 */
    this.proposals = new ProposalStore({ rootDir, now: () => Date.now() });
  }

  /** 让 status() 能看到会话监听的运行情况。 */
  attachWatcher(watcher) {
    this.watcher = watcher;
  }

  /**
   * 记下某个工作区最近一条用户消息（注入按它做相关度排序）。
   * 太旧的消息没有参考价值，所以带 TTL。
   * @param {string} workspaceId 工作区路径
   * @param {string} text        用户消息文本
   */
  rememberHint(workspaceId, text) {
    if (!workspaceId || typeof text !== 'string') return;
    const trimmed = text.trim();
    if (trimmed === '') return;
    // 太长的话取尾部：用户提问的重点一般在后半句。
    const clipped = trimmed.length > 600 ? trimmed.slice(-600) : trimmed;
    this.promptHints.set(String(workspaceId), { text: clipped, at: Date.now() });
  }

  /** 取该工作区最近的用户消息；超过 30 分钟就不再当作“当前问题”。 */
  hintFor(workspaceId) {
    if (!workspaceId) return null;
    const hit = this.promptHints.get(String(workspaceId));
    if (!hit) return null;
    if (Date.now() - hit.at > 30 * 60 * 1000) return null;
    return hit.text;
  }

  /**
   * 会话目录消失后调用：释放租约，并按闸门尝试释放引擎。
   * 任何异常都不外抛——删除会话不能被清理拖住。
   */
  async handleSessionsRemoved(removed) {
    const ids = removed.map(sessionIdOf).filter(Boolean);
    for (const id of ids) {
      try {
        this.leases?.release?.(id, 'session_deleted');
      } catch (err) {
        this.diagnostics.push(`lease release ${id}: ${err?.message ?? err}`);
      }
    }

    const entry = { at: Date.now(), sessions: ids, released: false, code: null };
    if (this.config.releaseOnDelete === false) {
      entry.code = 'release_disabled';
    } else {
      try {
        const r = await this.clean({ confirm: true, trigger: 'session-deleted' });
        entry.released = r.released;
        entry.code = r.code;
      } catch (err) {
        entry.code = 'clean_failed';
        this.diagnostics.push(`clean after delete: ${err?.message ?? err}`);
      }
    }

    this.recentDeletions.unshift(entry);
    if (this.recentDeletions.length > 10) this.recentDeletions.length = 10;
    return entry;
  }

  /**
   * 注入到 system prompt 的记忆文本（已按预算截断）。
   * 标题也在这里生成：没有记忆时返回空串，prompt 里就不会留一个空转的“## 记忆”。
   *
   * **只渲染共享层**。工作区记忆按会话的 cwd 走 `workspaceMemoryText()`，
   * 否则所有项目的条目会串到同一次对话里（桌面进程的 workspaceId 是 profile 目录，
   * 分不开工作区）。
   */
  memoryText() {
    try {
      const rendered = this.memory.render({ workspaceId: null });
      // 共享层没有工作区上下文，拿不到“当前问题”，所以不按相关度排序；
      // 这里只记录统计，供面板显示“丢弃了多少条”。
      this.#noteInjection('shared', rendered, false);
      const text = rendered.text;
      return text ? `## 记忆\n\n${text}` : '';
    } catch (err) {
      this.diagnostics.push(`memory.render: ${err?.message ?? err}`);
      return '';
    }
  }

  /** 某一个工作区的条目记忆（给按 agent 注册的 scoped section 用）。 */
  workspaceMemoryText(workspaceId) {
    if (!workspaceId) return '';
    try {
      // 用该工作区最近一条用户消息做相关度排序：预算有限时先注入“现在要用的”。
      const hint = this.hintFor(workspaceId);
      const rendered = this.memory.render({ workspaceId, maxSharedBytes: 0, query: hint });
      this.#noteInjection('workspace', rendered, Boolean(hint));
      return rendered.text ? rendered.text : '';
    } catch (err) {
      this.diagnostics.push(`workspaceMemory.render: ${err?.message ?? err}`);
      return '';
    }
  }

  /**
   * 记录上一次注入的统计（面板显示“丢弃 N 条”用）。
   * 共享层与工作区层是两次独立渲染，所以合并成一条记录。
   */
  #noteInjection(layer, rendered, ranked) {
    const now = Date.now();
    const prev = this.injection;
    const fresh = prev && now - prev.at < 5000 ? prev : { at: now, shared: null, workspace: null };
    fresh.at = now;
    fresh[layer] = {
      injected: layer === 'shared' ? rendered.counts.shared - rendered.dropped.shared : rendered.counts.workspace - rendered.dropped.workspace,
      total: layer === 'shared' ? rendered.counts.shared : rendered.counts.workspace,
      dropped: layer === 'shared' ? rendered.dropped.shared : rendered.dropped.workspace,
      ranked,
    };
    this.injection = fresh;
  }

  /** 注入到 system prompt 的用户设定；空设定返回空串。 */
  profileText() {
    try {
      return this.profiles.promptText();
    } catch (err) {
      this.diagnostics.push(`profile.render: ${err?.message ?? err}`);
      return '';
    }
  }

  /**
   * 记忆面板的数据：共享层 + 每个工作区一组（可折叠）+ 待用户确认的模型提议。
   *
   * 工作区列表来自宿主 `workspaceRegistry`（传进来的 `workspaces`），再并上
   * `typed.json` 里已经出现过的工作区——新建的项目目录只要被宿主登记过，
   * 面板里就会自动多出一组，不需要用户手动“创建记忆”.
   *
   * @param {{workspaces?: Array<{id?:string, path?:string, title?:string}>}} [options]
   */
  memoryPanel({ workspaces = [] } = {}) {
    const toRow = (entry) => ({
      id: entry.id,
      text: entry.text,
      scope: entry.scope,
      workspaceId: entry.workspaceId ?? null,
      author: entry.author ?? entry.source ?? 'model',
      updatedAt: entry.updatedAt ?? 0,
      conflict: entry.conflict === true,
    });

    const pending = this.proposals.list().map((item) => ({
      id: item.id,
      text: item.text,
      scope: item.scope,
      workspaceId: item.workspaceId ?? null,
      reason: item.reason ?? '',
      createdAt: item.createdAt ?? 0,
    }));

    /** 工作区 id -> 显示信息。key 用工作区**路径**，和记忆条目的 workspaceId 同一口径。 */
    const groups = new Map();
    const ensure = (id, extra = {}) => {
      const key = String(id ?? '').trim();
      if (!key) return null;
      let group = groups.get(key);
      if (!group) {
        group = { id: key, title: extra.title ?? '', label: extra.label ?? path.basename(key), entries: [], pending: [] };
        groups.set(key, group);
      } else if (extra.title && !group.title) {
        group.title = extra.title;
      }
      return group;
    };

    for (const workspace of workspaces) {
      const id = workspace?.path ?? workspace?.id;
      if (!id) continue;
      ensure(String(id), { title: workspace.title ?? '', label: path.basename(String(id)) });
    }

    const workspaceEntries = this.memory.list({ scope: 'workspace' }).map(toRow);
    for (const entry of workspaceEntries) {
      ensure(entry.workspaceId);
      groups.get(String(entry.workspaceId))?.entries.push(entry);
    }
    for (const item of pending) {
      if (item.scope !== 'workspace' || !item.workspaceId) continue;
      ensure(item.workspaceId);
      groups.get(String(item.workspaceId))?.pending.push(item);
    }

    const workspaceGroups = [...groups.values()]
      .map((group) => ({
        id: group.id,
        label: group.label,
        title: group.title,
        entries: group.entries,
        pending: group.pending,
        doc: this.docs.read(group.id),
        docBytes: this.docs.sizeOf(group.id),
      }))
      .sort((a, b) => (a.label || '').localeCompare(b.label || ''));

    // 显示名：宿主登记过 title 就用 title，否则用路径最后一段。
    // 同名时补上父目录名（`default-workspace (deepseek-harness)`），
    // 否则不同盘下同名目录在面板里长得一模一样。区分只按路径分段做，
    // 不用 path.basename —— 它只认当前平台的分隔符，测试里会翻车。
    const segmentsOf = (value) => String(value ?? '').split(/[\\/]+/).filter(Boolean);
    const baseLabelOf = (group) => {
      const title = String(group.title ?? '').trim();
      if (title) return title;
      const segments = segmentsOf(group.id);
      return segments[segments.length - 1] ?? group.id;
    };
    const labelCounts = new Map();
    for (const group of workspaceGroups) {
      const base = baseLabelOf(group);
      labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1);
    }
    for (const group of workspaceGroups) {
      const base = baseLabelOf(group);
      if ((labelCounts.get(base) ?? 0) > 1) {
        const segments = segmentsOf(group.id);
        const parent = segments.length >= 2 ? segments[segments.length - 2] : '';
        group.label = parent ? `${base} (${parent})` : base;
      } else {
        group.label = base;
      }
    }
    // 补完父目录后缀后按最终显示名重排，顺序才和界面上看到的一致。
    workspaceGroups.sort(
      (a, b) => String(a.label).localeCompare(String(b.label)) || String(a.id).localeCompare(String(b.id)),
    );

    return {
      workspaceId: this.workspaceId,
      shared: {
        entries: this.memory.list({ scope: 'shared' }).map(toRow),
        pending: pending.filter((item) => item.scope === 'shared'),
      },
      workspaces: workspaceGroups,
      pendingCount: pending.length,
      budget: { sharedBytes: 1024, workspaceBytes: 2048 },
      // 上一次真实注入的情况：被预算挤掉几条，用户该不该担心“记了但没生效”。
      injection: this.injection,
    };
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
      sessionWatcher: this.watcher ? this.watcher.stats() : null,
      recentDeletions: [...this.recentDeletions],
      lastRelease: this.lastRelease,
      injection: this.injection,
      diagnostics: [...this.diagnostics],
    };
  }

  /**
   * 释放引擎。必经闸门；闸门不放行就不动手。
   * @param {{confirm?: boolean, trigger?: string}} [options]
   * @param {string} [options.trigger] 谁触发的：`manual` | `tool` | `session-deleted`
   */
  async clean({ confirm = false, trigger = 'manual' } = {}) {
    const probe = await this.probe();
    const gate = evaluateGate({
      probeState: probe.state,
      snapshot: probe.snapshot,
      ownership: this.ownership,
    });

    /** 记一条“尝试过”，并返回给调用方；预览（缺 confirm）不计入。 */
    const record = (result) => {
      this.releaseSeq += 1;
      this.lastRelease = {
        seq: this.releaseSeq,
        at: Date.now(),
        trigger,
        released: result.released === true,
        code: result.code ?? null,
        probeState: result.probeState ?? probe.state ?? null,
        reason: result.reason ?? '',
      };
      return result;
    };

    if (!gate.proceed) {
      return record({ released: false, code: gate.code, probeState: probe.state, reason: SKIP_REASON[gate.code] ?? gate.code });
    }
    if (confirm !== true) {
      return { released: false, code: 'confirm_required', probeState: probe.state, reason: SKIP_REASON.confirm_required };
    }
    if (!this.adapter || typeof this.adapter.destroyEngine !== 'function') {
      return record({ released: false, code: 'no_destroy', probeState: probe.state, reason: SKIP_REASON.no_destroy });
    }

    try {
      await this.adapter.destroyEngine();
      return record({ released: true, code: 'released', probeState: probe.state, reason: '引擎已释放。' });
    } catch (err) {
      return record({
        released: false,
        code: 'release_failed',
        probeState: probe.state,
        reason: `释放失败：${err?.message ?? err}`,
      });
    }
  }
}

export { SKIP_REASON };
