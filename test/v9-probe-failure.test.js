/**
 * V9 探测失败：非预期 JSON / 超时 / 缺字段 -> unknown 且不清理，
 * 删除主流程必须正常完成。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LeaseRegistry } from '../lib/core/engine-lease.js';
import { EngineProbe } from '../lib/core/engine-probe.js';
import { SessionDeleter, DELETE_STATE } from '../session-deleter.js';
import { createOllamaAdapter } from '../adapters/engine/ollama.js';
import { fakeTransport } from './helpers/fakes.js';

const LEASE = {
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  modelId: 'qwen3:32b',
  spawnedBy: 'dsh',
};

function setup({ handler, delayMs = 0, probeTimeoutMs = 50 } = {}) {
  const transport = fakeTransport(handler, { delayMs });
  const adapter = createOllamaAdapter({ transport });
  const leases = new LeaseRegistry({});
  leases.register('s1', LEASE);
  const deleted = [];
  const audit = [];
  // 审计必须同时挂到 probe 上，否则 probe 层的 unknown 留不下痕
  const probe = new EngineProbe({ timeoutMs: probeTimeoutMs, ttlMs: 0, audit: (e) => audit.push(e) });
  const deleter = new SessionDeleter({
    leases,
    probe,
    adapters: [adapter],
    transport,
    host: { deleteSession: async (id) => { deleted.push(id); } },
    audit: (e) => audit.push(e),
  });
  return { transport, deleter, deleted, audit, probe };
}

const assertSkipUnknown = (r, deleted) => {
  assert.equal(r.state, DELETE_STATE.SKIP_CLEAN);
  assert.equal(r.code, 'probe_unknown');
  assert.equal(r.cleaned, false);
  assert.equal(r.deleted, true);
  assert.deepEqual(deleted, ['s1']);
};

test('V9-1：transport 抛错 -> unknown，不清理，删除照常完成', async () => {
  const { transport, deleter, deleted } = setup({
    handler: () => {
      throw new Error('ECONNREFUSED');
    },
  });

  const r = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });

  assertSkipUnknown(r, deleted);
  assert.equal(transport.writes, 0);
});

test('V9-2：非预期 JSON（缺 models 字段）-> unknown', async () => {
  const { deleter, deleted } = setup({ handler: () => ({ nope: true }) });
  const r = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });
  assertSkipUnknown(r, deleted);
});

test('V9-3：探测超时 -> unknown，且不阻塞删除', async () => {
  const { deleter, deleted } = setup({
    handler: () => ({ models: [{ name: 'qwen3:32b' }] }),
    delayMs: 200,
    probeTimeoutMs: 20,
  });

  const t0 = Date.now();
  const r = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });
  const elapsed = Date.now() - t0;

  assertSkipUnknown(r, deleted);
  assert.ok(elapsed < 150, `探测不得拖住删除，实际 ${elapsed}ms`);
});

test('V9-4：字段缺失（size_vram 缺失不影响判定，但空对象判 unknown）', async () => {
  const { deleter, deleted } = setup({ handler: () => ({ models: null }) });
  const r = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });
  assertSkipUnknown(r, deleted);
});

test('V9-5：unknown 不进 TTL 缓存，下次删除会重新探测', async () => {
  let fail = true;
  const { deleter, transport } = setup({
    handler: () => {
      if (fail) throw new Error('boom');
      return { models: [{ name: 'qwen3:32b', size_vram: 8 * 1024 ** 3 }] };
    },
  });

  await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });
  const readsAfterFirst = transport.reads;

  fail = false;
  const r2 = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });

  assert.ok(transport.reads > readsAfterFirst, 'unknown 必须重新探测');
  assert.notEqual(r2.code, 'probe_unknown', '恢复后应能重新判定归属');
});

test('V9-6：探测失败不妨碍审计留痕', async () => {
  const { deleter, audit } = setup({
    handler: () => {
      throw new Error('boom');
    },
  });
  await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });

  const probeEntry = audit.find((e) => e.type === 'probe');
  assert.equal(probeEntry.state, 'unknown');
  assert.equal(probeEntry.code, 'probe_error');
});
