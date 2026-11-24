/**
 * Host 侧的 HTTP 面：插件页的 UI 与「会话」面板都用这几条接口。
 *
 * 为什么不是 Remote：宿主的 `ai-api-remotes` 在构建期就固定了能力集合
 * （README：「The capability set is fixed by explicit build-time value imports;
 * the Client does not discover the Host's active Services or Remote definitions
 * at runtime」），第三方组合包加不进一个新的命名空间。第三方的做法是
 * `ctx.webServer.register()` 注册一条 prefix 路由，客户端同源 fetch——
 * `dsh-session-manager` 的 `/session-manager/api` 就是这么做的。
 *
 * 这里**只做传输**：状态与释放都转给 `runtime.status()` / `runtime.clean()`，
 * 会话删除转给 `session-store.js`（移到回收站，不 rm）。
 * 闸门语义仍然只有一份（`lib/core/release-gate.js`），UI 不在浏览器里重算。
 */
import { SKIP_REASON } from './runtime.js';
import { listSessions, trashSession, removeProjectionCache } from './session-store.js';
import { STYLE_IDS } from './profile-store.js';

/** 路由前缀。与客户端 `client.js` 里的 API 常量必须一致。 */
export const ROUTE_BASE = '/lifecycle-cache/api';

const MAX_BODY_BYTES = 8 * 1024;

/** 记忆写入/删除的错误码 → 给 UI 看的说明。 */
const MEMORY_ERROR_TEXT = Object.freeze({
  empty_text: '内容不能为空。',
  bad_scope: '归属只能是 shared 或 workspace。',
  workspace_required: '写工作区记忆需要当前工作区。',
  not_found: '找不到这条记忆（可能已经被删了）。',
  confirm_required: '删除需要 confirm: true。',
  memory_absent: '本工作区还没有记忆文档。',
});

/**
 * 注册路由，返回卸载函数。
 * @param {object} options
 * @param {HostRuntime} options.runtime
 * @param {{register: Function}} options.webServer
 * @param {{admit: Function}|undefined} options.connection
 * @param {string} [options.basePath]
 * @param {string} [options.sessionsDir] 会话根目录（`<rootDir>/sessions`）
 * @param {string} [options.trashDir]    回收站目录（`<rootDir>/lifecycle-cache/trash`）
 * @param {number} [options.minIdleMs]   会话最近有写入就拒绝删除的窗口
 * @param {ProfileStore} [options.profileStore] 用户设定（称呼 / 名字 / 风格 / 指令 / 人设）
 * @param {Function} [options.listWorkspaces] 返回宿主的 [{id, path, title}]，记忆面板据此自动建组
 * @param {string} [options.rootDir]      DSH 数据根（清投影缓存用）
 * @param {object} [options.workspaceHooks] 宿主工作区索引钩子：listIndex() / detachSession(id)
 */
export function registerWebApi({
  runtime,
  webServer,
  connection,
  basePath = ROUTE_BASE,
  sessionsDir = null,
  trashDir = null,
  minIdleMs = 0,
  profileStore = null,
  listWorkspaces = () => [],
  rootDir = null,
  workspaceHooks = null,
} = {}) {
  if (!webServer || typeof webServer.register !== 'function') return () => {};
  if (!runtime) throw new Error('registerWebApi: runtime required');
  const route = {
    kind: 'prefix',
    path: basePath,
    handler: (req, res) =>
      handle({ runtime, connection, basePath, sessionsDir, trashDir, minIdleMs, profileStore, listWorkspaces, rootDir, workspaceHooks, req, res }),
  };
  const dispose = webServer.register(route);
  return () => {
    try {
      dispose?.();
    } catch {
      /* 卸载失败不该让插件停不下来 */
    }
  };
}

/**
 * 一条请求的完整处理：认证 → 路由 → runtime / session-store。
 * 任何异常都收敛成 JSON，宁可回 500 也不要让宿主路由抛。
 */
