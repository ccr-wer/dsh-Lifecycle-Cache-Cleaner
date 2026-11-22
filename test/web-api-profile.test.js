import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerWebApi, ROUTE_BASE, publicProfile } from '../lib/host/web-api.js';
import { ProfileStore, LIMITS } from '../lib/host/profile-store.js';

// F 系列：个性化设定的两条接口。
// 重点：只有 UI 能写（模型没有工具）、校验失败不落盘、认证优先于读写。

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-profile-api-'));

function makeReq({ method = 'GET', url = `${ROUTE_BASE}/profile`, body = '' } = {}) {
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
  registerWebApi({
    ...options,
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  });
  return routes[0];
}

const fakeRuntime = () => ({
  diagnostics: [],
  async status() {
    return { engine: {}, gate: {}, memory: {}, sessionWatcher: null, recentDeletions: [] };
  },
  async clean() {
    return { released: false, code: 'skip_absent' };
  },
  async handleSessionsRemoved() {},
});

async function call(route, req) {
  const res = makeRes();
  await route.handler(req, res);
  return res;
}

test('F1 没设置过时 GET 返回空设定 + 风格枚举', async () => {
  const rootDir = tmpRoot();
  const route = captureRoute({
    runtime: fakeRuntime(),
    connection: ownerConnection(),
    profileStore: new ProfileStore({ rootDir }),
  });

  const res = await call(route, makeReq());
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.userName, '');
  assert.equal(body.result.style, 'default');
  assert.deepEqual(body.result.styles, ['default', 'concise', 'detailed']);
});

test('F2 PUT 保存后落盘，GET 能读回', async () => {
  const rootDir = tmpRoot();
  const store = new ProfileStore({ rootDir });
  const route = captureRoute({ runtime: fakeRuntime(), connection: ownerConnection(), profileStore: store });

  const saved = await call(
    route,
    makeReq({
      method: 'PUT',
      body: JSON.stringify({ userName: '沃野熠烨', assistantName: '夜枭', style: 'concise', instructions: '先给结论', persona: '说话直接。' }),
    }),
  );
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().result.assistantName, '夜枭');
  assert.ok(saved.json().result.updatedAt > 0);

  const reread = await call(route, makeReq());
  assert.equal(reread.json().result.userName, '沃野熠烨');
  assert.equal(reread.json().result.style, 'concise');
  assert.equal(store.read().persona, '说话直接。');
});

test('F3 校验失败回 400，且不覆盖已有设定', async () => {
  const rootDir = tmpRoot();
  const store = new ProfileStore({ rootDir });
  store.write({ userName: '保留我' });
  const route = captureRoute({ runtime: fakeRuntime(), connection: ownerConnection(), profileStore: store });

  const res = await call(
    route,
    makeReq({ method: 'PUT', body: JSON.stringify({ instructions: 'x'.repeat(LIMITS.instructions + 10) }) }),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'invalid_profile');
  assert.equal(store.read().userName, '保留我', '校验失败不许动旧值');
});

test('F4 认证优先：非 owner 既读不到也写不了', async () => {
  const rootDir = tmpRoot();
  const store = new ProfileStore({ rootDir });
  store.write({ userName: '机密' });
  const route = captureRoute({
    runtime: fakeRuntime(),
    connection: { admit: () => ({ peer: { principal: { kind: 'viewer' } } }) },
    profileStore: store,
  });

  const read = await call(route, makeReq());
  assert.equal(read.statusCode, 403);

  const write = await call(route, makeReq({ method: 'PUT', body: JSON.stringify({ userName: '改掉' }) }));
  assert.equal(write.statusCode, 403);
  assert.equal(store.read().userName, '机密');
});

test('F5 没有 store 时回 503，不崩', async () => {
  const route = captureRoute({ runtime: fakeRuntime(), connection: ownerConnection(), profileStore: null });
  const res = await call(route, makeReq());
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'profile_unavailable');
});

test('F6 publicProfile 只给 UI 需要的字段', () => {
  const shaped = publicProfile({ assistantName: 'a', userName: 'b', style: 'detailed', instructions: 'c', persona: 'd', updatedAt: 42, secret: 'x' });
  assert.deepEqual(Object.keys(shaped).sort(), ['assistantName', 'instructions', 'persona', 'style', 'styles', 'updatedAt', 'userName']);
  assert.equal(shaped.updatedAt, 42);
});
