import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerWebApi, publicStatus, ROUTE_BASE } from '../lib/host/web-api.js';
import { HostRuntime } from '../lib/host/runtime.js';

// U 系列：插件页 UI 的 HTTP 面。测的是“认证 → 路由 → runtime”这条链路，
// 以及它没有把闸门搬到浏览器里（clean 仍然只调 runtime.clean）。

function makeReq({ method = 'GET', url = `${ROUTE_BASE}/status`, body = '' } = {}) {
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
    headers: null,
    payload: undefined,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      this.payload = chunk === undefined ? '' : String(chunk);
    },
    json() {
      return JSON.parse(this.payload);
    },
  };
}

const ownerConnection = () => ({
  admit: () => ({ peer: { principal: { kind: 'owner' } } }),
});

function captureRoute(options) {
  const routes = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {
        const i = routes.indexOf(route);
        if (i >= 0) routes.splice(i, 1);
      };
    },
  };
  const dispose = registerWebApi({ ...options, webServer });
  return { routes, dispose };
}

async function call(route, req) {
  const res = makeRes();
  await route.handler(req, res);
  return res;
}

const statusFixture = {
  rootDir: 'C:\\secret\\.dsh',
  workspaceId: 'C:\\secret\\ws',
  engine: { state: 'owned_idle', code: null, models: ['m'], ownership: 'adapter-exclusive' },
  gate: { proceed: true, code: 'allow' },
  memory: { shared: 2, workspace: 1, truncated: 0, workspaceDocBytes: 10 },
  sessionWatcher: { tracked: 3, scans: 4, running: true },
  recentDeletions: [{ at: 1, sessions: ['a'], released: true, code: 'released' }],
  diagnostics: ['x'],
};

function fakeRuntime({ status = statusFixture, clean = { released: true, code: 'released' } } = {}) {
  const calls = { status: 0, clean: [] };
  return {
    calls,
    runtime: {
      async status() {
        calls.status++;
        return status;
      },
      async clean(options) {
        calls.clean.push(options);
        return clean;
      },
    },
  };
}

test('U1 注册一条 prefix 路由，路径固定，卸载后消失', () => {
  const { runtime } = fakeRuntime();
  const { routes, dispose } = captureRoute({ runtime, connection: ownerConnection() });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, ROUTE_BASE);
  assert.equal(typeof routes[0].handler, 'function');

  dispose();
  assert.equal(routes.length, 0);
});

test('U2 owner 读 /status 拿到投影后的状态，且不含本机路径', async () => {
  const { runtime } = fakeRuntime();
  const { routes } = captureRoute({ runtime, connection: ownerConnection() });
  const res = await call(routes[0], makeReq());

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.engine.state, 'owned_idle');
  assert.equal(body.result.gate.proceed, true);
  assert.equal(body.result.memory.shared, 2);
  assert.equal(body.result.sessionWatcher.tracked, 3);
  assert.equal(JSON.stringify(body).includes('secret'), false, '不许把本机路径发给浏览器');
});

test('U3 认证被拒时不触碰 runtime', async () => {
  const { runtime, calls } = fakeRuntime();
  const { routes } = captureRoute({
    runtime,
    connection: { admit: () => ({ rejection: 403 }) },
  });
  const res = await call(routes[0], makeReq());

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, 'forbidden');
  assert.equal(calls.status, 0);
  assert.equal(calls.clean.length, 0);
});

test('U4 非 owner Peer 一律 403', async () => {
  const { runtime, calls } = fakeRuntime();
  const { routes } = captureRoute({
    runtime,
    connection: { admit: () => ({ peer: { principal: { kind: 'viewer' } } }) },
  });
  const res = await call(routes[0], makeReq());

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, 'forbidden');
  assert.equal(calls.status, 0);
});

test('U5 没有 connection 服务时 fail-closed（503），不放行任何请求', async () => {
  const { runtime, calls } = fakeRuntime();
  const { routes } = captureRoute({ runtime, connection: undefined });
  const res = await call(routes[0], makeReq());

  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'auth_unavailable');
  assert.equal(calls.status, 0);
});

