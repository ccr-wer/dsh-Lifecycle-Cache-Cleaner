import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProposalStore, PENDING_LIMIT } from '../lib/host/proposal-store.js';
import { HostRuntime } from '../lib/host/runtime.js';
import { createProposeMemoryTool } from '../lib/host/tools.js';

// J 系列：模型的“记忆提议”队列。关键约束：提议**不进长期记忆**，
// 只有用户在面板里接受后才落库。

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-proposal-'));

test('J1 提议只排队，不进 typed.json', () => {
  const rootDir = tmpRoot();
  const runtime = new HostRuntime({ rootDir, workspaceId: 'C:\\ws\\a', adapter: null });
  const result = runtime.proposals.add({ text: '提交信息用中文', scope: 'shared' });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'queued');
  assert.equal(runtime.proposals.list().length, 1);
  assert.equal(runtime.memory.list({ scope: 'shared' }).length, 0, '接受前不能进记忆');
  assert.ok(fs.existsSync(path.join(rootDir, 'memory', 'pending.json')));
});

test('J2 工作区提议必须带 workspaceId', () => {
  const store = new ProposalStore({ rootDir: tmpRoot() });
  const bad = store.add({ text: '端口是 11434', scope: 'workspace' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'workspace_required');
  assert.equal(store.list().length, 0);

  const good = store.add({ text: '端口是 11434', scope: 'workspace', workspaceId: 'C:\\ws\\a' });
  assert.equal(good.ok, true);
  assert.equal(store.list()[0].workspaceId, 'C:\\ws\\a');
});

test('J3 同一目标下相同文本不会重复排队', () => {
  const store = new ProposalStore({ rootDir: tmpRoot() });
  store.add({ text: '发布前跑测试', scope: 'shared' });
  const again = store.add({ text: '  发布前跑测试  ', scope: 'shared' });
  assert.equal(again.code, 'duplicate');
  assert.equal(store.list().length, 1);

  store.add({ text: '发布前跑测试', scope: 'workspace', workspaceId: 'C:\\ws\\a' });
  assert.equal(store.list().length, 2, '不同目标算不同提议');
});

test('J4 队列有上限，超了明确拒绝', () => {
  const store = new ProposalStore({ rootDir: tmpRoot() });
  for (let i = 0; i < PENDING_LIMIT; i += 1) store.add({ text: `事实 ${i}`, scope: 'shared' });
  const overflow = store.add({ text: '再来一条', scope: 'shared' });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, 'pending_full');
});

test('J5 take 取走一条后就消失了', () => {
  const store = new ProposalStore({ rootDir: tmpRoot() });
  const created = store.add({ text: '一条待处理', scope: 'shared' });
  const item = store.take(created.id);
  assert.equal(item.text, '一条待处理');
  assert.equal(store.list().length, 0);
  assert.equal(store.take(created.id), null);
});

test('J6 工具 lifecycle_memory_propose 只排队，文案说明“还没进记忆”', async () => {
  const rootDir = tmpRoot();
  const runtime = new HostRuntime({ rootDir, workspaceId: 'C:\\ws\\a', adapter: null });
  const tool = createProposeMemoryTool(runtime);

  const text = await tool.execute({ text: '服务端口 11434', scope: 'workspace', workspace: 'C:\\ws\\b', reason: '本机部署' }, {});
  assert.match(text, /等待用户/);
  assert.match(text, /还没有进长期记忆/);
  assert.equal(runtime.memory.list({ scope: 'workspace' }).length, 0);

  const quoted = runtime.proposals.list();
  assert.equal(quoted.length, 1);
  assert.equal(quoted[0].workspaceId, 'C:\\ws\\b');
  assert.equal(quoted[0].reason, '本机部署');

  const empty = await tool.execute({ text: '   ', scope: 'shared' }, {});
  assert.match(empty, /empty_text|提议未提交/);
});
