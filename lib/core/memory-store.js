/**
 * 条目化记忆：模型提议 → 程序裁决归属 → 写入前消重 → 满阈值自动升级到共享层。
 *
 * 为什么要程序裁决：共享层一旦被单个工作区的临时约定污染，所有工作区都会读到错的东西。
 * 所以模型只给 `scope` 建议，最终归属由这里按可判定信号算出来；不一致时记审计。
 *
 * 三条纪律：
 *  - 写入必须 confirmed:true（模型只能提议，不能直写）。
 *  - 永不删除条目：更新用 supersedes 链，冲突两条都留并标 conflict。
 *  - 读取有硬预算：记忆进 systemPrompt 会和溢出闸门形成正反馈，必须限长。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { writeFileAtomic } from './atomic.js';

export const MEMORY_SCOPE = Object.freeze({
  WORKSPACE: 'workspace',
  SHARED: 'shared',
});

/** 相似度达到这个值视为"同一条记忆的新版本"，走 supersede 而不是新增。 */
export const SIMILARITY_THRESHOLD = 0.9;

/** 同一事实在这么多个不同工作区被独立确认后，自动升级到共享层。 */
export const PROMOTE_AFTER_WORKSPACES = 2;

export const PROMPT_BUDGET = Object.freeze({
  sharedBytes: 1024,
  workspaceBytes: 2048,
});

/**
 * 本地绑定信号：只要命中就强制归工作区，无视模型建议。
 * 这些信息离开当前机器/仓库就没有意义，放共享层只会误导别的项目。
 */