test('U6 POST /clean 把 confirm 原样交给 runtime.clean', async () => {
  const { runtime, calls } = fakeRuntime();
  const { routes } = captureRoute({ runtime, connection: ownerConnection() });

  const confirmed = await call(
    routes[0],
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/clean`, body: JSON.stringify({ confirm: true }) }),
  );
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json().result.released, true);

  const bare = await call(routes[0], makeReq({ method: 'POST', url: `${ROUTE_BASE}/clean` }));
  assert.equal(bare.statusCode, 200);

  assert.deepEqual(calls.clean, [{ confirm: true }, { confirm: false }]);
});

test('U7 闸门拒绝时 UI 也能读到原因（clean 结果原样返回）', async () => {
  const { runtime } = fakeRuntime({
    status: { ...statusFixture, engine: { ...statusFixture.engine, state: 'absent' }, gate: { proceed: false, code: 'skip_absent' } },
    clean: { released: false, code: 'skip_absent', probeState: 'absent', reason: '本机没有探测到本地引擎' },
  });
  const { routes } = captureRoute({ runtime, connection: ownerConnection() });

  const status = await call(routes[0], makeReq());
  assert.equal(status.json().result.gate.proceed, false);
  assert.equal(status.json().result.gate.code, 'skip_absent');
  assert.ok(status.json().result.gate.reason);

  const clean = await call(
    routes[0],
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/clean`, body: JSON.stringify({ confirm: true }) }),
  );
  assert.equal(clean.json().result.released, false);
  assert.equal(clean.json().result.code, 'skip_absent');
});

test('U8 非法 JSON / 非法路径 / 非法方法都被挡住', async () => {
  const { runtime, calls } = fakeRuntime();
  const { routes } = captureRoute({ runtime, connection: ownerConnection() });

  const badBody = await call(
    routes[0],
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/clean`, body: '{oops' }),
  );
  assert.equal(badBody.statusCode, 400);
  assert.equal(badBody.json().code, 'bad_request');
  assert.equal(calls.clean.length, 0);

  const notArray = await call(
    routes[0],
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/clean`, body: '[1,2]' }),
  );
  assert.equal(notArray.statusCode, 400);

  const unknown = await call(routes[0], makeReq({ url: `${ROUTE_BASE}/nope` }));
  assert.equal(unknown.statusCode, 404);

  const wrongMethod = await call(routes[0], makeReq({ method: 'GET', url: `${ROUTE_BASE}/clean` }));
  assert.equal(wrongMethod.statusCode, 404);
});

test('U9 runtime 抛错时回 500，不让宿主路由抛', async () => {
  const { runtime } = fakeRuntime();
  runtime.status = async () => {
    throw new Error('boom');
  };
  const { routes } = captureRoute({ runtime, connection: ownerConnection() });
  const res = await call(routes[0], makeReq());

  assert.equal(res.statusCode, 500);
  assert.equal(res.json().code, 'internal_error');
});

test('U10 publicStatus 只留 UI 需要的字段', () => {
  const projected = publicStatus(statusFixture);
  assert.deepEqual(Object.keys(projected).sort(), [
    'engine',
    'gate',
    'memory',
    'recentDeletions',
    'sessionWatcher',
  ]);
  assert.equal(projected.recentDeletions.length, 1);
  assert.equal(projected.recentDeletions[0].sessions, 1);
  assert.equal('diagnostics' in projected, false);
  assert.equal('rootDir' in projected, false);
});

test('U11 接真实 HostRuntime：absent 引擎时 status 的闸门为拒绝且按钮不会放行', async () => {
  const runtime = new HostRuntime({
    rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lc-web-')),
    adapter: { probeEngine: async () => ({ installed: false, models: [], slots: [] }) },
  });
  const { routes } = captureRoute({ runtime, connection: ownerConnection() });

  const status = await call(routes[0], makeReq());
  assert.equal(status.json().result.engine.state, 'absent');
  assert.equal(status.json().result.gate.proceed, false);

  const clean = await call(
    routes[0],
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/clean`, body: JSON.stringify({ confirm: true }) }),
  );
  assert.equal(clean.json().result.released, false);
  assert.equal(clean.json().result.code, 'skip_absent');
});

test('U12 webServer 缺 register 时不注册也不抛', () => {
  const dispose = registerWebApi({ runtime: fakeRuntime().runtime, webServer: {}, connection: ownerConnection() });
  assert.equal(typeof dispose, 'function');
  assert.doesNotThrow(() => dispose());
  assert.doesNotThrow(() => registerWebApi({ runtime: fakeRuntime().runtime, webServer: null }));
});
