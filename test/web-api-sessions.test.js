import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerWebApi, ROUTE_BASE } from '../lib/host/web-api.js';

// W 系列：会话相关的两条接口。重点在“确认 → 移动 → 立刻走一次清理”，
// 以及认证、非法 id、缺目录这些拒绝路径。

const UUID = '94f60096-4603-4885-a34f-a99f2693c5a9';

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-web-sessions-'));
  const sessionsDir = path.join(root, 'sessions');
  const trashDir = path.join(root, 'lifecycle-cache', 'trash');
  const dir = path.join(sessionsDir, 'ws-a', `session-${UUID}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(16));
  const past = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(dir, 'session.v4.jsonl.zstd'), past, past);
  return { root, sessionsDir, trashDir };
}

function makeReq({ method = 'GET', url = `${ROUTE_BASE}/sessions`, body = '' } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')];
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeRes() {
  return {
    statusCode: 0,
    payload: '',
    writeHead(status) {
      this.statusCode = status;
    },
    end(chunk) {
      this.payload = chunk === undefined ? '' : String(chunk);
    },
    json() {
      return JSON.parse(this.payload);
    },
  };
}

const ownerConnection = () => ({ admit: () => ({ peer: { principal: { kind: 'owner' } } }) });

function captureRoute(options) {
  const routes = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  registerWebApi({ ...options, webServer });
  return routes[0];
}

function fakeRuntime() {
  const removed = [];
  return {
    removed,
    runtime: {
      diagnostics: [],
      async status() {
        return { engine: { state: 'absent', models: [], ownership: 'x' }, gate: { proceed: false, code: 'skip_absent' }, memory: {}, sessionWatcher: null, recentDeletions: [] };
      },
      async clean() {
        return { released: false, code: 'skip_absent' };
      },
      async handleSessionsRemoved(paths) {
        removed.push(...paths);
      },
    },
  };
}

async function call(route, req) {
  const res = makeRes();
  await route.handler(req, res);
  return res;
}

test('W1 GET /sessions 返回会话清单与删除窗口，不含绝对路径', async () => {
  const env = makeEnv();
  const { runtime } = fakeRuntime();
  const route = captureRoute({ runtime, connection: ownerConnection(), sessionsDir: env.sessionsDir, trashDir: env.trashDir, minIdleMs: 120000 });

  const res = await call(route, makeReq());
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.sessions.length, 1);
  assert.equal(body.result.sessions[0].id, UUID);
  assert.equal(body.result.sessions[0].workspaceKey, 'ws-a');
  assert.equal(body.result.minIdleMs, 120000);
  assert.equal(JSON.stringify(body).includes(env.root.replace(/\\/g, '\\\\')), false, '不许把本机路径发给浏览器');
});

test('W2 没带 confirm 的删除请求被 400 挡掉，目录不动', async () => {
  const env = makeEnv();
  const { runtime } = fakeRuntime();
  const route = captureRoute({ runtime, connection: ownerConnection(), sessionsDir: env.sessionsDir, trashDir: env.trashDir });

  const res = await call(route, makeReq({ method: 'POST', url: `${ROUTE_BASE}/sessions/delete`, body: JSON.stringify({ id: UUID }) }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'confirm_required');
  assert.equal(fs.existsSync(path.join(env.sessionsDir, 'ws-a', `session-${UUID}`)), true);
});

test('W3 确认删除：目录进回收站，并立刻触发一次租约释放 + 闸门', async () => {
  const env = makeEnv();
  const { runtime, removed } = fakeRuntime();
  const route = captureRoute({ runtime, connection: ownerConnection(), sessionsDir: env.sessionsDir, trashDir: env.trashDir });

  const res = await call(
    route,
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/sessions/delete`, body: JSON.stringify({ id: UUID, confirm: true }) }),
  );
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.moved, true);
  assert.equal(body.result.session.key, `ws-a/session-${UUID}`);
  assert.equal(fs.existsSync(path.join(env.sessionsDir, 'ws-a', `session-${UUID}`)), false);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(removed, [`ws-a/session-${UUID}`], '删除后要立刻走一次 handleSessionsRemoved');
});

test('W4 当前会话 / 不存在的会话都被拒绝，且回 409 + 原因', async () => {
  const env = makeEnv();
  const { runtime } = fakeRuntime();
  const route = captureRoute({ runtime, connection: ownerConnection(), sessionsDir: env.sessionsDir, trashDir: env.trashDir });

  const current = await call(
    route,
    makeReq({
      method: 'POST',
      url: `${ROUTE_BASE}/sessions/delete`,
      body: JSON.stringify({ id: UUID, confirm: true, currentSessionId: UUID }),
    }),
  );
  assert.equal(current.statusCode, 409);
  assert.equal(current.json().result.code, 'is_current');
  assert.ok(current.json().error);

  const missing = await call(
    route,
    makeReq({
      method: 'POST',
      url: `${ROUTE_BASE}/sessions/delete`,
      body: JSON.stringify({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', confirm: true }),
    }),
  );
  assert.equal(missing.statusCode, 409);
  assert.equal(missing.json().result.code, 'not_found');
});

test('W5 未通过认证时，会话接口一律拒绝且不碰文件', async () => {
  const env = makeEnv();
  const { runtime, removed } = fakeRuntime();
  const route = captureRoute({ runtime, connection: { admit: () => ({ rejection: 401 }) }, sessionsDir: env.sessionsDir, trashDir: env.trashDir });

  const list = await call(route, makeReq());
  assert.equal(list.statusCode, 401);

  const del = await call(
    route,
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/sessions/delete`, body: JSON.stringify({ id: UUID, confirm: true }) }),
  );
  assert.equal(del.statusCode, 401);
  assert.equal(fs.existsSync(path.join(env.sessionsDir, 'ws-a', `session-${UUID}`)), true);
  assert.deepEqual(removed, []);
});

test('W6 没配置会话目录时回 503，不崩', async () => {
  const { runtime } = fakeRuntime();
  const route = captureRoute({ runtime, connection: ownerConnection(), sessionsDir: null, trashDir: null });

  const list = await call(route, makeReq());
  assert.equal(list.statusCode, 503);
  assert.equal(list.json().code, 'sessions_unavailable');
});
