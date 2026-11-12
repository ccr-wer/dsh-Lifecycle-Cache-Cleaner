import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LifecycleCacheCleaner } from '../cleaner.js';
import { PHASES } from '../state.js';
import { renderWorklog } from '../worklog.js';
import { FakeAdapter, VALID_SUMMARY } from './helpers/fake-adapter.js';

function setup(opts = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-'));
  const adapter = new FakeAdapter(opts.adapter);
  const cleaner = new LifecycleCacheCleaner({
    adapter,
    rootDir,
    sessionId: opts.sessionId ?? 'sess-1',
    config: { nCtx: 8192, rebuildPeriodTurns: 1, ...(opts.config || {}) },
  });
  return { rootDir, adapter, cleaner };
}

const readState = (rootDir) => JSON.parse(fs.readFileSync(path.join(rootDir, 'state.json'), 'utf8'));

test('happy path：固化 -> 提交 -> 销毁 -> 重建 -> committed', async () => {
  const { rootDir, adapter, cleaner } = setup();
  const r = await cleaner.rebuild({ reason: 'test' });

  assert.equal(r.ok, true);
  assert.equal(cleaner.phase, PHASES.COMMITTED);
  assert.equal(adapter.summarizeCalls, 1);
  assert.equal(adapter.destroyCalls, 1);
  assert.equal(adapter.rebuildCalls, 1);
  assert.equal(adapter.handleValid, true);

  const log = fs.readFileSync(path.join(rootDir, 'worklogs', 'sess-1.md'), 'utf8');
  assert.match(log, /- L1 \[decision\] 选择 Node 内置 test runner/);
  assert.match(log, /- L2 \[todo\] 补 V4 对抗日志/);
  assert.match(log, /## negations/);
  assert.match(log, /## 原始轨迹/);

  assert.match(adapter.lastSystemPrompt, /工作日志/);
  assert.match(adapter.lastSystemPrompt, /## 最近 3 轮原文/);
});

test('V1：总结超长 -> 不清理，destroyEngine 一次都不许调', async () => {
  const { rootDir, adapter, cleaner } = setup({ adapter: { summary: 'x'.repeat(20000) } });
  const r = await cleaner.rebuild({ reason: 'test' });

  assert.equal(r.ok, false);
  assert.equal(r.stage, 'summary-size');
  assert.equal(adapter.destroyCalls, 0);
  assert.equal(cleaner.phase, PHASES.ROLLED_BACK);
  assert.equal(readState(rootDir).committed_log_path, null, '未提交就不许写 committed_log_path');
});

test('V1b：总结不是合法 JSON -> 不清理', async () => {
  const { adapter, cleaner } = setup({ adapter: { summary: 'not json at all' } });
  const r = await cleaner.rebuild({ reason: 'test' });

  assert.equal(r.stage, 'parse');
  assert.equal(adapter.destroyCalls, 0);
  assert.equal(cleaner.phase, PHASES.ROLLED_BACK);
});

test('V1c：总结抛错 -> 不清理', async () => {
  const { adapter, cleaner } = setup({ adapter: { failSummarize: true } });
  const r = await cleaner.rebuild({ reason: 'test' });
  assert.equal(r.stage, 'rollback');
  assert.equal(adapter.destroyCalls, 0);
  assert.equal(cleaner.phase, PHASES.ROLLED_BACK);
});

test('V4 集成：新日志丢掉旧条目 -> 判 L5 失败，不清理', async () => {
  const { adapter, cleaner } = setup();
  await cleaner.rebuild({ reason: 'first' });
  assert.equal(cleaner.phase, PHASES.COMMITTED);

  // 只保留 L1，L2 消失
  adapter.summary = JSON.stringify([
    {
      status: 'decision',
      text: '选择 Node 内置 test runner，因为零依赖，文件 test/a.test.js',
      ref_id: 'L1',
    },
  ]);
  const r = await cleaner.rebuild({ reason: 'second' });

  assert.equal(r.ok, false);
  assert.equal(r.stage, 'l5');
  assert.ok(r.reasons.includes('entry_vanished:L2'), r.reasons.join(','));
  assert.equal(adapter.destroyCalls, 1, '第一次成功过一次，第二次不许再销毁');
  assert.equal(cleaner.phase, PHASES.ROLLED_BACK);
});

test('V3：重建失败 -> 不提交半成品', async () => {
  const { rootDir, adapter, cleaner } = setup({ adapter: { failRebuild: 99 } });
  const r = await cleaner.rebuild({ reason: 'test' });

  assert.equal(r.ok, false);
  assert.match(r.error, /rebuild_failed/);
  assert.notEqual(cleaner.phase, PHASES.COMMITTED, '句柄失效时绝不置 committed');
  assert.equal(cleaner.phase, PHASES.ROLLED_BACK);
  assert.equal(adapter.handleValid, false);
  // 日志是资产：已提交的文件保留，供下次重锚
  assert.ok(fs.existsSync(path.join(rootDir, 'worklogs', 'sess-1.md')));
});

test('V3b：重建失败后可重试成功（日志是资产，下一轮按 ref_id 对齐）', async () => {
  const { adapter, cleaner } = setup({ adapter: { failRebuild: 2 } });
  const r1 = await cleaner.rebuild({ reason: 'first' });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /rebuild_failed/);
  assert.equal(cleaner.phase, PHASES.ROLLED_BACK);

  // 日志已提交（L1/L2 在盘上），下一轮必须用 ref_id 回指旧条目，否则 L5 会判 entry_vanished
  adapter.summary = JSON.stringify([
    { status: 'decision', text: '选择 Node 内置 test runner，因为零依赖，文件 test/a.test.js', ref_id: 'L1' },
    { status: 'todo', text: '补 V4 对抗日志，文件 test/b.test.js', ref_id: 'L2' },
  ]);
  const r2 = await cleaner.rebuild({ reason: 'second' });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(cleaner.phase, PHASES.COMMITTED);
});

test('V3c：回滚后不复用旧 ID 会被 L5 拦下（fail-closed，而不是静默重写历史）', async () => {
  const { adapter, cleaner } = setup({ adapter: { failRebuild: 2 } });
  await cleaner.rebuild({ reason: 'first' });
  const r = await cleaner.rebuild({ reason: 'second' });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'l5');
  assert.ok(r.reasons.includes('entry_vanished:L1'), r.reasons.join(','));
  assert.equal(adapter.destroyCalls, 1, '第二次不许销毁引擎');
});

test('V5：并发触发 -> busy 锁生效，销毁只发生一次', async () => {
  const { adapter, cleaner } = setup();
  const [a, b] = await Promise.all([cleaner.rebuild({ reason: 'a' }), cleaner.rebuild({ reason: 'b' })]);

  const busy = [a, b].filter((x) => x.skipped === 'busy');
  assert.equal(busy.length, 1);
  assert.equal(adapter.destroyCalls, 1);
  assert.equal(adapter.summarizeCalls, 1);
});

test('V6：tearing_down 中断后重启能续跑（不从头开始）', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-crash-'));
  const logPath = path.join(rootDir, 'worklogs', 'sess-1.md');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    logPath,
    renderWorklog({
      sessionId: 'sess-1',
      goal: '重构 parse 模块',
      entries: [{ id: 'L1', status: 'todo', text: '写 test/parse.test.js' }],
      negations: ['[N1] L0: 放弃 jest reason: ESM 兼容问题'],
      rawTrace: '- t1 | user: 开始 | tools: Read(parse.js)',
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(rootDir, 'state.json'),
    JSON.stringify({
      session_id: 'sess-1',
      phase: 'tearing_down',
      target_ctx: 8192,
      committed_log_path: logPath,
      last_error: null,
      updated_at: Date.now(),
    }),
    'utf8',
  );

  const adapter = new FakeAdapter();
  const cleaner = new LifecycleCacheCleaner({ adapter, rootDir, sessionId: 'sess-1', config: { nCtx: 8192 } });
  const r = await cleaner.recover();

  assert.equal(r.recovered, true);
  assert.equal(r.action, 'resume_rebuild');
  assert.equal(cleaner.phase, PHASES.COMMITTED);
  assert.equal(adapter.rebuildCalls, 1);
  assert.match(adapter.lastSystemPrompt, /写 test\/parse\.test\.js/);
  assert.match(adapter.lastSystemPrompt, /放弃 jest/, '否定信息必须一起重锚');
});

test('V6b：validated 阶段崩溃 -> 丢弃临时日志回 rolled_back', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-crash2-'));
  fs.writeFileSync(
    path.join(rootDir, 'state.json'),
    JSON.stringify({ session_id: 'sess-1', phase: 'validated', committed_log_path: null }),
    'utf8',
  );
  const adapter = new FakeAdapter();
  const cleaner = new LifecycleCacheCleaner({ adapter, rootDir, sessionId: 'sess-1', config: { nCtx: 8192 } });
  const r = await cleaner.recover();

  assert.equal(r.action, 'discard');
  assert.equal(cleaner.phase, PHASES.ROLLED_BACK);
  assert.equal(adapter.rebuildCalls, 0, '未提交日志不许重建');
});

