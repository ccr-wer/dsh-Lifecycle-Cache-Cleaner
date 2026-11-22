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
import zlib from 'node:zlib';

/** 会话目录名与 id 的形状，顺带挡掉 `../` 这类路径穿越。 */
const SESSION_ID = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;
const SESSION_DIR = /^session-(.+)$/;
const SESSION_LOG = /^session\..*\.jsonl(\.zstd)?$/;

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

// ---------------------------------------------------------------- 会话标题

/**
 * 标题不在 header 里，而是会话日志中的 `session/title` 事件（`data.title`）。
 * 日志是 zstd 帧拼接（每帧一段 JSONL），所以要按帧解，不能整段一次解。
 *
 * 取法：看最早几帧（首轮生成的标题）+ 最后几帧（可能被重新生成过），取 seq 最大的那个。
 * 结果按“文件 + 大小 + mtime”缓存，列表刷新时不会反复解压同一个文件。
 */
const TITLE_CACHE = new Map();
const TITLE_CACHE_MAX = 256;
const HEAD_MAX_BYTES = 1024 * 1024;
const TAIL_FRAMES = 24;
const PLAIN_TAIL_BYTES = 256 * 1024;

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function findSessionLog(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries.filter((entry) => entry.isFile() && SESSION_LOG.test(entry.name)).map((entry) => entry.name);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const az = a.endsWith('.zstd') ? 0 : 1;
    const bz = b.endsWith('.zstd') ? 0 : 1;
    return az - bz || a.localeCompare(b);
  });
  return path.join(dir, candidates[0]);
}

/** 从一段 JSONL 文本里找最新的标题；找不到返回 null。 */
function titleFromJsonl(text) {
  let best = null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line === '' || line.indexOf('session/title') === -1) continue;
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== 'session/title') continue;
    const title = typeof record?.data?.title === 'string' ? record.data.title.trim() : '';
    if (title === '') continue;
    const seq = Number(record.seq) || 0;
    if (!best || seq > best.seq) best = { seq, title };
  }
  return best;
}

/** 按 zstd 帧切分后解压指定帧（帧用魔数定位；拼接日志的常见形态）。 */
function decodeZstdFrames(buf) {
  const offsets = [];
  let at = 0;
  while ((at = buf.indexOf(ZSTD_MAGIC, at)) !== -1) {
    offsets.push(at);
    at += ZSTD_MAGIC.length;
  }
  return offsets.map((start, index) => {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buf.length;
    try {
      return zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch {
      return '';
    }
  });
}

function readTitleFromFile(file) {
  const st = statSafe(file);
  if (!st) return '';
  const cached = TITLE_CACHE.get(file);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.title;

  let title = '';
  try {
    if (file.endsWith('.zstd')) {
      const buf = fs.readFileSync(file);
      const frames = decodeZstdFrames(buf);
      let best = null;
      // 前段：标题通常在首轮对话附近（本机实测在第 7 帧，不在第 0 帧），
      // 所以按“累计解压字节”推进，而不是固定帧数；找到就停，最多 1MB。
      let scanned = 0;
      for (let i = 0; i < frames.length && scanned < HEAD_MAX_BYTES; i += 1) {
        scanned += frames[i].length;
        const found = titleFromJsonl(frames[i]);
        if (found && (!best || found.seq > best.seq)) best = found;
        if (best) break;
      }
      // 后段：标题可能被重新生成过，取 seq 更大的那个。
      for (let i = Math.max(0, frames.length - TAIL_FRAMES); i < frames.length; i += 1) {
        const found = titleFromJsonl(frames[i]);
        if (found && (!best || found.seq > best.seq)) best = found;
      }
      title = best?.title ?? '';
    } else {
      const fd = fs.openSync(file, 'r');
      try {
        const length = Math.min(st.size, PLAIN_TAIL_BYTES);
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, st.size - length);
        title = titleFromJsonl(buf.toString('utf8'))?.title ?? '';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    title = '';
  }

  if (TITLE_CACHE.size >= TITLE_CACHE_MAX) {
    const oldest = TITLE_CACHE.keys().next().value;
    if (oldest !== undefined) TITLE_CACHE.delete(oldest);
  }
  TITLE_CACHE.set(file, { size: st.size, mtimeMs: st.mtimeMs, title });
  return title;
}

/** 读一个会话目录的标题；读不到返回空串（调用方自己决定用什么兜底）。 */
export function readSessionTitle(dir) {
  const log = findSessionLog(dir);
  if (!log) return '';
  return readTitleFromFile(log);
}

/**
 * 删掉该会话的投影缓存文件（`<rootDir>/storages/session_projcache/sessions/session-<id>.json`）。
 *
 * 留着它不会报错，但宿主重开时会拿旧缓存去拼一个已经不存在的会话；
 * 会话管理器当年也做这一步。文件名必须精确匹配，避免误删别人的缓存。
 * @returns {boolean} 是否真的删掉了
 */
export function removeProjectionCache(rootDir, sessionId) {
  if (!rootDir || !isValidSessionId(sessionId)) return false;
  const file = path.join(rootDir, 'storages', 'session_projcache', 'sessions', `session-${sessionId}.json`);
  try {
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
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
        title: readSessionTitle(dir),
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
      title: readSessionTitle(real),
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
    session: { id: session.id, workspaceKey: session.workspaceKey, key: session.key, title: session.title ?? '' },
  };
}
