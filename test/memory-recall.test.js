import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TypedMemoryStore, relevance, PROMPT_BUDGET } from '../lib/core/memory-store.js';
import { HostRuntime } from '../lib/host/runtime.js';

// Q 系列：注入时的相关度排序，以及“被预算挤掉几条”的可见性。
// 设计前提：**没有向量**，只有 bigram 覆盖度 + 时间兜底，零外部依赖。

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-recall-'));
const store = (rootDir) => new TypedMemoryStore({ rootDir });

test('Q1 relevance 测“条目被问题覆盖的比例”，短记忆命中就是高分', () => {
  assert.equal(relevance('端口用 11434', '本地模型的端口用 11434 还是别的？'), 1, '整条被问题包含');
  assert.ok(relevance('端口用 11434', '今天天气不错') === 0, '完全无关是 0');
  const partial = relevance('发布前必须跑全部测试并检查日志', '发布前要跑测试吗');
  assert.ok(partial > 0 && partial < 1, `部分命中应在 0~1 之间，实际 ${partial}`);
});

test('Q2 给了 query 就按相关度排序：相关的排在更新的不相关条目之前', () => {
  const rootDir = tmpRoot();
  const memory = store(rootDir);
  memory.addUserEntry({ scope: 'workspace', workspaceId: 'ws-a', text: '提交信息用中文' });
  memory.addUserEntry({ scope: 'workspace', workspaceId: 'ws-a', text: '默认端口用 11434' });

  const text = memory.render({ workspaceId: 'ws-a', query: '端口是多少' }).text;
  assert.ok(text.indexOf('11434') < text.indexOf('提交信息'), '相关条目应排在前面');
});

test('Q3 不给 query 时保持“最新的在前”，行为不变', () => {
  const rootDir = tmpRoot();
  const memory = store(rootDir);
  memory.addUserEntry({ scope: 'workspace', workspaceId: 'ws-a', text: '第一条' });
  memory.addUserEntry({ scope: 'workspace', workspaceId: 'ws-a', text: '第二条' });

  const rendered = memory.render({ workspaceId: 'ws-a' });
  assert.equal(rendered.ranked, false);
  assert.ok(rendered.text.indexOf('第二条') < rendered.text.indexOf('第一条'));
});

test('Q4 超预算的条目计入 dropped，而不是静默消失', () => {
  const rootDir = tmpRoot();
  const memory = store(rootDir);
  // 把工作区预算挤爆：每条都接近上限。
  for (let i = 0; i < 40; i += 1) {
    memory.addUserEntry({ scope: 'workspace', workspaceId: 'ws-a', text: `第 ${i} 条比较长的记忆内容，用来占满预算空间` });
  }
  const rendered = memory.render({ workspaceId: 'ws-a' });
  assert.ok(rendered.dropped.workspace > 0, '应该有条目被挤掉');
  assert.equal(
    rendered.counts.workspace,
    rendered.dropped.workspace + (rendered.counts.workspace - rendered.dropped.workspace),
  );
  assert.ok(rendered.counts.workspace > 0);
});

test('Q5 runtime 记住最近用户消息，过期后不再拿来排序', () => {
  const rootDir = tmpRoot();
  const runtime = new HostRuntime({ rootDir, workspaceId: 'C:\\ws', adapter: null });

  runtime.rememberHint('C:\\ws', '本地模型的端口是多少');
  assert.equal(runtime.hintFor('C:\\ws'), '本地模型的端口是多少');
  assert.equal(runtime.hintFor('C:\\other'), null, '没记录过的工作区没有 hint');

  // 手动把时间戳推旧：超过 30 分钟就不再当作“当前问题”。
  runtime.promptHints.get('C:\\ws').at = Date.now() - 31 * 60 * 1000;
  assert.equal(runtime.hintFor('C:\\ws'), null);
});

test('Q6 工作区注入会记录统计：注入了几条、丢弃几条、是否按问题排序', () => {
  const rootDir = tmpRoot();
  const runtime = new HostRuntime({ rootDir, workspaceId: 'C:\\ws', adapter: null });
  runtime.memory.addUserEntry({ scope: 'workspace', workspaceId: 'C:\\ws', text: '默认端口用 11434' });
  runtime.memory.addUserEntry({ scope: 'workspace', workspaceId: 'C:\\ws', text: '提交信息用中文' });

  runtime.rememberHint('C:\\ws', '端口是多少');
  const text = runtime.workspaceMemoryText('C:\\ws');

  assert.match(text, /11434/, '相关条目必须进注入');
  assert.ok(runtime.injection, '要留下注入统计');
  assert.equal(runtime.injection.workspace.ranked, true, '有 hint 时应标记为已排序');
  assert.equal(runtime.injection.workspace.total, 2);
  assert.equal(runtime.injection.workspace.dropped, 0);

  const panel = runtime.memoryPanel({ workspaces: [] });
  assert.ok(panel.injection, '面板要能读到注入统计');
  assert.equal(panel.injection.workspace.ranked, true);
});

test('Q7 预算常量与面板显示一致（改一处不会和另一处对不上）', () => {
  const rootDir = tmpRoot();
  const runtime = new HostRuntime({ rootDir, workspaceId: 'C:\\ws', adapter: null });
  const panel = runtime.memoryPanel({ workspaces: [] });
  assert.equal(panel.budget.sharedBytes, PROMPT_BUDGET.sharedBytes);
  assert.equal(panel.budget.workspaceBytes, PROMPT_BUDGET.workspaceBytes);
});
