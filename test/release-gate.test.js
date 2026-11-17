/**
 * 统一清理闸门：无论哪条触发链路，没探测到部署就绝不动引擎。
 *
 * 这组用例钉的是**不变量**，不是实现细节：
 *  - I1 清理前必有一次探测
 *  - I2 absent  -> 引擎写次数 = 0
 *  - I3 unknown -> 引擎写次数 = 0（fail-closed）
 *  - I4 没实现探测 -> 也算 unknown
 *  - I5 absent 时日志流水线照样走完（压缩仍算完成）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LifecycleCacheCleaner } from '../cleaner.js';
import { FakeAdapter } from './helpers/fake-adapter.js';

function setup(opts = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-gate-'));
  const adapter = new FakeAdapter(opts.adapter);
  if (opts.compaction) adapter.capabilities = { compaction: true, tokenMeter: true };
  const cleaner = new LifecycleCacheCleaner({
    adapter,
    rootDir,
    sessionId: 'sess-gate',
    config: { nCtx: 8192, probeTimeoutMs: 30, ...(opts.config || {}) },
  });
  return { rootDir, adapter, cleaner };
}

const worklogPath = (rootDir) => path.join(rootDir, 'worklogs', 'sess-gate.md');

test('I1/I2：探测到没有部署 -> 不清理，且探测确实发生过', async () => {
  const { cleaner, adapter } = setup({
    adapter: { probe: { installed: false, models: [], slots: [] } },
  });

  const r = await cleaner.releaseCache({ reason: 'manual' });

  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'skip_absent');
  assert.equal(adapter.probeCalls, 1, 'I1：必须探测过一次');
  assert.equal(adapter.destroyCalls, 0, 'I2：没部署就零写');
  assert.equal(adapter.rebuildCalls, 0);
});

test('I2：引擎在但模型列表为空 -> 同样算没有部署', async () => {
  const { cleaner, adapter } = setup({
    adapter: { probe: { installed: true, models: [], slots: [] } },
  });

  const r = await cleaner.releaseCache();

  assert.equal(r.skipped, 'skip_absent');
  assert.equal(adapter.destroyCalls, 0);
});

test('I3：探测抛错 -> unknown，不清理', async () => {
  const { cleaner, adapter } = setup({ adapter: { probe: new Error('ECONNREFUSED') } });

  const r = await cleaner.releaseCache();

  assert.equal(r.skipped, 'skip_unknown');
  assert.equal(adapter.destroyCalls, 0);
});

test('I3：探测超时 -> unknown，不清理', async () => {
  const { cleaner, adapter } = setup({
    adapter: { probe: () => new Promise(() => {}) },
  });

  const r = await cleaner.releaseCache();

  assert.equal(r.skipped, 'skip_unknown');
  assert.equal(adapter.destroyCalls, 0);
});

test('I3：适配器返回垃圾快照 -> unknown', async () => {
  const { cleaner, adapter } = setup({ adapter: { probe: 'not-an-object' } });

  const r = await cleaner.releaseCache();

  assert.equal(r.skipped, 'skip_unknown');
  assert.equal(adapter.destroyCalls, 0);
});

test('I4：适配器根本没实现 probeEngine -> 按 unknown 处理，不清理', async () => {
  const { cleaner, adapter } = setup();
  adapter.probeEngine = undefined;

  const r = await cleaner.releaseCache();

  assert.equal(r.skipped, 'skip_unknown');
  assert.equal(adapter.destroyCalls, 0, '拿不到证据就不许删');
});

test('I2：rebuild 在没部署时只提交日志，绝不销毁引擎', async () => {
  const { rootDir, cleaner, adapter } = setup({
    adapter: { probe: { installed: false, models: [], slots: [] } },
  });

  const r = await cleaner.rebuild({ reason: 'watermark' });

  assert.equal(r.ok, false);
  assert.equal(r.stage, 'gate');
  assert.equal(r.code, 'skip_absent');
  assert.equal(adapter.destroyCalls, 0);
  assert.equal(adapter.rebuildCalls, 0);
  assert.equal(cleaner.phase, 'rolled_back', '不清理就明确回滚，不假装 committed');
  assert.equal(fs.existsSync(worklogPath(rootDir)), true, '日志在闸门之前已落盘');
});

test('I5：没部署时压缩仍算完成（日志整理完成即完成）', async () => {
  const { rootDir, cleaner, adapter } = setup({
    compaction: true,
    adapter: { probe: { installed: false, models: [], slots: [] } },
  });

  const r = await cleaner.onCompacted({ droppedTokens: 900 });

  assert.equal(r.compactionComplete, true, '压缩完成只取决于日志整理');
  assert.equal(r.memory.ok, true);
  assert.equal(r.cache.skipped, 'skip_absent');
  assert.equal(adapter.destroyCalls, 0);
  assert.equal(fs.existsSync(worklogPath(rootDir)), true);
});

test('日志整理失败 -> 压缩不算完成', async () => {
  const { cleaner, adapter } = setup({ compaction: true, adapter: { summary: 'x'.repeat(20000) } });

  const r = await cleaner.onCompacted();

  assert.equal(r.compactionComplete, false);
  assert.equal(r.memory.ok, false);
  assert.equal(adapter.destroyCalls, 0);
});

test('有部署时照常清理（闸门不是阻断器）', async () => {
  const { cleaner, adapter } = setup();

  const r = await cleaner.releaseCache({ reason: 'manual' });

  assert.equal(r.ok, true);
  assert.equal(adapter.destroyCalls, 1);
  assert.equal(adapter.rebuildCalls, 1);
});