async function handle({ runtime, connection, basePath, sessionsDir, trashDir, minIdleMs, profileStore, listWorkspaces, rootDir, workspaceHooks, req, res }) {
  const auth = admit(req, connection);
  if (!auth.ok) return send(res, auth.status, { ok: false, code: auth.code, error: auth.message });

  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.startsWith(basePath)
    ? url.pathname.slice(basePath.length) || '/'
    : '/';

  try {
    if (req.method === 'GET' && path === '/status') {
      return send(res, 200, { ok: true, result: publicStatus(await runtime.status()) });
    }
    if (req.method === 'POST' && path === '/clean') {
      const body = await readJson(req);
      if (body.error) return send(res, 400, { ok: false, code: 'bad_request', error: body.error });
      const result = await runtime.clean({ confirm: body.value?.confirm === true, trigger: 'manual' });
      return send(res, 200, { ok: true, result });
    }
    if (req.method === 'GET' && path === '/sessions') {
      if (!sessionsDir) return send(res, 503, { ok: false, code: 'sessions_unavailable', error: '宿主没给出会话目录。' });
      const sessions = listSessions(sessionsDir).map(publicSession);
      // 宿主工作区索引里仍然记着、但目录已经不在的会话：导航页会显示它们，
      // 点进去就是 `session/not-found`。列出来让用户一键摘掉（D30）。
      const orphans = collectOrphans(sessionsDir, safeIndex(workspaceHooks));
      return send(res, 200, { ok: true, result: { sessions, minIdleMs, orphans } });
    }
    if (req.method === 'POST' && path === '/sessions/repair') {
      if (!workspaceHooks || typeof workspaceHooks.detachSession !== 'function') {
        return send(res, 503, { ok: false, code: 'workspace_unavailable', error: '宿主没有工作区索引，无法清理失效记录。' });
      }
      const orphans = collectOrphans(sessionsDir, safeIndex(workspaceHooks));
      const detached = [];
      for (const orphan of orphans) {
        try {
          await workspaceHooks.detachSession(orphan.id);
          detached.push(orphan.id);
        } catch (err) {
          runtime.diagnostics.push(`detach ${orphan.id}: ${err?.message ?? err}`);
        }
      }
      return send(res, 200, { ok: true, result: { detached, remaining: orphans.length - detached.length } });
    }
    if (req.method === 'POST' && path === '/sessions/delete') {
      const body = await readJson(req);
      if (body.error) return send(res, 400, { ok: false, code: 'bad_request', error: body.error });
      if (!sessionsDir || !trashDir) {
        return send(res, 503, { ok: false, code: 'sessions_unavailable', error: '宿主没给出会话目录或回收站目录。' });
      }
      if (body.value?.confirm !== true) {
        return send(res, 400, {
          ok: false,
          code: 'confirm_required',
          error: '删除需要 confirm: true。',
        });
      }
      const result = await trashSession({
        sessionsDir,
        trashDir,
        id: body.value?.id,
        currentSessionId: typeof body.value?.currentSessionId === 'string' ? body.value.currentSessionId : null,
        minIdleMs,
      });
      if (result.moved && result.session?.key) {
        // 目录已经搬走，相当于“会话被删除”：立刻走一次租约释放 + 闸门，
        // 不用等 watcher 下一个轮询周期（watcher 之后看到同一份差异也不会重复处理）。
        Promise.resolve()
          .then(() => runtime.handleSessionsRemoved([result.session.key]))
          .catch((err) => runtime.diagnostics.push(`delete session cleanup: ${err?.message ?? err}`));
        // 只搬目录不够：宿主的工作区索引（导航页的数据源）还记着它，
        // 不摘掉就会一直显示、点进去 `session/not-found`（D30）。
        try {
          if (workspaceHooks && typeof workspaceHooks.detachSession === 'function') {
            await workspaceHooks.detachSession(result.session.id);
          }
        } catch (err) {
          runtime.diagnostics.push(`workspace detach ${result.session.id}: ${err?.message ?? err}`);
        }
        try {
          removeProjectionCache(rootDir, result.session.id);
        } catch (err) {
          runtime.diagnostics.push(`projection cache ${result.session.id}: ${err?.message ?? err}`);
        }
        // 会话列表是客户端缓存，只有收到 `api-session/removed` 才会立刻少一行；
        // 历史会话没有 live agent，宿主不会自己发这个事件，所以由我们补发（D31）。
        try {
          workspaceHooks?.notifyRemoved?.(result.session.id);
        } catch (err) {
          runtime.diagnostics.push(`notify removed ${result.session.id}: ${err?.message ?? err}`);
        }
      }
      return send(res, result.moved ? 200 : 409, {
        ok: result.moved,
        result: {
          moved: result.moved,
          code: result.code,
          reason: result.reason,
          session: result.session ?? null,
        },
        ...(result.moved ? {} : { error: result.reason }),
      });
    }
    if (req.method === 'GET' && path === '/profile') {
      if (!profileStore) return send(res, 503, { ok: false, code: 'profile_unavailable', error: '宿主没给出设定存储。' });
      return send(res, 200, { ok: true, result: publicProfile(profileStore.read()) });
    }
    if ((req.method === 'PUT' || req.method === 'POST') && path === '/profile') {
      if (!profileStore) return send(res, 503, { ok: false, code: 'profile_unavailable', error: '宿主没给出设定存储。' });
      const body = await readJson(req);
      if (body.error) return send(res, 400, { ok: false, code: 'bad_request', error: body.error });
      try {
        const saved = profileStore.write(body.value);
        return send(res, 200, { ok: true, result: publicProfile(saved) });
      } catch (err) {
        if (err?.code === 'invalid_profile') {
          return send(res, 400, { ok: false, code: 'invalid_profile', error: String(err.message ?? err) });
        }
        throw err;
      }
    }
    if (req.method === 'GET' && path === '/memory') {
      let workspaces = [];
      try {
        workspaces = typeof listWorkspaces === 'function' ? listWorkspaces() ?? [] : [];
      } catch (err) {
        runtime.diagnostics.push(`listWorkspaces: ${err?.message ?? err}`);
      }
      return send(res, 200, { ok: true, result: runtime.memoryPanel({ workspaces }) });
    }
    if (req.method === 'POST' && path === '/memory/entry') {
      const body = await readJson(req);
      if (body.error) return send(res, 400, { ok: false, code: 'bad_request', error: body.error });
      // 工作区目标由 UI 指定（面板里是按工作区分组的），缺省才退回插件自己的工作区。
      const targetWorkspace =
        typeof body.value?.workspaceId === 'string' && body.value.workspaceId.trim() !== ''
          ? body.value.workspaceId.trim()
          : runtime.workspaceId;
      if (body.value?.scope === 'workspace' && !targetWorkspace) {
        return send(res, 503, { ok: false, code: 'workspace_required', error: '这条记忆要写进哪个工作区？' });
      }
      const result = runtime.memory.addUserEntry({
        scope: body.value?.scope,
        workspaceId: targetWorkspace,
        text: body.value?.text,
      });
      return send(res, result.ok ? 200 : 400, {
        ok: result.ok,
        code: result.code,
        result,
        ...(result.ok ? {} : { error: MEMORY_ERROR_TEXT[result.code] ?? result.code }),
      });
    }
    if (req.method === 'POST' && (path === '/memory/pending/accept' || path === '/memory/pending/reject')) {
      const body = await readJson(req);
      if (body.error) return send(res, 400, { ok: false, code: 'bad_request', error: body.error });
      const item = runtime.proposals.take(body.value?.id);
      if (!item) {
        return send(res, 404, { ok: false, code: 'not_found', error: '这条提议不在了（可能已被处理）。' });
      }
      if (path === '/memory/pending/reject') {
        return send(res, 200, { ok: true, result: { rejected: item.id } });
      }
      const stored = runtime.memory.addUserEntry({
        scope: item.scope,
        workspaceId: item.workspaceId,
        text: item.text,
      });
      return send(res, stored.ok ? 200 : 400, {
        ok: stored.ok,
        code: stored.code,
        result: { accepted: item.id, entry: stored.entry ?? null },
        ...(stored.ok ? {} : { error: MEMORY_ERROR_TEXT[stored.code] ?? stored.code }),
      });
    }
    if (req.method === 'POST' && path === '/memory/entry/remove') {
      const body = await readJson(req);
      if (body.error) return send(res, 400, { ok: false, code: 'bad_request', error: body.error });
      const result = runtime.memory.removeEntry(body.value?.id, { confirmed: body.value?.confirm === true });
      return send(res, result.ok ? 200 : 400, {
        ok: result.ok,
        code: result.code,
        result,
        ...(result.ok ? {} : { error: MEMORY_ERROR_TEXT[result.code] ?? result.code }),
      });
    }
    if (req.method === 'PUT' && path === '/memory/doc') {
      const body = await readJson(req);
      if (body.error) return send(res, 400, { ok: false, code: 'bad_request', error: body.error });
      const target =
        typeof body.value?.workspaceId === 'string' && body.value.workspaceId.trim() !== ''
          ? body.value.workspaceId.trim()
          : runtime.workspaceId;
      if (!target) return send(res, 503, { ok: false, code: 'workspace_required', error: '这个文档属于哪个工作区？' });
      const written = runtime.docs.write(target, body.value?.text, { confirmed: true });
      if (!written.ok) {
        return send(res, 400, {
          ok: false,
          code: written.code,
          error: written.code === 'empty_content' ? '内容为空：要清空请点「归档」，不要存空文档。' : '写入被拒绝。',
        });
      }
      return send(res, 200, {
        ok: true,
        result: { doc: runtime.docs.read(target), docBytes: runtime.docs.sizeOf(target) },
      });
    }
    if (req.method === 'POST' && path === '/memory/doc/archive') {
      const body = await readJson(req);
      if (body.error) return send(res, 400, { ok: false, code: 'bad_request', error: body.error });
      const target =
        typeof body.value?.workspaceId === 'string' && body.value.workspaceId.trim() !== ''
          ? body.value.workspaceId.trim()
          : runtime.workspaceId;
      if (!target) return send(res, 503, { ok: false, code: 'workspace_required', error: '这个文档属于哪个工作区？' });
      const archived = runtime.docs.archive(target, { confirmed: body.value?.confirm === true });
      return send(res, archived.ok ? 200 : 400, {
        ok: archived.ok,
        code: archived.code,
        result: { code: archived.code, archivePath: archived.archivePath ?? null },
        ...(archived.ok ? {} : { error: MEMORY_ERROR_TEXT[archived.code] ?? '归档失败。' }),
      });
    }
    return send(res, 404, { ok: false, code: 'not_found' });
  } catch (err) {
    return send(res, 500, { ok: false, code: 'internal_error', error: String(err?.message ?? err) });
  }
}

