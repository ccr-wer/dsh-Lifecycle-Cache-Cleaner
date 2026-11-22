/**
 * 模型的“记忆提议”暂存区。
 *
 * 为什么要单独一层：记忆的写入口必须是**用户确认过的**（D15 / D25）。
 * 模型能做的只是“我发现一条值得记住的事实，建议放共享/某工作区”；
 * 这条建议先落在这里，等用户在记忆面板里点接受或拒绝，才真正进 `typed.json`。
 *
 * 设计上的取舍：
 *  - 提议是**有归属目标**的：`workspace` 必须带一个工作区路径（`workspaceId`），
 *    否则不知道该进哪个工作区，直接拒收——免得列表里出现一堆无主建议。
 *  - 同一目标下文本相同的提议只留一条（避免模型反复提议刷屏）。
 *  - 接受时不复用 `propose()` 的裁决：用户在界面里已经确认过目标，
 *    直接走 `addUserEntry()`（归属听用户的，D25）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { writeFileAtomic } from '../core/atomic.js';
import { normalizeMemoryText } from '../core/memory-store.js';

export const PENDING_LIMIT = 50;

const EMPTY = { version: 1, items: [] };

export class ProposalStore {
  constructor({ rootDir, now = () => Date.now() } = {}) {
    if (!rootDir) throw new Error('ProposalStore: rootDir required');
    this.rootDir = rootDir;
    this.now = now;
    this.file = path.join(rootDir, 'memory', 'pending.json');
    this.data = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || !Array.isArray(parsed.items)) return { ...EMPTY, items: [] };
      return parsed;
    } catch {
      return { ...EMPTY, items: [] };
    }
  }

  #flush() {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }

  list() {
    return this.data.items.map((item) => ({ ...item }));
  }

  /**
   * 加一条提议（模型调用）。
   * @returns {{ok:boolean, code:string, id?:string, pending?:number, reason?:string}}
   */
  add({ text, scope, workspaceId = null, reason = '' } = {}) {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, code: 'empty_text' };
    if (scope !== 'shared' && scope !== 'workspace') return { ok: false, code: 'bad_scope' };
    if (scope === 'workspace' && !workspaceId) return { ok: false, code: 'workspace_required' };

    const normalized = normalizeMemoryText(raw);
    const duplicate = this.data.items.some(
      (item) => item.normalized === normalized && item.scope === scope && (item.workspaceId ?? null) === (workspaceId ?? null),
    );
    if (duplicate) return { ok: true, code: 'duplicate', pending: this.data.items.length };

    if (this.data.items.length >= PENDING_LIMIT) {
      return { ok: false, code: 'pending_full', reason: `待确认的提议已达上限（${PENDING_LIMIT} 条），先在面板里处理掉一些。` };
    }

    const id = crypto.createHash('sha256').update(`${scope}\0${workspaceId ?? ''}\0${normalized}\0${this.now()}`).digest('hex').slice(0, 12);
    this.data.items.push({
      id,
      text: raw,
      normalized,
      scope,
      workspaceId: scope === 'workspace' ? String(workspaceId) : null,
      reason: String(reason ?? '').slice(0, 200),
      createdAt: this.now(),
      source: 'model',
    });
    this.#flush();
    return { ok: true, code: 'queued', id, pending: this.data.items.length };
  }

  /** 取走一条（接受/拒绝都由调用方决定后续动作）。 */
  take(id) {
    const index = this.data.items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [item] = this.data.items.splice(index, 1);
    this.#flush();
    return { ...item };
  }
}
