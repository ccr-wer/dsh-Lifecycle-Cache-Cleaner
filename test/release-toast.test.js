import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HostRuntime } from '../lib/host/runtime.js';
import { publicStatus } from '../lib/host/web-api.js';

// K 系列：清理结果的“提示依据”。UI 靠 lastRelease.seq 变化弹一条，
// 所以这里锁死三件事：成功要记、没部署要记、预览不许记。

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-toast-'));

/** 探测得到已部署引擎的适配器。 */
const presentAdapter = () => ({
  probeEngine: async () => ({ installed: true, models: [{ name: 'qwen2.5' }], slots: [] }),
  destroyEngine: async () => {},
});

/** 本机没有部署：按闸门必须停在 absent。 */
const absentAdapter = () => ({
  probeEngine: async () => ({ installed: false, models: [], slots: [] }),
  destroyEngine: async () => {
    throw new Error('不该被调用');
  },
});

test('K1 成功释放会留下 lastRelease，status 能投影出来', async () => {
  const runtime = new HostRuntime({ rootDir: tmpRoot(), adapter: presentAdapter(), config: { releaseOnDelete: true } });

  assert.equal(runtime.lastRelease, null, '没清理过就不该有记录');

  const result = await runtime.clean({ confirm: true, trigger: 'tool' });
  assert.equal(result.released, true);
  assert.equal(runtime.lastRelease.released, true);
  assert.equal(runtime.lastRelease.trigger, 'tool');
  assert.equal(runtime.lastRelease.code, 'released');
  assert.equal(runtime.lastRelease.seq, 1);
  assert.ok(runtime.lastRelease.at > 0);

  const projected = publicStatus(await runtime.status());
  assert.equal(projected.lastRelease.seq, 1);
  assert.equal(projected.lastRelease.released, true);
  assert.equal(projected.lastRelease.trigger, 'tool');
});

test('K2 本地没有部署时也留一条记录（UI 要提示“没清到”）', async () => {
  const runtime = new HostRuntime({ rootDir: tmpRoot(), adapter: absentAdapter() });

  const result = await runtime.clean({ confirm: true, trigger: 'manual' });
  assert.equal(result.released, false);
  assert.equal(result.code, 'skip_absent');

  assert.equal(runtime.lastRelease.code, 'skip_absent');
  assert.equal(runtime.lastRelease.released, false);
  assert.equal(runtime.lastRelease.probeState, 'absent', '要带上探测结论，提示里才能说是“没部署”');
});

test('K3 预览（缺 confirm）不算一次尝试，不写 lastRelease', async () => {
  const runtime = new HostRuntime({ rootDir: tmpRoot(), adapter: presentAdapter() });

  const preview = await runtime.clean({});
  assert.equal(preview.code, 'confirm_required');
  assert.equal(runtime.lastRelease, null, '打开面板不该弹“没有清理”的提示');
  assert.equal(runtime.releaseSeq, 0);
});

test('K4 每次尝试递增 seq，UI 靠它判断“有新结果”', async () => {
  const runtime = new HostRuntime({ rootDir: tmpRoot(), adapter: presentAdapter() });

  await runtime.clean({ confirm: true });
  const first = runtime.lastRelease.seq;
  await runtime.clean({ confirm: true });
  assert.equal(runtime.lastRelease.seq, first + 1);
});

test('K5 会话删除触发的清理带 trigger=session-deleted', async () => {
  const runtime = new HostRuntime({ rootDir: tmpRoot(), adapter: presentAdapter(), config: { releaseOnDelete: true } });

  await runtime.handleSessionsRemoved(['--ws--/session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
  assert.equal(runtime.lastRelease.trigger, 'session-deleted');
  assert.equal(runtime.lastRelease.released, true);
});

test('K6 释放抛错时记成 release_failed，提示能显示原因', async () => {
  const runtime = new HostRuntime({
    rootDir: tmpRoot(),
    adapter: {
      probeEngine: async () => ({ installed: true, models: [{ name: 'qwen2.5' }], slots: [] }),
      destroyEngine: async () => {
        throw new Error('端口被占用');
      },
    },
  });

  const result = await runtime.clean({ confirm: true });
  assert.equal(result.code, 'release_failed');
  assert.match(runtime.lastRelease.reason, /端口被占用/);
  assert.equal(runtime.lastRelease.released, false);
});