/**
 * 认证：复用宿主 Connection 的 admission（与 `/api` 路由同一套）。
 * 拿不到 connection 服务就直接 503——UI 读不到状态好过谁都能发释放请求。
 */
function admit(req, connection) {
  if (!connection || typeof connection.admit !== 'function') {
    return { ok: false, status: 503, code: 'auth_unavailable', message: 'DSH 认证服务未就绪，已拒绝请求。' };
  }
  let admission;
  try {
    admission = connection.admit(req);
  } catch (err) {
    return { ok: false, status: 403, code: 'auth_error', message: String(err?.message ?? err) };
  }
  if (!admission || typeof admission !== 'object') {
    return { ok: false, status: 401, code: 'unauthorized', message: '需要有效的 DSH 会话凭证。' };
  }
  if ('rejection' in admission) {
    const status = typeof admission.rejection === 'number' ? admission.rejection : 401;
    return status === 403
      ? { ok: false, status, code: 'forbidden', message: '需要 owner 权限。' }
      : { ok: false, status, code: 'unauthorized', message: '需要有效的 DSH 会话凭证。' };
  }
  if (admission.peer?.principal?.kind !== 'owner') {
    return { ok: false, status: 403, code: 'forbidden', message: '需要 owner 权限。' };
  }
  return { ok: true };
}

