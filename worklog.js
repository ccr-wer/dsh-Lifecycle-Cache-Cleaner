/**
 * 工作日志：解析 / 渲染 / L5 校验 / 原子提交。
 *
 * 三条硬规则：
 *  1) ID 由程序分配。模型只能给 `{status, text, ref_id?}`，任何自带的 id 一律丢弃。
 *  2) 否定信息独立成 `## negations`，程序只追加，模型碰不到。
 *  3) L5 是数据结构校验（状态迁移白名单 + 差分白名单 + 实体 Jaccard），不是软检查。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { renameWithRetry } from './lib/core/atomic.js';

export const STATUS = Object.freeze({
  TODO: 'todo',
  DONE: 'done',
  DECISION: 'decision',
  DROPPED: 'dropped',
});

const STATUS_VALUES = new Set(Object.values(STATUS));

/** 状态迁移白名单。dropped 是终态（只进不出），done 不可回退到 todo。 */
const ALLOWED_TRANSITIONS = {
  [STATUS.TODO]: [STATUS.TODO, STATUS.DONE, STATUS.DROPPED],
  [STATUS.DONE]: [STATUS.DONE, STATUS.DROPPED],
  [STATUS.DECISION]: [STATUS.DECISION, STATUS.DROPPED],
  [STATUS.DROPPED]: [STATUS.DROPPED],
};

export const DEFAULT_LIMITS = {
  droppedRatioLimit: 0.3,
  entityJaccardMin: 0.6,
  entryJaccardMin: 0.5,
};

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const numOf = (id) => Number(String(id).replace(/[^\d]/g, '')) || 0;
/** 否定信息行形如 `[N7] L3: ...`，只能取行首编号，不能把正文里的数字也算进来。 */
const negNumOf = (line) => {
  const m = /^\s*\[N(\d+)\]/.exec(String(line ?? ''));
  return m ? Number(m[1]) : 0;
};

/* ------------------------------------------------------------------ 模型输出 */

/** 解析模型产出。只接受 {status, text, ref_id?}，自带 id 一律丢弃。 */
export function parseModelEntries(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('empty summary');
  let body = raw.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1].trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('no JSON array in summary');
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    throw new Error(`invalid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty entry list');

  return parsed.map((e, i) => {
    if (!e || typeof e !== 'object') throw new Error(`entry #${i} not an object`);
    const status = String(e.status || '').toLowerCase();
    if (!STATUS_VALUES.has(status)) throw new Error(`entry #${i} bad status: ${e.status}`);
    const text = norm(e.text);
    if (!text) throw new Error(`entry #${i} empty text`);
    const out = { status, text };
    if (e.ref_id) out.ref_id = String(e.ref_id).trim();
    // 故意不拷贝 e.id —— 模型不碰 ID
    return out;
  });
}

/** 按 ref_id 回填 ID；无 ref_id 或 ref_id 不存在 -> 程序发新号。 */
export function assignIds(entries, prevEntries = []) {
  let max = prevEntries.reduce((m, e) => Math.max(m, numOf(e.id)), 0);
  const known = new Set(prevEntries.map((e) => e.id));
  return entries.map((e) => {
    const reuse = e.ref_id && known.has(e.ref_id) ? e.ref_id : null;
    if (reuse) return { id: reuse, status: e.status, text: norm(e.text) };
    max += 1;
    return { id: `L${max}`, status: e.status, text: norm(e.text) };
  });
}

/* ------------------------------------------------------------------ 渲染解析 */

// 注意：调用处已剥掉行首的 "- "，这里不能再要求 '-'（否则日志永远回读为空、L5 全部失效）
const ENTRY_RE = /^([A-Za-z]*\d+)\s+\[(\w+)\]\s*(.*)$/;

export function renderWorklog({ sessionId, goal = '', entries = [], negations = [], rawTrace = '' }) {
  const lines = [`# Worklog · ${sessionId}`, '', '## goal', goal || '-', '', '## entries'];
  for (const e of entries) lines.push(`- ${e.id} [${e.status}] ${e.text}`);
  lines.push('', '## negations');
  if (negations.length === 0) lines.push('- (none)');
  else for (const n of negations) lines.push(`- ${n}`);
  lines.push('', '## 原始轨迹');
  if (rawTrace.trim()) lines.push(rawTrace.replace(/\s+$/, ''));
  return `${lines.join('\n')}\n`;
}

export function parseWorklog(md) {
  const out = { goal: '', entries: [], negations: [] };
  if (!md) return out;
  const sections = {};
  let current = null;
  for (const line of md.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      current = h[1];
      sections[current] = sections[current] || [];
      continue;
    }
    if (current && line.startsWith('- ')) sections[current].push(line.slice(2));
  }
  out.goal = (sections.goal || []).join(' ').trim();
  for (const item of sections.entries || []) {
    const m = item.match(ENTRY_RE);
    if (m) out.entries.push({ id: m[1], status: m[2], text: norm(m[3]) });
  }
  out.negations = (sections.negations || []).filter((x) => x.trim() && x.trim() !== '(none)');
  return out;
}

