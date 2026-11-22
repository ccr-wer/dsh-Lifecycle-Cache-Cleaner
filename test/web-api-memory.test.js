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

function captureRoute(runtime, extra = {}) {
  const routes = [];
  registerWebApi({
    runtime,
    connection: owner(),
    ...extra,
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

test('Y1 GET /memory 返回共享组、工作区组与预算', async () => {
  const { runtime } = makeRuntime();
  runtime.memory.addUserEntry({ scope: 'shared', text: '共享的一条' });
  runtime.memory.addUserEntry({ scope: 'workspace', workspaceId: 'ws-mem', text: '工作区的一条' });
  const route = captureRoute(runtime);

  const res = await call(route, makeReq());
  assert.equal(res.statusCode, 200);
  const body = res.json().result;
  assert.equal(body.shared.entries.length, 1);
  assert.equal(body.shared.pending.length, 0);
  assert.equal(body.workspaces.length, 1);
  const group = body.workspaces[0];
  assert.equal(group.id, 'ws-mem');
  assert.equal(group.label, 'ws-mem');
  assert.equal(group.entries.length, 1);
  assert.equal(group.entries[0].author, 'user');
  assert.equal(group.doc, '');
  assert.equal(body.budget.sharedBytes, 1024);
});

test('Y1b 宿主登记的工作区即使还没有记忆，也会自动成组', async () => {
  const { runtime } = makeRuntime();
  const route = captureRoute(runtime, {
    listWorkspaces: () => [
      { id: 'w1', path: 'C:\\proj\\alpha', title: 'Alpha' },
      { id: 'w2', path: 'C:\\proj\\beta' },
    ],
  });

  const body = (await call(route, makeReq())).json().result;
  const ids = body.workspaces.map((group) => group.id).sort();
  assert.deepEqual(ids, ['C:\\proj\\alpha', 'C:\\proj\\beta']);
  assert.equal(body.workspaces.find((g) => g.id === 'C:\\proj\\alpha').label, 'Alpha', '有宿主标题就用标题');
  assert.equal(body.workspaces.find((g) => g.id === 'C:\\proj\\alpha').title, 'Alpha');
  assert.equal(body.workspaces.find((g) => g.id === 'C:\\proj\\beta').label, 'beta', '没标题退回路径最后一段');
});

test('Y1c 显示名优先用宿主标题；同名的补父目录后缀', async () => {
  const { runtime } = makeRuntime();
  const route = captureRoute(runtime, {
    listWorkspaces: () => [
      { id: 'w1', path: 'C:\\work\\deepseek-harness\\default-workspace', title: '主工作区' },
      { id: 'w2', path: 'C:\\other\\one\\default-workspace' },
      { id: 'w3', path: 'D:\\data\\two\\default-workspace' },
      { id: 'w4', path: 'C:\\proj\\beta' },
    ],
  });

  const labels = (await call(route, makeReq())).json().result.workspaces.map((g) => g.label);
  assert.ok(labels.includes('主工作区'), '有 title 用 title，不再显示路径最后一段');
  assert.ok(labels.includes('default-workspace (one)'), '同名补父目录');
  assert.ok(labels.includes('default-workspace (two)'), '另一个同名补另一个父目录');
  assert.ok(labels.includes('beta'), '不重名保持原样');
  assert.equal(new Set(labels).size, labels.length, '显示名不能重复');
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

test('Y7 提议出现在对应组里；接受后才写进记忆，拒绝则丢弃', async () => {
  const { runtime } = makeRuntime();
  runtime.proposals.add({ text: '共享的提议', scope: 'shared', reason: '跨仓库通用' });
  runtime.proposals.add({ text: '工作区的提议', scope: 'workspace', workspaceId: 'ws-mem' });
  const route = captureRoute(runtime);

  const before = (await call(route, makeReq())).json().result;
  assert.equal(before.pendingCount, 2);
  assert.equal(before.shared.pending.length, 1);
  assert.equal(before.workspaces.find((g) => g.id === 'ws-mem').pending.length, 1);
  assert.equal(runtime.memory.list({ scope: 'shared' }).length, 0, '接受前不落库');

  const accepted = await call(
    route,
    makeReq({ method: 'POST', url: `${ROUTE_BASE}/memory/pending/accept`, body: JSON.stringify({ id: before.shared.pending[0].id }) }),
  );
  assert.equal(accepted.statusCode, 200);
  assert.equal(runtime.memory.list({ scope: 'shared' }).length, 1);
  assert.equal(runtime.proposals.list().length, 1);

  const rejected = await call(
    route,
    makeReq({
      method: 'POST',
      url: `${ROUTE_BASE}/memory/pending/reject`,
      body: JSON.stringify({ id: runtime.proposals.list()[0].id }),
    }),
  );
  assert.equal(rejected.statusCode, 200);
  assert.equal(runtime.proposals.list().length, 0);
  assert.equal(runtime.memory.list({ scope: 'workspace', workspaceId: 'ws-mem' }).length, 0, '拒绝的不写');
});

test('Y8 条目可以按 UI 指定的 workspaceId 写入指定工作区', async () => {
  const { runtime } = makeRuntime();
  const route = captureRoute(runtime);

  const res = await call(
    route,
    makeReq({
      method: 'POST',
      url: `${ROUTE_BASE}/memory/entry`,
      body: JSON.stringify({ scope: 'workspace', workspaceId: 'C:\\proj\\alpha', text: '这个仓库用 pnpm' }),
    }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().result.entry.workspaceId, 'C:\\proj\\alpha');
  assert.equal(runtime.memory.list({ scope: 'workspace', workspaceId: 'C:\\proj\\alpha' }).length, 1);
  assert.equal(runtime.memory.list({ scope: 'workspace', workspaceId: 'ws-mem' }).length, 0);
});
