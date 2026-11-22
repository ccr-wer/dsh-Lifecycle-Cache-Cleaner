/**
 * 会话目录的只读清单与“移到回收站”。
 *
 * 宿主没有删除会话的 API（`@deepseek-ai/dsh-session` 里没有 remove/delete，
 * ACP 的 `session_delete` 是另一套协议，与本仓库无关），
 * 所以删除只能落在文件系统上——`dsh-session-manager` 也是直接 rm 目录。
 *
 * 这里刻意和 `rm -rf` 不同：
 *   1. **只移动，不删除**：会话目录整段 rename 到 `<rootDir>/lifecycle-cache/trash/`，
 *      后悔时把目录搬回去即可，不需要数据恢复工具。
 *   2. **拒绝当前会话**：正在用的会话由 UI 传 `currentSessionId` 过来，直接拒；
 *      文件被占用（Windows 上 rename 会 EPERM/EBUSY）同样拒绝，不硬来。
 *   3. **路径收敛**：id 只接受 uuid 形状，目标目录必须真的在 sessions 根下。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 会话目录名与 id 的形状，顺带挡掉 `../` 这类路径穿越。 */
const SESSION_ID = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;
const SESSION_DIR = /^session-(.+)$/;

export function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID.test(id);
}

/** 相对 sessions 根的一条路径（`<workspace>/session-<id>`），与 SessionWatcher 的口径一致。 */
export function sessionKeyOf(workspaceKey, id) {
  return `${workspaceKey}/session-${id}`;
}

function statSafe(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/** 目录里最新的写入时间与总字节数；坏文件不参与，也不抛。 */
function describeDir(dir) {
  let updatedAt = 0;
  let bytes = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { updatedAt: 0, bytes: 0, files: 0 };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const st = statSafe(path.join(dir, entry.name));
    if (!st) continue;
    bytes += st.size;
    if (st.mtimeMs > updatedAt) updatedAt = st.mtimeMs;
  }
  return { updatedAt, bytes, files: entries.length };
}

/**
 * 列出全部会话。只读：不创建、不修复任何东西。
 * @param {string} sessionsDir 例如 `<rootDir>/sessions`
 */
export function listSessions(sessionsDir) {
  const out = [];
  if (!sessionsDir) return out;
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(sessionsDir, workspace.name);
    let entries = [];
    try {
      entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = SESSION_DIR.exec(entry.name);
      if (!match || !isValidSessionId(match[1])) continue;
      const dir = path.join(workspaceDir, entry.name);
      const info = describeDir(dir);
      out.push({
        id: match[1],
        workspaceKey: workspace.name,
        key: sessionKeyOf(workspace.name, match[1]),
        updatedAt: info.updatedAt,
        bytes: info.bytes,
        files: info.files,
      });
    }
  }
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return out;
}

/**
 * 把 id 收敛到一个真实存在、且确实位于 sessions 根下的目录。
 * @returns {{id:string, workspaceKey:string, key:string, dir:string, updatedAt:number, bytes:number}|null}
 */
export function resolveSession(sessionsDir, id) {
  if (!sessionsDir || !isValidSessionId(id)) return null;
  const root = path.resolve(sessionsDir);
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const dir = path.join(root, workspace.name, `session-${id}`);
    const st = statSafe(dir);
    if (!st || !st.isDirectory()) continue;
    const real = path.resolve(dir);
    if (!real.startsWith(root + path.sep)) continue;
    const info = describeDir(real);
    return {
      id,
      workspaceKey: workspace.name,
      key: sessionKeyOf(workspace.name, id),
      dir: real,
      updatedAt: info.updatedAt,
      bytes: info.bytes,
    };
  }
  return null;
}

/**
 * 删除 = 移到回收站。成功返回回收站路径（可以原样搬回去）。
 *
 * @param {object} options
 * @param {string} options.sessionsDir
 * @param {string} options.trashDir   `<rootDir>/lifecycle-cache/trash`
 * @param {string} options.id
 * @param {string|null} [options.currentSessionId] 当前打开的会话，拒绝删
 * @param {number} [options.minIdleMs] 最近这么多毫秒内有写入就拒绝（默认 0 = 不判）
 * @returns {Promise<{moved:boolean, code:string, reason:string, trashPath?:string, session?:object}>}
 */
export async function trashSession({ sessionsDir, trashDir, id, currentSessionId = null, minIdleMs = 0 } = {}) {
  if (!isValidSessionId(id)) {
    return { moved: false, code: 'invalid_id', reason: '会话 id 形状不合法。' };
  }
  if (currentSessionId && currentSessionId === id) {
    return { moved: false, code: 'is_current', reason: '这是当前正在使用的会话，不做删除。' };
  }
  const session = resolveSession(sessionsDir, id);
  if (!session) {
    return { moved: false, code: 'not_found', reason: '找不到这个会话目录（可能已经被删掉了）。' };
  }
  if (minIdleMs > 0 && session.updatedAt > 0 && Date.now() - session.updatedAt < minIdleMs) {
    return {
      moved: false,
      code: 'busy',
      reason: `该会话最近 ${Math.round(minIdleMs / 1000)} 秒内有写入，可能仍在使用，没有删除。`,
    };
  }
  if (!trashDir) {
    return { moved: false, code: 'no_trash', reason: '缺少回收站目录配置。' };
  }

  await fsp.mkdir(trashDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(trashDir, `${stamp}__${session.workspaceKey}__session-${id}`);

  try {
    await fsp.rename(session.dir, target);
  } catch (err) {
    const code = err?.code ?? '';
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      return { moved: false, code: 'busy', reason: '会话文件正被占用（多半是正在运行的会话），没有删除。' };
    }
    if (code === 'ENOENT') {
      return { moved: false, code: 'not_found', reason: '会话目录在删除过程中消失了。' };
    }
    return { moved: false, code: 'io_error', reason: `移动失败：${err?.message ?? err}` };
  }

  return {
    moved: true,
    code: 'trashed',
    reason: '已移到回收站，可原样搬回。',
    trashPath: target,
    session: { id: session.id, workspaceKey: session.workspaceKey, key: session.key },
  };
}