test('tick：水位线达标才触发重建（与 overflow_guard 无关）', async () => {
  const low = setup({ adapter: { usage: 0.2 } });
  assert.equal((await low.cleaner.tick({ userText: 'hi' })).rebuilt, false);

  const high = setup({ adapter: { usage: 0.85 } });
  assert.equal((await high.cleaner.tick({ userText: 'hi' })).rebuilt, true);
});

test('tick：换模型立即触发抢救式重建', async () => {
  const { adapter, cleaner } = setup({ adapter: { usage: 0.1 } });
  await cleaner.tick({ userText: 'a' });
  assert.equal(adapter.destroyCalls, 0);

  adapter.modelId = 'qwen3-32b-q8';
  const r = await cleaner.tick({ userText: 'b' });
  assert.equal(r.rebuilt, true);
  assert.equal(adapter.destroyCalls, 1);
});

test('微固化：每轮追加原始轨迹，且重建后不被吃掉', async () => {
  const { rootDir, cleaner } = setup({ adapter: { usage: 0.1 } });
  await cleaner.tick({ userText: '先看 src/parse.js', tools: [{ name: 'Read', args: { file: 'src/parse.js' } }] });
  await cleaner.tick({ userText: '再跑测试', tools: [{ name: 'Bash', args: 'node --test' }] });

  const before = fs.readFileSync(path.join(rootDir, 'worklogs', 'sess-1.md'), 'utf8');
  assert.match(before, /- t1 \| user: 先看 src\/parse\.js \| tools: Read\(/);
  assert.match(before, /- t2 \| user: 再跑测试 \| tools: Bash\(node --test\)/);

  const r = await cleaner.rebuild({ reason: 'periodic' });
  assert.equal(r.ok, true);
  const after = fs.readFileSync(path.join(rootDir, 'worklogs', 'sess-1.md'), 'utf8');
  assert.match(after, /- t1 \| user: 先看 src\/parse\.js/, '重建不得丢失原始轨迹');
});

test('安全：sessionId 含路径穿越必须被拒', () => {
  const adapter = new FakeAdapter();
  assert.throws(
    () => new LifecycleCacheCleaner({ adapter, rootDir: os.tmpdir(), sessionId: '../../etc/passwd' }),
    /非法字符/,
  );
});