/** 读一个 JSON 对象请求体；空体按 `{}` 处理，超限直接拒。 */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { error: '请求体超过 8KB' };
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return { value: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: '请求体必须是 JSON 对象' };
    }
    return { value: parsed };
  } catch {
    return { error: '请求体不是合法 JSON' };
  }
}

/**
 * 只把 UI 需要、且不含本机路径的字段发出去。
 * `rootDir` / `workspaceId` 故意不发：插件页不需要，路径也不该出现在浏览器里。
 */
export function publicStatus(status) {
  const code = status?.gate?.code;
  return {
    engine: {
      state: status?.engine?.state ?? 'unknown',
      code: status?.engine?.code ?? null,
      models: [...(status?.engine?.models ?? [])],
      ownership: status?.engine?.ownership ?? null,
    },
    gate: {
      proceed: status?.gate?.proceed === true,
      code: code ?? null,
      reason: code ? (SKIP_REASON[code] ?? null) : null,
    },
    memory: {
      shared: status?.memory?.shared ?? 0,
      workspace: status?.memory?.workspace ?? 0,
      truncated: status?.memory?.truncated ?? 0,
    },
    sessionWatcher: status?.sessionWatcher
      ? { tracked: status.sessionWatcher.tracked, running: status.sessionWatcher.running === true }
      : null,
    // 最近一次真正尝试的清理：UI 靠 seq 变化弹一条提示（成功 / 未部署没清）。
    lastRelease: status?.lastRelease
      ? {
          seq: status.lastRelease.seq,
          at: status.lastRelease.at,
          trigger: status.lastRelease.trigger,
          released: status.lastRelease.released === true,
          code: status.lastRelease.code ?? null,
          probeState: status.lastRelease.probeState ?? null,
          reason: status.lastRelease.reason ?? '',
        }
      : null,
    recentDeletions: (status?.recentDeletions ?? []).slice(0, 1).map((entry) => ({
      at: entry.at,
      sessions: entry.sessions?.length ?? 0,
      released: entry.released === true,
      code: entry.code ?? null,
    })),
  };
}

