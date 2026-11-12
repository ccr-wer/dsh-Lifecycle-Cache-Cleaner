import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OverflowGuard, defaultCountTokens } from '../overflow-guard.js';
import { DEFAULTS } from '../cleaner.js';
import { FakeAdapter } from './helpers/fake-adapter.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-guard-'));

test('overflow_guard：单条工具输出超 5% n_ctx 必须落盘', () => {
  const dir = tmp();
  const g = new OverflowGuard({ nCtx: 8192, spillDir: dir });
  const big = 'x'.repeat(20000); // ~5000 tokens >> 409 (5%)

  const r = g.guardToolOutput(big, { currentTokens: 0, id: 'read_file' });
  assert.equal(r.truncated, true);
  assert.match(r.text, /^\[tool output truncated: .+, \d+ tokens, reason=single-entry\]$/);
  assert.ok(fs.existsSync(r.spillPath), '落盘文件必须存在');
  assert.equal(fs.readFileSync(r.spillPath, 'utf8'), big, '落盘内容必须完整');
});

test('overflow_guard：小输出直接放行，不产生落盘', () => {
  const dir = tmp();
  const g = new OverflowGuard({ nCtx: 8192, spillDir: dir });
  const r = g.guardToolOutput('hello world', { currentTokens: 100 });
  assert.equal(r.truncated, false);
  assert.equal(r.spillPath, null);
  assert.equal(r.text, 'hello world');
});

test('overflow_guard：插入后总水位 > 95% 也落盘', () => {
  const dir = tmp();
  const g = new OverflowGuard({ nCtx: 10000, spillDir: dir });
  const r = g.guardToolOutput('y'.repeat(2000), { currentTokens: 9400 });
  assert.equal(r.truncated, true);
  assert.match(r.text, /reason=post-insert/);
});

test('双闸门必须分离：overflow_guard 与 rebuild_watermark 不共享阈值', () => {
  assert.notEqual(DEFAULTS.overflowPostInsertRatio, DEFAULTS.rebuildWatermark);
  assert.notEqual(DEFAULTS.singleToolRatio, DEFAULTS.rebuildWatermark);
  assert.ok(DEFAULTS.overflowPostInsertRatio > DEFAULTS.rebuildWatermark, '安全阀在水位线之后');
});

test('overflow_guard 是纯程序：永不调用模型', () => {
  const dir = tmp();
  const adapter = new FakeAdapter();
  const g = new OverflowGuard({ nCtx: 1024, spillDir: dir });
  g.guardToolOutput('z'.repeat(20000), { currentTokens: 0, id: 'x' });
  assert.equal(adapter.summarizeCalls, 0);
  assert.equal(typeof OverflowGuard.prototype.summarize, 'undefined');
});

test('defaultCountTokens 对 CJK 与 ASCII 都给出正数', () => {
  assert.ok(defaultCountTokens('测试文本') > 0);
  assert.ok(defaultCountTokens('hello world') > 0);
  assert.equal(defaultCountTokens(''), 0);
});
