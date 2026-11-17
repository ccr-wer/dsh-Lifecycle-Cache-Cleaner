/**
 * V11 工作区记忆生命周期：删除会话 **不** 等于删除工作区记忆。
 *
 * 验收要点：
 *  - 删掉工作区最后一个会话后，记忆文件必须原地不动。
 *  - "可归档"只体现为候选列表，扫描零写操作。
 *  - 归档必须显式 confirmed，且是移动（可 restore），不是删除。
 *  - 索引若只增不删，宁可漏报也不得误判成"零会话"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LeaseRegistry } from '../../whalebone-core/engine-lease.js';
import { WorkspaceRegistry } from '../../whalebone-core/workspace-registry.js';
import { WorkspaceMemoryStore } from '../../whalebone-core/workspace-memory.js';
import { findOrphanWorkspaces } from '../../whalebone-core/orphan-scan.js';
import { SessionDeleter } from '../session-deleter.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const REF = {
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  modelId: 'qwen3:32b',
  spawnedBy: 'dsh',
};

function setup({ memContent = '项目约定：先跑测试再改代码' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebone-v11-'));
  const registry = new WorkspaceRegistry({ file: path.join(dir, 'index.json'), now: () => T0 });
  const memory = new WorkspaceMemoryStore({ rootDir: dir, now: () => T0 });
  const leases = new LeaseRegistry({ now: () => T0 });
  const deleted = [];
  const deleter = new SessionDeleter({
    leases,
    probe: null,
    adapters: [],
    transport: null,
    host: { deleteSession: async (id) => { deleted.push(id); } },
    now: () => T0,
    workspaceRegistry: registry,
    workspaceMemory: memory,
  });
  if (memContent !== null) {
    const w = memory.write('ws-A', memContent, { confirmed: true });
    assert.equal(w.ok, true, '前置：记忆应写入成功');
  }
  return { dir, registry, memory, leases, deleter, deleted };
}

const later = (days) => () => T0 + days * DAY;

test('V11-1：删掉工作区最后一个会话 -> 记忆文件原地不动，不归档', async () => {
  const { memory, deleter } = setup();
  const file = memory.fileFor('ws-A');

  deleter.registerSession('s1', REF, { workspaceId: 'ws-A' });
  const r = await deleter.delete('s1', {});

  assert.equal(r.deleted, true);
  assert.equal(fs.existsSync(file), true, '删会话绝不能顺手删工作区记忆');
  assert.equal(fs.readFileSync(file, 'utf8').includes('先跑测试再改代码'), true);
  assert.deepEqual(memory.listArchives('ws-A'), [], '不应产生任何归档');
});

test('V11-2：索引按会话递减，删一个不影响另一个的存活判定', async () => {
  const { registry, deleter } = setup();
  deleter.registerSession('s1', REF, { workspaceId: 'ws-A' });
  deleter.registerSession('s2', REF, { workspaceId: 'ws-A' });
  assert.deepEqual(registry.liveSessions('ws-A').sort(), ['s1', 's2']);

  await deleter.delete('s1', {});

  assert.deepEqual(registry.liveSessions('ws-A'), ['s2'], 's1 应转为 deleted');
  assert.equal(deleter.scanOrphans({ minIdleDays: 0, now: later(999) }).length, 0, '还有活会话就不是孤儿');
});

test('V11-3：零活会话 + 记忆存在 + 闲置达标 -> 只列候选，文件不动', async () => {
  const { memory, registry, deleter } = setup();
  const file = memory.fileFor('ws-A');
  const before = fs.readFileSync(file, 'utf8');

  deleter.registerSession('s1', REF, { workspaceId: 'ws-A' });
  await deleter.delete('s1', {});
  assert.equal(registry.liveSessions('ws-A').length, 0);

  const orphans = deleter.scanOrphans({ minIdleDays: 30, now: later(31) });

  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].workspaceId, 'ws-A');
  assert.equal(orphans[0].liveSessions, 0);
  assert.equal(orphans[0].idleDays, 31);
  assert.equal(orphans[0].bytes > 0, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '扫描必须零写操作');
  assert.deepEqual(memory.listArchives('ws-A'), []);
});

test('V11-4：闲置未达标 -> 不是候选', async () => {
  const { deleter } = setup();
  deleter.registerSession('s1', REF, { workspaceId: 'ws-A' });
  await deleter.delete('s1', {});

  assert.deepEqual(deleter.scanOrphans({ minIdleDays: 30, now: later(7) }), []);
  assert.equal(deleter.scanOrphans({ minIdleDays: 30, now: later(30) }).length, 1, '满 30 天即达标');
});

test('V11-5：归档未 confirmed -> 拒绝，记忆原样保留', async () => {
  const { memory, deleter } = setup();
  const file = memory.fileFor('ws-A');

  const r = deleter.archiveWorkspaceMemory('ws-A', { confirmed: false });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'confirm_required');
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(memory.listArchives('ws-A'), []);
});

test('V11-6：归档确认后是移动，可 restore 撤销', async () => {
  const { memory, deleter } = setup();
  const file = memory.fileFor('ws-A');
  const before = fs.readFileSync(file, 'utf8');

  const r = deleter.archiveWorkspaceMemory('ws-A', { confirmed: true });

  assert.equal(r.ok, true);
  assert.equal(r.code, 'archived');
  assert.equal(fs.existsSync(file), false, '原路径应消失（移动而非复制）');
  assert.equal(fs.existsSync(r.archivePath), true);
  assert.equal(fs.readFileSync(r.archivePath, 'utf8'), before, '内容必须完整保留');

  const back = deleter.restoreWorkspaceMemory(r.archivePath, 'ws-A', { confirmed: true });
  assert.equal(back.ok, true);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('V11-7：索引只增不删宁可漏报，不得误判为零会话', async () => {
  const { registry, memory } = setup();
  registry.noteSession('ws-A', 's1'); // 登记后从未 markDeleted（模拟旧索引残留）

  assert.deepEqual(registry.liveSessions('ws-A'), ['s1']);
  assert.deepEqual(
    findOrphanWorkspaces({ registry, memoryStore: memory, minIdleDays: 0, now: later(9999) }),
    [],
    '残留的 live 条目只能让候选变少，不能凭空多出一个孤儿',
  );
});

test('V11-8：未传 workspaceId 的会话不进索引，机制全程不介入', async () => {
  const { registry, deleter } = setup();

  deleter.registerSession('s9', REF); // 老调用方式
  const r = await deleter.delete('s9', {});

  assert.equal(r.deleted, true, '删除主流程不受影响');
  assert.deepEqual(registry.list(), [], '没有 workspaceId 就不该凭空造出工作区');
  assert.deepEqual(deleter.scanOrphans({ minIdleDays: 0, now: later(999) }), []);
});