const LOCAL_BINDING_PATTERNS = [
  /(?:^|[\s("'`])[A-Za-z]:\\/, // C:\...
  /(?:^|[\s("'`])\/(?:usr|home|opt|var|etc|tmp|mnt|Users)\//, // POSIX 绝对路径
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\b/i,
  /\bport\s*\d{2,5}\b/i,
  /端口\s*\d{2,5}/,
  /\b[\w-]+\.(?:md|json|js|mjs|cjs|ts|py|sh|ps1|exe|toml|ya?ml)\b/i,
];

export function hasLocalBinding(text) {
  const s = String(text ?? '');
  return LOCAL_BINDING_PATTERNS.some((re) => re.test(s));
}

/**
 * 归属裁决。返回 { scope, reason }。
 *
 * 顺序很重要：先看客观信号（本地绑定），再看模型建议，最后保守落工作区。
 */
export function classifyScope({ text, suggested = 'unsure' } = {}) {
  if (hasLocalBinding(text)) {
    return { scope: MEMORY_SCOPE.WORKSPACE, reason: 'local_binding' };
  }
  if (suggested === MEMORY_SCOPE.SHARED) {
    return { scope: MEMORY_SCOPE.SHARED, reason: 'suggested_shared' };
  }
  return { scope: MEMORY_SCOPE.WORKSPACE, reason: 'default_workspace' };
}

/** 比较用的归一：小写、折叠空白、去标点。存储保留原文。 */
export function normalizeMemoryText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。、；：！？""''（）【】《》,.;:!?()[\]{}"'`]/g, '')
    .trim();
}

export function memoryId(text) {
  return crypto.createHash('sha256').update(normalizeMemoryText(text)).digest('hex').slice(0, 16);
}

function bigrams(s) {
  const out = new Set();
  if (!s) return out;
  if (s.length < 2) {
    out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** 字符二元组 Jaccard：中文和英文都能用，不依赖分词。 */
export function similarity(a, b) {
  const A = bigrams(normalizeMemoryText(a));
  const B = bigrams(normalizeMemoryText(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const numbersOf = (s) => new Set(String(s ?? '').match(/\d+(?:\.\d+)?/g) || []);

/**
 * 一条记忆被 query 覆盖的比例（0~1）：`|条目 ∩ query| / |条目|`。
 *
 * 为什么不用 Jaccard：Jaccard 会被 query 的长度稀释——用户消息动辄几十字，
 * 命中一条短记忆也会得到很低的分数，排序就失去区分度。这里测的是
 * “这条记忆有多少内容出现在当前问题里”，短记忆命中就是高分，符合直觉。
 *
 * @param {string} memoryText 记忆条目文本
 * @param {string} query      当前用户消息
 * @returns {number}
 */
export function relevance(memoryText, query) {
  const B = bigrams(normalizeMemoryText(memoryText));
  const A = bigrams(normalizeMemoryText(query));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of B) if (A.has(x)) inter += 1;
  return inter / B.size;
}

/**
 * 同一个事实的两个取值（端口 11434 vs 11435）：数字挖空后骨架完全相同、且没有共同数字。
 * 这种不能合并，也不能当新版本——两条都留，等用户裁决。
 * 不依赖相似度阈值，短文本也能判出来。
 */
function numbersConflict(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  const A = numbersOf(sa);
  const B = numbersOf(sb);
  if (A.size === 0 || B.size === 0) return false;
  if (sa.replace(/\d+(?:\.\d+)?/g, '#') !== sb.replace(/\d+(?:\.\d+)?/g, '#')) return false;
  for (const x of A) if (B.has(x)) return false;
  return true;
}

const byUpdatedDesc = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);

export class TypedMemoryStore {
  constructor({ rootDir, now = () => Date.now() } = {}) {
    if (!rootDir) throw new Error('rootDir required');
    this.rootDir = rootDir;
    this.now = now;
    this.file = path.join(rootDir, 'memory', 'typed.json');
    this.data = this.#load();
  }

  #load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!d || typeof d !== 'object' || !Array.isArray(d.entries)) {
        return { version: 1, entries: [] };
      }
      return d;
    } catch {
      return { version: 1, entries: [] };
    }
  }

  #flush() {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }

  #insert({ id, text, normalized, verdict, source, workspaceId, now }) {
    const entry = {
      id,
      text,
      normalized,
      scope: verdict.scope,
      scopeReason: verdict.reason,
      workspaceId: verdict.scope === MEMORY_SCOPE.WORKSPACE ? workspaceId : null,
      source,
      confirmedAt: now,
      updatedAt: now,
      supersedes: null,
      supersededBy: null,
      conflict: false,
    };
    this.data.entries.push(entry);
    return entry;
  }

  /** 同一事实在 >= 2 个不同工作区出现 -> 复制一条到共享层。 */
  #maybePromote(normalized) {
    const hits = new Set(
      this.data.entries
        .filter((e) => e.normalized === normalized && e.scope === MEMORY_SCOPE.WORKSPACE && e.workspaceId)
        .map((e) => e.workspaceId),
    );
    if (hits.size < PROMOTE_AFTER_WORKSPACES) return null;

    const already = this.data.entries.find(
      (e) => e.normalized === normalized && e.scope === MEMORY_SCOPE.SHARED && !e.supersededBy,
    );
    if (already) return { ok: true, code: 'already_promoted', id: already.id };

    const first = this.data.entries.find(
      (e) => e.normalized === normalized && e.scope === MEMORY_SCOPE.WORKSPACE && !e.supersededBy,
    );
    const now = this.now();
    const entry = this.#insert({
      id: memoryId(first?.text ?? ''),
      text: first?.text ?? '',
      normalized,
      verdict: { scope: MEMORY_SCOPE.SHARED, reason: 'promoted_from_workspaces' },
      source: 'promoted',
      workspaceId: null,
      now,
    });
    return { ok: true, code: 'promoted', id: entry.id, fromWorkspaces: [...hits] };
  }

  /**
   * @param {object} args
   * @param {string} args.text
   * @param {'workspace'|'shared'|'unsure'} [args.scope] 模型建议，仅作参考
   * @param {string} [args.workspaceId]
   * @param {string} [args.source]
   * @param {boolean} [args.confirmed] 必须是 true
   */
  propose({
    text,
    scope = 'unsure',
    workspaceId = null,
    source = 'model',
    confirmed = false,
  } = {}) {
    if (!confirmed) return { ok: false, code: 'confirm_required' };

    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, code: 'empty_text' };

    const verdict = classifyScope({ text: raw, suggested: scope });
    if (verdict.scope === MEMORY_SCOPE.WORKSPACE && !workspaceId) {
      return { ok: false, code: 'workspace_required' };
    }

    const normalized = normalizeMemoryText(raw);
    const id = memoryId(raw);
    const now = this.now();
    const sameBucket = (e) =>
      e.scope === verdict.scope &&
      (verdict.scope === MEMORY_SCOPE.SHARED || e.workspaceId === workspaceId);

    // 1) 完全相同：不新增，只刷新时间
    const exact = this.data.entries.find((e) => e.id === id && !e.supersededBy && sameBucket(e));
    if (exact) {
      exact.updatedAt = now;
      this.#flush();
      return {
        ok: true,
        code: 'deduped_exact',
        id: exact.id,
        scope: exact.scope,
        scopeReason: exact.scopeReason,
        entry: { ...exact },
      };
    }

    // 2) 同主语不同取值：先判冲突（按骨架，不靠相似度阈值）
    const conflicting = this.data.entries.find(
      (e) => !e.supersededBy && sameBucket(e) && numbersConflict(e.normalized, normalized),
    );
    if (conflicting) {
      const entry = this.#insert({ id, text: raw, normalized, verdict, source, workspaceId, now });
      entry.conflict = true;
      entry.conflictsWith = conflicting.id;
      conflicting.conflict = true;
      conflicting.conflictsWith = entry.id;
      this.#flush();
      return {
        ok: true,
        code: 'conflict_recorded',
        id: entry.id,
        scope: entry.scope,
        scopeReason: entry.scopeReason,
        conflictsWith: conflicting.id,
        entry: { ...entry },
      };
    }

    // 3) 高度相似：视为同一事实的新版本
    let best = null;
    for (const e of this.data.entries) {
      if (e.supersededBy || !sameBucket(e)) continue;
      const sim = similarity(e.normalized, normalized);
      if (sim >= SIMILARITY_THRESHOLD && (!best || sim > best.sim)) best = { entry: e, sim };
    }

    if (best) {
      const entry = this.#insert({ id, text: raw, normalized, verdict, source, workspaceId, now });
      entry.supersedes = best.entry.id;
      best.entry.supersededBy = entry.id;
      best.entry.updatedAt = now;
      this.#flush();
      return {
        ok: true,
        code: 'superseded',
        id: entry.id,
        scope: entry.scope,
        scopeReason: entry.scopeReason,
        supersedes: best.entry.id,
        entry: { ...entry },
      };
    }

    // 4) 全新的：插入，必要时尝试升级
    const entry = this.#insert({ id, text: raw, normalized, verdict, source, workspaceId, now });
    const promoted = verdict.scope === MEMORY_SCOPE.WORKSPACE ? this.#maybePromote(normalized) : null;
    this.#flush();
    return {
      ok: true,
      code: 'inserted',
      id: entry.id,
      scope: entry.scope,
      scopeReason: entry.scopeReason,
      promoted,
      entry: { ...entry },
    };
  }

  /** 有效条目：未被新版本取代。 */
  #active(scope, workspaceId = null) {    return this.data.entries.filter(
      (e) =>
        e.scope === scope &&
        !e.supersededBy &&
        (scope === MEMORY_SCOPE.SHARED || workspaceId === null || e.workspaceId === workspaceId),
    );
  }

  list({ scope = null, workspaceId = null, includeSuperseded = false } = {}) {
    return this.data.entries
      .filter((e) => (scope ? e.scope === scope : true))
      .filter((e) => (scope === MEMORY_SCOPE.WORKSPACE && workspaceId ? e.workspaceId === workspaceId : true))
      .filter((e) => (includeSuperseded ? true : !e.supersededBy))
      .sort(byUpdatedDesc)
      .map((e) => ({ ...e }));
  }

  get(id) {
    const e = this.data.entries.find((x) => x.id === id);
    return e ? { ...e } : null;
  }

  /**
   * 用户直接写入（来自 UI）。
   *
   * 与 `propose()` 的唯一区别：**归属听用户的**（他要放共享就放共享，要放本工作区就放本工作区），
   * 不再跑 `classifyScope`。理由：那条裁决是为了拦住模型的误判；用户是权威，
   * 而且 UI 里本来就分了两栏，再自作主张改归属只会让人困惑。
   *
   * 消重/取代/冲突语义与 `propose()` 完全一致，避免同一份数据两套规则。
   * @returns {{ok:boolean, code:string, id?:string, entry?:object}}
   */
  addUserEntry({ scope, workspaceId = null, text } = {}) {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, code: 'empty_text' };
    if (scope !== MEMORY_SCOPE.SHARED && scope !== MEMORY_SCOPE.WORKSPACE) {
      return { ok: false, code: 'bad_scope' };
    }
    if (scope === MEMORY_SCOPE.WORKSPACE && !workspaceId) {
      return { ok: false, code: 'workspace_required' };
    }

    const normalized = normalizeMemoryText(raw);
    const id = memoryId(raw);
    const now = this.now();
    const verdict = { scope, reason: 'user_selected' };
    const sameBucket = (e) =>
      e.scope === scope && (scope === MEMORY_SCOPE.SHARED || e.workspaceId === workspaceId);

    // 1) 完全相同：不新增，只刷新时间
    const exact = this.data.entries.find((e) => e.id === id && !e.supersededBy && sameBucket(e));
    if (exact) {
      exact.updatedAt = now;
      this.#flush();
      return { ok: true, code: 'deduped_exact', id: exact.id, entry: { ...exact } };
    }

    // 2) 同骨架不同取值：两条都留，互标冲突，等用户裁决
    const conflicting = this.data.entries.find(
      (e) => !e.supersededBy && sameBucket(e) && numbersConflict(e.normalized, normalized),
    );
    if (conflicting) {
      const entry = this.#insert({ id, text: raw, normalized, verdict, source: 'user', workspaceId, now });
      entry.author = 'user';
      entry.conflict = true;
      entry.conflictsWith = conflicting.id;
      conflicting.conflict = true;
      conflicting.conflictsWith = entry.id;
      conflicting.updatedAt = now;
      this.#flush();
      return { ok: true, code: 'conflict_recorded', id: entry.id, conflictsWith: conflicting.id, entry: { ...entry } };
    }

    // 3) 高度相似：作为同一事实的新版本取代旧条目（旧条目不删，只标记）
    let best = null;
    for (const e of this.data.entries) {
      if (e.supersededBy || !sameBucket(e)) continue;
      const sim = similarity(e.normalized, normalized);
      if (sim >= SIMILARITY_THRESHOLD && (!best || sim > best.sim)) best = { entry: e, sim };
    }
    if (best) {
      const entry = this.#insert({ id, text: raw, normalized, verdict, source: 'user', workspaceId, now });
      entry.author = 'user';
      entry.supersedes = best.entry.id;
      best.entry.supersededBy = entry.id;
      best.entry.updatedAt = now;
      this.#flush();
      return { ok: true, code: 'superseded', id: entry.id, supersedes: best.entry.id, entry: { ...entry } };
    }

    // 4) 全新条目（用户手动写入不触发跨工作区自动升级：那是"模型提议"链路的规则）
    const entry = this.#insert({ id, text: raw, normalized, verdict, source: 'user', workspaceId, now });
    entry.author = 'user';
    this.#flush();
    return { ok: true, code: 'inserted', id: entry.id, entry: { ...entry } };
  }

  /**
   * 删除一条记忆（只给 UI 用，模型没有入口）。
   *
   * 删掉“新版本”时把被它取代的旧版本恢复回来；删除时顺手清掉指向它的冲突标记，
   * 免得留下一条永远隐藏的孤儿。
   */
  removeEntry(id, { confirmed = false } = {}) {
    if (!confirmed) return { ok: false, code: 'confirm_required' };
    const index = this.data.entries.findIndex((e) => e.id === id);
    if (index < 0) return { ok: false, code: 'not_found' };

    const [entry] = this.data.entries.splice(index, 1);
    let restored = null;
    if (entry.supersedes) {
      const previous = this.data.entries.find((e) => e.id === entry.supersedes);
      if (previous) {
        previous.supersededBy = null;
        previous.updatedAt = this.now();
        restored = previous.id;
      }
    }
    for (const e of this.data.entries) {
      if (e.conflictsWith === entry.id) {
        e.conflict = false;
        e.conflictsWith = null;
      }
    }
    this.#flush();
    return { ok: true, code: 'removed', id, restored };
  }

  #renderBlock(title, entries, maxBytes) {
    const lines = [];
    let used = 0;
    let truncated = 0;
    for (const e of entries) {
      const line = `- ${e.text}`;
      const cost = Buffer.byteLength(line, 'utf8') + 1;
      if (used + cost > maxBytes) {
        truncated += 1;
        continue;
      }
      used += cost;
      lines.push(line);
    }
    if (lines.length === 0) return { text: '', truncated, total: entries.length };
    return { text: `## ${title}（${lines.length} 条）\n${lines.join('\n')}`, truncated, total: entries.length };
  }

  /**
   * 渲染成注入 systemPrompt 的文本。预算硬上限，超出的丢弃并计数（不静默丢）。
   *
   * @param {object} [options]
   * @param {string|null} [options.workspaceId]
   * @param {string|null} [options.query] 当前用户消息；给了就按相关度排序，
   *   没给就保持“最新的在前”。**不相关的条目不会丢**——它们排在后面，
   *   预算还有空间就照样注入（新记忆往往就是接下来要用的）。
   * @returns {{text:string, truncated:number, dropped:{shared:number, workspace:number},
   *            counts:{shared:number, workspace:number}, ranked:boolean}}
   */
  render({ workspaceId = null, maxSharedBytes, maxWorkspaceBytes, query = null } = {}) {
    const ranked = typeof query === 'string' && query.trim() !== '';
    const order = (list) => {
      if (!ranked) return list.sort(byUpdatedDesc);
      const scored = list.map((entry) => ({ entry, score: relevance(entry.normalized, query) }));
      scored.sort((a, b) => b.score - a.score || byUpdatedDesc(a.entry, b.entry));
      return scored.map((item) => item.entry);
    };

    const shared = order(this.#active(MEMORY_SCOPE.SHARED));
    const workspace = workspaceId ? order(this.#active(MEMORY_SCOPE.WORKSPACE, workspaceId)) : [];

    const s = this.#renderBlock(
      '共享记忆',
      shared,
      maxSharedBytes ?? PROMPT_BUDGET.sharedBytes,
    );
    const w = workspaceId
      ? this.#renderBlock('本工作区记忆', workspace, maxWorkspaceBytes ?? PROMPT_BUDGET.workspaceBytes)
      : { text: '', truncated: 0, total: 0 };

    return {
      text: [s.text, w.text].filter(Boolean).join('\n\n'),
      truncated: s.truncated + w.truncated,
      dropped: { shared: s.truncated, workspace: w.truncated },
      counts: { shared: shared.length, workspace: workspace.length },
      ranked,
    };
  }
}
