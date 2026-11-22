import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TypedMemoryStore, MEMORY_SCOPE } from '../lib/core/memory-store.js';
import { HostRuntime } from '../lib/host/runtime.js';
import { apply } from '../index.js';

// N 系列：用户从 UI 写记忆（`addUserEntry` / `removeEntry`）。
// 与模型的 `propose()` 的区别只有一条：归属听用户的；其余消重/取代/冲突语义必须一致。

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-memory-user-'));
const store = (rootDir) => new TypedMemoryStore({ rootDir });

test('N1 用户选共享就落共享，即使内容带本地信号（归属听用户的）', () => {
  const rootDir = tmpRoot();
  const memory = store(rootDir);
  const result = memory.addUserEntry({ scope: 'shared', text: 'C:\\work\\repo 下不要跑 e2e' });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'inserted');
  assert.equal(result.entry.scope, MEMORY_SCOPE.SHARED);
  assert.equal(result.entry.scopeReason, 'user_selected');
  assert.equal(result.entry.author, 'user');
  // 模型的 propose 仍会把这类文本判进工作区
  const model = memory.propose({ text: 'C:\\other\\repo 下不要跑 e2e', scope: 'shared', confirmed: true, workspaceId: 'ws-1' });
  assert.equal(model.entry.scope, MEMORY_SCOPE.WORKSPACE);
});

