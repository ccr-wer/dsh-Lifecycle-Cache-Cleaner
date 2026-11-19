/**
 * 条目化记忆：归属裁决、消重、自动升级、预算截断。
 *
 * M1 模型建议 shared 但含本地绑定 -> 强制落工作区（并留 scopeReason）
 * M2 未 confirmed -> 不落盘
 * M3 完全相同 -> 条目不增，只刷新时间
 * M4 高相似 -> supersedes 链，旧条目仍可读
 * M5 同主语不同取值 -> 两条并存且都标 conflict，不合并
 * M6 同一事实出现在 2 个工作区 -> 自动升级到共享层
 * M7 超预算 -> 截断并计数，不静默丢
 * M8 重复写入幂等（换实例重开也只留一条）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TypedMemoryStore,
  MEMORY_SCOPE,
  classifyScope,
  similarity,
} from '../lib/core/memory-store.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-mem-'));
const store = (rootDir, now = () => 1000) => new TypedMemoryStore({ rootDir, now });

test('M1：模型建议 shared，但事实含本地路径 -> 落工作区并记录理由', () => {
  const rootDir = dir();
  const s = store(rootDir);
  const r = s.propose({
    text: '本机 npm 缓存目录是 C:\\Users\\me\\npm-cache',
    scope: MEMORY_SCOPE.SHARED,
    workspaceId: 'ws-A',
    confirmed: true,
  });

  assert.equal(r.ok, true);
  assert.equal(r.scope, MEMORY_SCOPE.WORKSPACE);
  assert.equal(r.scopeReason, 'local_binding');
  assert.equal(s.list({ scope: MEMORY_SCOPE.SHARED }).length, 0);
  assert.equal(s.list({ scope: MEMORY_SCOPE.WORKSPACE, workspaceId: 'ws-A' }).length, 1);
});

test('M1b：无本地绑定时，shared 建议被采纳；unsure 默认落工作区', () => {
  assert.equal(classifyScope({ text: '提交前先跑测试', suggested: 'shared' }).scope, MEMORY_SCOPE.SHARED);
  assert.equal(classifyScope({ text: '提交前先跑测试', suggested: 'unsure' }).scope, MEMORY_SCOPE.WORKSPACE);
});

test('M2：未 confirmed 一律不落盘', () => {
  const rootDir = dir();
  const s = store(rootDir);
  const r = s.propose({ text: '提交前先跑测试', workspaceId: 'ws-A', confirmed: false });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'confirm_required');
  assert.equal(fs.existsSync(path.join(rootDir, 'memory', 'typed.json')), false);
});

test('M3：完全相同只刷新时间，不新增条目', () => {
  const rootDir = dir();
  let t = 1000;
  const s = store(rootDir, () => t);
  const text = '提交前先跑 node --test';

  const first = s.propose({ text, workspaceId: 'ws-A', confirmed: true });
  t = 2000;
  const second = s.propose({ text, workspaceId: 'ws-A', confirmed: true });

  assert.equal(first.code, 'inserted');
  assert.equal(second.code, 'deduped_exact');
  assert.equal(s.list({ scope: MEMORY_SCOPE.WORKSPACE, workspaceId: 'ws-A' }).length, 1);
  assert.equal(s.get(first.id).updatedAt, 2000);
});

test('M4：高相似视为新版本，旧条目被取代但原文仍可读', () => {
  const rootDir = dir();
  const s = store(rootDir);
  const older = '构建命令固定为 pnpm build，产物输出到 dist 目录';
  const newer = '构建命令固定为 pnpm build，产物输出到 dist 目录里';

  assert.ok(similarity(older, newer) >= 0.9, '前置：两条应当足够相似');

  const a = s.propose({ text: older, workspaceId: 'ws-A', confirmed: true });
  const b = s.propose({ text: newer, workspaceId: 'ws-A', confirmed: true });

  assert.equal(b.code, 'superseded');
  assert.equal(b.supersedes, a.id);

  const active = s.list({ scope: MEMORY_SCOPE.WORKSPACE, workspaceId: 'ws-A' });
  assert.equal(active.length, 1, '有效条目只留新的');
  assert.equal(active[0].id, b.id);

  const all = s.list({ workspaceId: 'ws-A', includeSuperseded: true });
  assert.equal(all.length, 2, '旧条目不许删除');
  assert.equal(s.get(a.id).supersededBy, b.id);
});

test('M5：同主语不同取值 -> 两条并存且都标 conflict', () => {
  const rootDir = dir();
  const s = store(rootDir);
  const a = s.propose({ text: '本地引擎端口 11434', workspaceId: 'ws-A', confirmed: true });
  const b = s.propose({ text: '本地引擎端口 11435', workspaceId: 'ws-A', confirmed: true });

  assert.equal(b.code, 'conflict_recorded');
  assert.equal(b.conflictsWith, a.id);
  assert.equal(s.get(a.id).conflict, true);
  assert.equal(s.get(b.id).conflict, true);
  assert.equal(s.list({ scope: MEMORY_SCOPE.WORKSPACE, workspaceId: 'ws-A' }).length, 2);
});

test('M6：同一事实出现在 2 个工作区 -> 自动升级到共享层', () => {
  const rootDir = dir();
  const s = store(rootDir);
  const text = '回复里不要用 emoji';

  const a = s.propose({ text, workspaceId: 'ws-A', confirmed: true });
  assert.equal(a.scope, MEMORY_SCOPE.WORKSPACE, '单个工作区不升级');
  assert.equal(a.promoted, null);
  assert.equal(s.list({ scope: MEMORY_SCOPE.SHARED }).length, 0);

  const b = s.propose({ text, workspaceId: 'ws-B', confirmed: true });
  assert.equal(b.scope, MEMORY_SCOPE.WORKSPACE, '原条目仍留在各自工作区');
  assert.equal(b.promoted?.code, 'promoted');

  const shared = s.list({ scope: MEMORY_SCOPE.SHARED });
  assert.equal(shared.length, 1);
  assert.equal(shared[0].text, text);
  assert.equal(shared[0].source, 'promoted');
});

test('M7：超预算截断并计数，不静默丢', () => {
  const rootDir = dir();
  const s = store(rootDir);
  for (let i = 0; i < 20; i += 1) {
    s.propose({ text: `第 ${i} 条约定：这里是一段会被预算挤掉的说明文字`, workspaceId: 'ws-A', confirmed: true });
  }

  const r = s.render({ workspaceId: 'ws-A', maxWorkspaceBytes: 200 });
  assert.ok(r.counts.workspace >= 20);
  assert.ok(r.truncated > 0, '应当有被截断的条目');
  const body = r.text.split('\n').slice(1).join('\n');
  assert.ok(Buffer.byteLength(body, 'utf8') <= 200, '正文不许超预算');
});

test('M8：重复写入幂等，重新打开也只留一条', () => {
  const rootDir = dir();
  const text = '提交前先跑测试';

  store(rootDir).propose({ text, workspaceId: 'ws-A', confirmed: true });
  const reopened = store(rootDir);
  const again = reopened.propose({ text, workspaceId: 'ws-A', confirmed: true });

  assert.equal(again.code, 'deduped_exact');
  assert.equal(reopened.list({ scope: MEMORY_SCOPE.WORKSPACE, workspaceId: 'ws-A' }).length, 1);
});

test('M9：工作区记忆缺 workspaceId 时拒绝写入', () => {
  const s = store(dir());
  const r = s.propose({ text: '本项目用 pnpm', confirmed: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'workspace_required');
});