/* ------------------------------------------------------------------ L5 校验 */

const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'not', 'are', 'was', 'but', 'from',
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '对', '从',
  '被', '把', '让', '使', '等', '一个', '我们', '你', '我', '它', '这', '那', '有',
  '不', '要', '会', '可以', '需要', '然后', '因为', '所以', '但是', '如果', '已经',
]);

/** 实体集合：拉丁标识/路径、数字、CJK 片段。用于抓「措辞保留、事实被删」。 */
export function extractEntities(text) {
  const out = new Set();
  const s = String(text || '');
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_./-]{2,}/g)) {
    const w = m[0].toLowerCase();
    if (!STOP.has(w)) out.add(w);
  }
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) out.add(m[0]);
  for (const m of s.matchAll(/[\u4e00-\u9fff]{2,6}/g)) {
    if (!STOP.has(m[0])) out.add(m[0]);
  }
  return out;
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a || []);
  const B = b instanceof Set ? b : new Set(b || []);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const docEntities = (doc) =>
  extractEntities(
    [doc.goal, ...doc.entries.map((e) => e.text), ...doc.negations].join('\n'),
  );

/**
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function validateWorklog({ prev, next, limits = {} }) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const reasons = [];
  const prevMap = new Map((prev.entries || []).map((e) => [e.id, e]));
  const nextMap = new Map((next.entries || []).map((e) => [e.id, e]));
  const prevCount = (prev.entries || []).length;

  // 1) 条目不得消失（合并攻击在这里被拦）
  for (const p of prev.entries || []) {
    if (!nextMap.has(p.id)) reasons.push(`entry_vanished:${p.id}`);
  }

  // 2) 状态迁移白名单 + 差分白名单
  for (const [id, p] of prevMap) {
    const n = nextMap.get(id);
    if (!n) continue;
    const allowed = ALLOWED_TRANSITIONS[p.status] || [];
    if (!allowed.includes(n.status)) {
      reasons.push(`illegal_transition:${id}:${p.status}->${n.status}`);
      continue;
    }
    if (p.status === n.status) {
      // 同状态改写文本 = 偷改历史，一律拒
      if (norm(p.text) !== norm(n.text)) reasons.push(`diff_not_allowed:${id}`);
    } else {
      // 状态推进允许改写，但实体相似度不得塌
      const sim = jaccard(extractEntities(p.text), extractEntities(n.text));
      if (sim < L.entryJaccardMin) reasons.push(`entry_rewritten:${id}`);
    }
  }

  // 3) dropped 必须带 reason
  for (const [id, p] of prevMap) {
    const n = nextMap.get(id);
    if (!n) continue;
    if (p.status !== STATUS.DROPPED && n.status === STATUS.DROPPED) {
      if (!/reason\s*[:：]/i.test(n.text)) reasons.push(`dropped_without_reason:${id}`);
    }
  }

  // 4) 实体集合坍缩（首次固化无旧条目可比，不适用）
  if (prevCount > 0 && jaccard(docEntities(prev), docEntities(next)) < L.entityJaccardMin) {
    reasons.push('entity_collapse');
  }

  // 5) 批量 drop = 信息坍缩
  if (prevCount > 0) {
    let newlyDropped = 0;
    for (const p of prev.entries) {
      const n = nextMap.get(p.id);
      if (n && p.status !== STATUS.DROPPED && n.status === STATUS.DROPPED) newlyDropped += 1;
    }
    if (newlyDropped / prevCount > L.droppedRatioLimit) reasons.push('negation_collapse');
  }

  return { ok: reasons.length === 0, reasons };
}

/** 否定信息：程序只追加。 */
export function mergeNegations(prevNegations = [], prevEntries = [], nextEntries = []) {
  const out = [...prevNegations];
  let k = out.reduce((m, n) => Math.max(m, negNumOf(n)), 0);
  const prevMap = new Map((prevEntries || []).map((e) => [e.id, e]));
  for (const n of nextEntries || []) {
    if (n.status !== STATUS.DROPPED) continue;
    const p = prevMap.get(n.id);
    if (!p || p.status === STATUS.DROPPED) continue;
    k += 1;
    out.push(`[N${k}] ${n.id}: ${n.text}`);
  }
  return out;
}

/* ------------------------------------------------------------------ L6 提交 */

/**
 * 原子提交：tmp 已写好 -> 备份 -> rename -> 回读校验 sha256。
 * 任一环节失败抛错，调用方必须视为「未提交」。
 */
export function commitAtomic({ tmpPath, finalPath, backupPath }) {
  const buf = fs.readFileSync(tmpPath);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (backupPath) {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(tmpPath, backupPath);
  }
  renameWithRetry(tmpPath, finalPath);
  const readback = crypto.createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex');
  if (readback !== sha) throw new Error('commit verify failed: checksum mismatch');
  return { sha, bytes: buf.length };
}
