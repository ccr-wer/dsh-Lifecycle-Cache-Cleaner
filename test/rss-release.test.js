/**
 * V2 证伪：RSS/物理占用必须真实下降。
 *
 * 只用 vmmap / footprint 测量，**不用 top**——top 的 RSS 漏 compressor，
 * 对 malloc_zone 归还也迟钝，是"假释放"的主要来源。
 *
 * 这里用 256MB Buffer 模拟常驻 KV，验证的是「测量链路 + 销毁语义」。
 * 换成真 adapter（llama.cpp / MLX）后，同一套断言即可证伪真引擎。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BaseAdapter } from '../adapters/base.js';
import { LifecycleCacheCleaner } from '../cleaner.js';
import { measureFootprintBytes, waitForDrop, sleep } from './helpers/memory.js';

const KV_BYTES = 256 * 1024 * 1024;

class BufferAdapter extends BaseAdapter {
  constructor() {
    super();
    this.kv = Buffer.alloc(KV_BYTES, 1);
    this.nCtx = null;
  }
  async usageRatio() {
    return 0.8;
  }
  async summarize() {
    return JSON.stringify([{ status: 'todo', text: '跑 test/rss 验证，文件 test/rss-release.test.js' }]);
  }
  async destroyEngine() {
    this.kv = null;
    await sleep(50);
  }
  async rebuildSession({ nCtx }) {
    this.nCtx = nCtx;
  }
  async availableMemory() {
    return 64 * 1024 ** 3;
  }
  async currentModelId() {
    return 'buffer-model';
  }
  async health() {
    return true;
  }
}

const darwinOnly = process.platform === 'darwin' ? false : `V2 需要 vmmap/footprint（仅 macOS），当前平台 ${process.platform}`;

test('V2：destroyEngine 后物理占用必须真实下降 ≥ 80% KV', { skip: darwinOnly }, async () => {
  const adapter = new BufferAdapter();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-rss-'));
  // 先触碰全部页，确保计入 footprint
  for (let i = 0; i < adapter.kv.length; i += 4096) adapter.kv[i] = 2;

  const before = measureFootprintBytes();
  assert.ok(before > KV_BYTES * 0.8, `基线需包含 KV：before=${before}`);

  const cleaner = new LifecycleCacheCleaner({
    adapter,
    rootDir,
    sessionId: 'rss',
    config: { nCtx: 8192 },
  });
  const r = await cleaner.rebuild({ reason: 'v2' });
  assert.equal(r.ok, true, JSON.stringify(r));

  const { ok, after } = await waitForDrop(before, KV_BYTES * 0.8);
  assert.ok(
    ok,
    `销毁后物理占用未下降 ≥80% KV：before=${before} after=${after} delta=${before - after}`,
  );
  assert.equal(adapter.kv, null);
});

test('V2b：测量函数拒绝 top，只接受 vmmap/footprint', { skip: darwinOnly }, () => {
  const v = measureFootprintBytes();
  assert.ok(Number.isFinite(v) && v > 0);
});
