import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerWebApi, ROUTE_BASE } from '../lib/host/web-api.js';
import { HostRuntime } from '../lib/host/runtime.js';

// Y 系列：记忆面板的两层接口（共享 / 本工作区条目 + 工作区整段文档）。

function makeRuntime() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mem-api-'));
  const runtime = new HostRuntime({
    rootDir,
    workspaceId: 'ws-mem',
    adapter: { probeEngine: async () => ({ installed: false, models: [], slots: [] }) },
  });
  return { rootDir, runtime };
}

function makeReq({ method = 'GET', url = `${ROUTE_BASE}/memory`, body = '' } = {}) {
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

const owner = () => ({ admit: () => ({ peer: { principal: { kind: 'owner' } } }) });

function captureRoute(runtime) {
  const routes = [];
  registerWebApi({
    runtime,
    connection: owner(),
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  });
  return routes[0];
}

async function call(route, req) {
  const res = makeRes();
  await route.handler(req, res);
  return res;
}

test('Y1 GET /memory 返回两层条目、文档与预算', async () => {
  const { runtime } = makeRuntime();
  runtime.memory.addUserEntry({ scope: 'shared', text: '共享的一条' });
  runtime.memory.addUserEntry({ scope: 'workspace', workspaceId: 'ws-mem', text: '工作区的一条' });
  const route = captureRoute(runtime);

  const res = await call(route, makeReq());
  assert.equal(res.statusCode, 200);
  const body = res.json().result;
  assert.equal(body.workspaceId, 'ws-mem');
  assert.equal(body.shared.length, 1);
  assert.equal(body.workspace.length, 1);
  assert.equal(body.shared[0].author, 'user');
  assert.equal(body.doc, '');
  assert.equal(body.budget.sharedBytes, 1024);
});

test('Y2 POST /memory/entry 分别写两层，并回条目', async () => {
  const { runtime } = makeRuntime();
  const route = captureRoute(runtime);

  const shared = await call(
    route,
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/memory/entry`, body: JSON.stringify({ scope: 'shared', text: '所有仓库都适用' }) }),
  );
  assert.equal(shared.statusCode, 200);
  assert.equal(shared.json().result.entry.scope, 'shared');

  const workspace = await call(
    route,
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/memory/entry`, body: JSON.stringify({ scope: 'workspace', text: '本仓库用 pnpm' }) }),
  );
  assert.equal(workspace.statusCode, 200);
  assert.equal(workspace.json().result.entry.workspaceId, 'ws-mem');
  assert.equal(runtime.memory.list({ scope: 'workspace', workspaceId: 'ws-mem' }).length, 1);
});

test('Y3 空文本 / 非法归属被 400 挡住，且不落盘', async () => {
  const { runtime } = makeRuntime();
  const route = captureRoute(runtime);

  const empty = await call(
    route,
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/memory/entry`, body: JSON.stringify({ scope: 'shared', text: '   ' }) }),
  );
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().code, 'empty_text');

  const badScope = await call(
    route,
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/memory/entry`, body: JSON.stringify({ scope: 'global', text: 'x' }) }),
  );
  assert.equal(badScope.statusCode, 400);
  assert.equal(badScope.json().code, 'bad_scope');
  assert.equal(runtime.memory.list({ scope: 'shared' }).length, 0);
});

test('Y4 POST /memory/entry/remove 需要 confirm，删掉后恢复被取代的旧版本', async () => {
  const { runtime } = makeRuntime();
  const old = runtime.memory.addUserEntry({ scope: 'shared', text: '发布前跑全部测试并检查日志' });
  const next = runtime.memory.addUserEntry({ scope: 'shared', text: '发布前跑全部测试并检查日志了' });
  assert.equal(next.code, 'superseded');
  const route = captureRoute(runtime);

  const refused = await call(
    route,
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/memory/entry/remove`, body: JSON.stringify({ id: next.id }) }),
  );
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().code, 'confirm_required');

  const removed = await call(
    route,
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/memory/entry/remove`, body: JSON.stringify({ id: next.id, confirm: true }) }),
  );
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().result.restored, old.id);
});

test('Y5 PUT /memory/doc 保存整段文档，空内容被拒（提示用归档清空）', async () => {
  const { runtime } = makeRuntime();
  const route = captureRoute(runtime);

  const saved = await call(
    route,
    makeReq({ method: 'PUT', url: `${ROUTE_BASE}/memory/doc`, body: JSON.stringify({ text: '# 本工作区\n\n- 用 pnpm\n' }) }),
  );
  assert.equal(saved.statusCode, 200);
  assert.match(saved.json().result.doc, /用 pnpm/);
  assert.ok(runtime.docs.sizeOf('ws-mem') > 0);

  const empty = await call(
    route,
    makeReq({ method: 'PUT', url: `${ROUTE_BASE}/memory/doc`, body: JSON.stringify({ text: '   ' }) }),
  );
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().code, 'empty_content');
});

test('Y6 POST /memory/doc/archive 需要 confirm，归档后文档为空', async () => {
  const { runtime } = makeRuntime();
  runtime.docs.write('ws-mem', '# 旧文档', { confirmed: true });
  const route = captureRoute(runtime);

  const refused = await call(route, makeReq({ method: 'POST', url: `${ROUTE_BASE}/memory/doc/archive`, body: JSON.stringify({}) }));
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().code, 'confirm_required');

  const archived = await call(
    route,
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/memory/doc/archive`, body: JSON.stringify({ confirm: true }) }),
  );
  assert.equal(archived.statusCode, 200);
  assert.equal(runtime.docs.read('ws-mem'), '');
  assert.equal(runtime.docs.listArchives('ws-mem').length, 1);
});
