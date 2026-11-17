/**
 * 压缩接缝（compaction seam）：DSH 原生压缩在场时的行为。
 *
 * 验收要点：
 *  - 能力探测不到就回退到自带水位触发，行为与 V1–V6 完全一致。
 *  - 探测到压缩后，tick() 绝不自行重建（避免双重压缩）。
 *  - onCompacted() 只在 compaction/end 无 error 时动作。
 *  - 压缩锁按 fail-closed 处理：读不出来就当忙。
 *  - 记忆固化失败则不释放显存（沿用 V1「没有有效日志就不清理」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LifecycleCacheCleaner } from '../cleaner.js';
import { FakeAdapter } from './helpers/fake-adapter.js';

class CompactionAdapter extends FakeAdapter {
  constructor(opts = {}) {
    super(opts);
    this.compactionOpen = opts.compactionOpen ?? false;
    this.openThrows = opts.openThrows ?? false;
  }

  get capabilities() {
    return { compaction: true, tokenMeter: true };
  }

  async isCompactionOpen() {
    if (this.openThrows) throw new Error('session log unreadable');
    return this.compactionOpen;
  }
}

function setup(opts = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-seam-'));
  const Adapter = opts.compaction ? CompactionAdapter : FakeAdapter;
  const adapter = new Adapter(opts.adapter);
  const cleaner = new LifecycleCacheCleaner({
    adapter,
    rootDir,
    sessionId: 'sess-seam',
    config: { nCtx: 8192, rebuildPeriodTurns: 1, ...(opts.config || {}) },
  });
  return { rootDir, adapter, cleaner };
}

const worklogPath = (rootDir) => path.join(rootDir, 'worklogs', 'sess-seam.md');

test('S1：探测不到压缩能力 -> tick 仍按水位自行重建（回退路径不受影响）', async () => {
  const { cleaner, adapter } = setup({ adapter: { usage: 0.95 } });

  assert.equal(cleaner.caps.compaction, false);
  assert.equal(cleaner.mode, 'self-triggered');

  const r = await cleaner.tick({ userText: 'hi' });

  assert.equal(r.rebuilt, true, '没有宿主压缩时必须自己兜底');
  assert.equal(adapter.destroyCalls, 1);
});

test('S2：探测到压缩能力 -> tick 绝不自建重建，即使水位已超阈值', async () => {
  const { cleaner, adapter } = setup({ compaction: true, adapter: { usage: 0.99 } });

  assert.equal(cleaner.caps.compaction, true);
  assert.equal(cleaner.mode, 'compaction-driven');

  const r = await cleaner.tick({ userText: 'hi' });

  assert.equal(r.rebuilt, false);
  assert.equal(r.mode, 'compaction-driven');
  assert.equal(adapter.destroyCalls, 0, '双重压缩是最坏情况，必须为零');
  assert.equal(adapter.rebuildCalls, 0);
});

test('S3：compaction/end 成功 -> 固化工作日志并释放缓存', async () => {
  const { rootDir, cleaner, adapter } = setup({ compaction: true });

  const r = await cleaner.onCompacted({ droppedTokens: 1234 });

  assert.equal(r.ok, true);
  assert.equal(r.droppedTokens, 1234);
  assert.equal(r.memory.ok, true);
  assert.equal(r.cache.ok, true);
  assert.equal(fs.existsSync(worklogPath(rootDir)), true, '工作日志必须落盘');
  assert.equal(adapter.destroyCalls, 1);
  assert.equal(adapter.rebuildCalls, 1);
  assert.equal(cleaner.phase, 'idle', '压缩模式不驱动状态机');
});

test('S4：compaction/end 带 error -> 零动作（不整理、不清理）', async () => {
  const { rootDir, cleaner, adapter } = setup({ compaction: true });

  const r = await cleaner.onCompacted({ error: 'summary stage failed' });

  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'compaction_failed');
  assert.equal(adapter.summarizeCalls, 0);
  assert.equal(adapter.destroyCalls, 0);
  assert.equal(fs.existsSync(worklogPath(rootDir)), false);
});

test('S5：压缩锁未闭合 -> skipped_busy，零写零清理', async () => {
  const { rootDir, cleaner, adapter } = setup({
    compaction: true,
    adapter: { compactionOpen: true },
  });

  const r = await cleaner.onCompacted();

  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'compaction_open');
  assert.equal(adapter.destroyCalls, 0);
  assert.equal(fs.existsSync(worklogPath(rootDir)), false);
});

test('S6：压缩锁读不出来 -> fail-closed，按忙处理', async () => {
  const { cleaner, adapter } = setup({
    compaction: true,
    adapter: { openThrows: true },
  });

  const r = await cleaner.onCompacted();

  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'compaction_open', '拿不准就当忙，宁可不动');
  assert.equal(adapter.destroyCalls, 0);
});

test('S7：没有压缩能力时调用 onCompacted -> 明确拒绝，不假装支持', async () => {
  const { cleaner, adapter } = setup({ adapter: { usage: 0.1 } });

  const r = await cleaner.onCompacted();

  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'compaction_unavailable');
  assert.equal(adapter.destroyCalls, 0);
});

test('S8：记忆固化失败 -> 不释放显存（没有有效日志就不清理）', async () => {
  const { rootDir, cleaner, adapter } = setup({
    compaction: true,
    adapter: { summary: 'x'.repeat(20000) },
  });

  const r = await cleaner.onCompacted();

  assert.equal(r.ok, false);
  assert.equal(r.memory.stage, 'summary-size');
  assert.equal(r.cache.skipped, 'memory_failed');
  assert.equal(adapter.destroyCalls, 0, '日志无效时绝不能动引擎');
  assert.equal(fs.existsSync(worklogPath(rootDir)), false);
});

test('S9：releaseCache 可独立调用，失败不外抛', async () => {
  const { cleaner, adapter } = setup({ compaction: true, adapter: { failRebuild: 5 } });
  cleaner.adapter.rebuildSession = async () => {
    throw new Error('engine gone');
  };

  const r = await cleaner.releaseCache({ reason: 'manual' });

  assert.equal(r.ok, false);
  assert.equal(r.stage, 'release');
  assert.equal(r.error, 'engine gone');
  assert.equal(adapter.destroyCalls, 1, '销毁先发生，失败不回滚');
});

test('S10：有效摘要时 releaseCache 用当前工作日志当 system prompt', async () => {
  const { rootDir, cleaner, adapter } = setup({ compaction: true });
  fs.mkdirSync(path.join(rootDir, 'worklogs'), { recursive: true });
  fs.writeFileSync(worklogPath(rootDir), '# 工作日志\n\n- [done] 已有条目\n', 'utf8');

  const r = await cleaner.releaseCache({ reason: 'manual' });

  assert.equal(r.ok, true);
  assert.match(adapter.lastSystemPrompt, /已有条目/, '必须带上已固化的工作日志');
});
