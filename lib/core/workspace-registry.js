/**
 * 工作区 → 会话索引。
 *
 * 存在的唯一理由：回答"这个工作区还有没有活着的会话"。
 * 没有它，孤儿判定就是猜的（旧索引只增不删会把所有工作区都判成"还有会话"）。
 *
 * 纪律：
 *  - 会话建立时 noteSession，删除成功后 markDeleted。
 *  - 只记录事实，不做任何清理决策。
 */
import fs from 'node:fs';
import path from 'node:path';

const nowDefault = () => Date.now();
const empty = () => ({ version: 1, workspaces: {} });

export class WorkspaceRegistry {
  constructor({ file = null, now = nowDefault } = {}) {
    this.file = file;
    this.now = now;
    this.data = file && fs.existsSync(file) ? readJson(file) : empty();
  }

  noteSession(workspaceId, sessionId) {
    if (!workspaceId || !sessionId) return { ok: false, code: 'bad_args' };
    const t = this.now();
    const ws = this.data.workspaces[workspaceId] || {
      workspaceId,
      firstSeen: t,
      lastSeenAt: t,
      sessions: {},
    };
    const s = ws.sessions[sessionId] || {
      sessionId,
      firstSeen: t,
      lastSeenAt: t,
      state: 'live',
    };
    if (s.state === 'deleted') return { ok: false, code: 'session_already_deleted' };
    s.lastSeenAt = t;
    ws.sessions[sessionId] = s;
    ws.lastSeenAt = t;
    this.data.workspaces[workspaceId] = ws;
    this.#flush();
    return { ok: true, code: 'noted', workspaceId };
  }

  markDeleted(sessionId) {
    const workspaceId = this.workspaceOf(sessionId);
    if (!workspaceId) return { ok: false, code: 'unknown_session' };
    const ws = this.data.workspaces[workspaceId];
    const s = ws.sessions[sessionId];
    if (s.state === 'deleted') return { ok: true, code: 'already_deleted', workspaceId };
    const t = this.now();
    s.state = 'deleted';
    s.deletedAt = t;
    s.lastSeenAt = t;
    ws.lastSeenAt = t;
    this.#flush();
    return { ok: true, code: 'deleted', workspaceId };
  }

  workspaceOf(sessionId) {
    for (const [id, ws] of Object.entries(this.data.workspaces)) {
      if (ws.sessions?.[sessionId]) return id;
    }
    return null;
  }

  liveSessions(workspaceId) {
    const ws = this.data.workspaces[workspaceId];
    if (!ws) return [];
    return Object.values(ws.sessions || {})
      .filter((s) => s.state === 'live')
      .map((s) => s.sessionId);
  }

  allSessions(workspaceId) {
    const ws = this.data.workspaces[workspaceId];
    if (!ws) return [];
    return Object.values(ws.sessions || {});
  }

  lastActivityAt(workspaceId) {
    const ws = this.data.workspaces[workspaceId];
    if (!ws) return null;
    const stamps = [ws.firstSeen, ws.lastSeenAt, ...this.allSessions(workspaceId).map((s) => s.lastSeenAt)];
    return Math.max(...stamps.filter((n) => Number.isFinite(n)));
  }

  list() {
    return Object.values(this.data.workspaces || {}).map((ws) => ({
      workspaceId: ws.workspaceId,
      firstSeen: ws.firstSeen,
      lastSeenAt: ws.lastSeenAt,
      sessionCount: Object.keys(ws.sessions || {}).length,
    }));
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
    return d && typeof d === 'object' && d.workspaces ? d : empty();
  } catch {
    return empty();
  }
}