/** 安全地读宿主工作区索引；宿主没给钩子时返回空数组。 */
function safeIndex(workspaceHooks) {
  if (!workspaceHooks || typeof workspaceHooks.listIndex !== 'function') return [];
  try {
    return workspaceHooks.listIndex() ?? [];
  } catch {
    return [];
  }
}

/**
 * 导航页的数据源是宿主工作区索引里的 sessionIds；目录被搬走后索引不会自己更新。
 * 这里把「索引里有、磁盘上没有」的会话列出来，交给 UI 一键摘除。
 *
 * 注意：宿主 `sessionIds` 里存的是**带 `session-` 前缀**的 id（`session-efd79296-…`），
 * 而磁盘目录名 `session-<uuid>` 里我们比对用的是裸 uuid。不归一化就会把全部会话误判成失效，
 * 点一次「清理」就把工作区索引清空——这是必须挡住的事故。
 */
export function collectOrphans(sessionsDir, index) {
  if (!sessionsDir) return [];
  const alive = new Set(listSessions(sessionsDir).map((session) => session.id));
  const normalize = (raw) => String(raw ?? '').replace(/^session-/, '');
  const orphans = [];
  const seen = new Set();
  for (const workspace of index ?? []) {
    for (const rawId of workspace?.sessionIds ?? []) {
      const id = normalize(rawId);
      if (!id || alive.has(id) || seen.has(id)) continue;
      seen.add(id);
      // 保留原始 id 交给 detachSession：宿主的 SessionId 就是带前缀的那个。
      orphans.push({ id: String(rawId), normalizedId: id, workspacePath: workspace?.path ?? null });
    }
  }
  return orphans;
}

/** 设定行：字段原样给出，附上风格枚举供 UI 渲染下拉。 */
export function publicProfile(profile) {
  return {
    assistantName: profile?.assistantName ?? '',
    userName: profile?.userName ?? '',
    style: STYLE_IDS.includes(profile?.style) ? profile.style : 'default',
    instructions: profile?.instructions ?? '',
    persona: profile?.persona ?? '',
    updatedAt: Number(profile?.updatedAt) || 0,
    styles: [...STYLE_IDS],
  };
}

/** 会话行：不给绝对路径，只给工作区目录名与统计。 */
export function publicSession(session) {
  return {
    id: session.id,
    workspaceKey: session.workspaceKey,
    title: session.title ?? '',
    updatedAt: session.updatedAt ?? 0,
    bytes: session.bytes ?? 0,
  };
}

/** 统一 JSON 响应；res 已断开时静默失败。 */
function send(res, status, payload) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  } catch {
    /* 客户端提前断开 */
  }
}