test('N2 写工作区记忆必须给 workspaceId，否则拒绝', () => {
  const memory = store(tmpRoot());
  const result = memory.addUserEntry({ scope: 'workspace', text: '本仓库用 pnpm' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'workspace_required');
});

test('N3 同样的文本不会写两条（只刷新时间）', () => {
  const memory = store(tmpRoot());
  const first = memory.addUserEntry({ scope: 'shared', text: '发布前必须跑完整测试套件' });
  const second = memory.addUserEntry({ scope: 'shared', text: '  发布前必须跑完整测试套件  ' });
  assert.equal(second.code, 'deduped_exact');
  assert.equal(second.id, first.id);
  assert.equal(memory.list({ scope: 'shared' }).length, 1);
});

test('N4 高相似文本作为新版本取代旧条目（旧的保留但隐藏）', () => {
  const rootDir = tmpRoot();
  const memory = store(rootDir);
  const old = memory.addUserEntry({ scope: 'shared', text: '默认端口用 11434 的模型服务' });
  const next = memory.addUserEntry({ scope: 'shared', text: '默认端口用 11434 的模型服务端' });

  assert.equal(next.code, 'superseded');
  assert.equal(next.entry.supersedes, old.id);
  const active = memory.list({ scope: 'shared' });
  assert.equal(active.length, 1);
  assert.equal(active[0].id, next.id);
  assert.equal(memory.list({ scope: 'shared', includeSuperseded: true }).length, 2);
});

test('N5 删掉新版本会把被它取代的旧版本恢复回来', () => {
  const memory = store(tmpRoot());
  const old = memory.addUserEntry({ scope: 'shared', text: '工作区里所有提交都用中文说明' });
  const next = memory.addUserEntry({ scope: 'shared', text: '工作区里所有提交都用中文说明了' });
  assert.equal(next.code, 'superseded');

  const removed = memory.removeEntry(next.id, { confirmed: true });
  assert.equal(removed.ok, true);
  assert.equal(removed.restored, old.id);
  const active = memory.list({ scope: 'shared' });
  assert.deepEqual(active.map((e) => e.id), [old.id]);
});

test('N6 删除冲突的一方会清掉另一方的冲突标记', () => {
  const memory = store(tmpRoot());
  const a = memory.addUserEntry({ scope: 'shared', text: '部署端口 3000' });
  const b = memory.addUserEntry({ scope: 'shared', text: '部署端口 8080' });
  assert.equal(b.code, 'conflict_recorded');

  memory.removeEntry(b.id, { confirmed: true });
  const rest = memory.list({ scope: 'shared' });
  assert.equal(rest.length, 1);
  assert.equal(rest[0].id, a.id);
  assert.equal(rest[0].conflict, false);
});

test('N7 删除必须 confirmed:true；不存在时回 not_found', () => {
  const memory = store(tmpRoot());
  const entry = memory.addUserEntry({ scope: 'shared', text: '一条会被拒绝删除的记忆' });
  assert.equal(memory.removeEntry(entry.id).code, 'confirm_required');
  assert.equal(memory.list({ scope: 'shared' }).length, 1);
  assert.equal(memory.removeEntry('no-such-id', { confirmed: true }).code, 'not_found');
});

test('N8 用户写入不会触发“跨工作区自动升级”', () => {
  const memory = store(tmpRoot());
  memory.addUserEntry({ scope: 'workspace', workspaceId: 'ws-a', text: '提交信息用中文' });
  const second = memory.addUserEntry({ scope: 'workspace', workspaceId: 'ws-b', text: '提交信息用中文' });
  assert.equal(second.ok, true);
  assert.equal(second.promoted ?? null, null, '用户手动写入不走 propose 的升级链路');
  assert.equal(memory.list({ scope: 'shared' }).length, 0);
});

test('N9 工作区记忆按工作区隔离渲染；全局记忆只出共享层', () => {
  const rootDir = tmpRoot();
  const runtime = new HostRuntime({ rootDir, workspaceId: 'C:\\profile-dir', adapter: null });
  runtime.memory.addUserEntry({ scope: 'shared', text: '共享的事实' });
  runtime.memory.addUserEntry({ scope: 'workspace', workspaceId: 'C:\\proj\\a', text: 'A 工作区的事实' });
  runtime.memory.addUserEntry({ scope: 'workspace', workspaceId: 'C:\\proj\\b', text: 'B 工作区的事实' });

  const sharedOnly = runtime.memoryText();
  assert.match(sharedOnly, /共享的事实/);
  assert.equal(/A 工作区的事实|B 工作区的事实/.test(sharedOnly), false, '全局 prompt 不能串工作区条目');

  const a = runtime.workspaceMemoryText('C:\\proj\\a');
  assert.match(a, /A 工作区的事实/);
  assert.equal(/B 工作区的事实/.test(a), false);
  assert.equal(/共享的事实/.test(a), false, '共享层走全局 section，不在工作区 section 里重复');
  assert.equal(runtime.workspaceMemoryText('C:\\proj\\empty'), '');
});

test('N10 apply 会在每个 agent 的 scope 里注册“本工作区记忆”section', () => {
  const rootDir = tmpRoot();
  const runtime = new HostRuntime({ rootDir, workspaceId: 'C:\\profile-dir', adapter: null });
  runtime.memory.addUserEntry({ scope: 'workspace', workspaceId: 'C:\\proj\\a', text: 'A 工作区的事实' });

  const sections = [];
  const agent = {
    id: 'agent-1',
    session: { header: { cwd: 'C:\\proj\\a' } },
    ctx: {
      inject(names, cb) {
        if (names.includes('systemPrompt')) cb({ systemPrompt: { section: (s) => sections.push(s) } });
        return () => {};
      },
    },
  };

  const ctx = {
    tools: { register: () => () => {} },
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    on(event, listener) {
      if (event === 'agent/created') listener({ agent });
      return () => {};
    },
    get(name) {
      if (name === 'agents') return { list: () => [agent] };
      if (name === 'systemPrompt') {
        return { variable: () => () => {}, section: () => () => {} };
      }
      return undefined;
    },
    inject(names, cb) {
      if (names.includes('systemPrompt')) {
        cb({ variable: () => () => {}, section: () => () => {} });
      }
    },
  };

  apply(ctx, { rootDir, workspaceId: 'C:\\profile-dir', engine: { kind: 'none' } });

  assert.equal(sections.length, 1, '每个 agent 只注册一段');
  assert.equal(sections[0].name, 'plugin:lifecycle-workspace-memory');
  assert.match(sections[0].text(), /A 工作区的事实/);
});
