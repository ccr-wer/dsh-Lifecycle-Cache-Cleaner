/**
 * V7 假归属：有同名模型但无 engine_ref -> foreign/unknown，且零写操作。
 * 探测路径上任何写操作都必须被拒（readOnlyTransport 会直接抛）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LeaseRegistry } from '../lib/core/engine-lease.js';
import { EngineProbe } from '../lib/core/engine-probe.js';
import { SessionDeleter, DELETE_STATE } from '../session-deleter.js';
import { createOllamaAdapter } from '../adapters/ollama.js';
import { fakeTransport, fakeAdapter, seqSampler } from './helpers/fakes.js';

const PS_BODY = { models: [{ name: 'qwen3:32b', size_vram: 8 * 1024 ** 3 }] };

function setup({ leaseRef = null, handler = () => PS_BODY, releaseImpl, capabilities } = {}) {
  const transport = fakeTransport(handler);
  const adapter = createOllamaAdapter({ transport });
  const leases = new LeaseRegistry({});
  if (leaseRef) leases.register('s1', leaseRef);
  const probe = new EngineProbe({ timeoutMs: 50, ttlMs: 0 });
  const deleted = [];
  const audit = [];
  const deleter = new SessionDeleter({
    leases,
    probe,
    adapters: [adapter],
    transport,
    host: { deleteSession: async (id) => { deleted.push(id); } },
    audit: (e) => audit.push(e),
  });
  return { transport, adapter, leases, probe, deleter, deleted, audit };
}

test('V7-1：本机有同名模型但没有 engine_ref -> foreign，零写操作，会话照删', async () => {
  const { transport, deleter, deleted } = setup();

  const r = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });

  assert.equal(r.state, DELETE_STATE.SKIP_CLEAN);
  assert.equal(r.verdict, 'foreign');
  assert.equal(r.code, 'no_lease');
  assert.equal(r.cleaned, false);
  assert.equal(transport.writes, 0, '探测期不得有任何写操作');
  assert.deepEqual(deleted, ['s1'], '会话必须照常删除');
});

test('V7-2：租约模型与现场不符 -> unknown，不清理', async () => {
  const { transport, deleter, deleted } = setup({
    leaseRef: {
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      modelId: 'llama3:70b',
      spawnedBy: 'dsh',
    },
  });

  const r = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });

  assert.equal(r.state, DELETE_STATE.SKIP_CLEAN);
  assert.equal(r.probeState, 'unknown');
  assert.equal(r.code, 'probe_unknown');
  assert.equal(transport.writes, 0);
  assert.deepEqual(deleted, ['s1']);
});

test('V7-3：租约没写 spawnedBy=dsh 且 pid 路径不在白名单 -> unknown', async () => {
  const { transport, deleter } = setup({
    leaseRef: {
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      modelId: 'qwen3:32b',
      spawnedBy: 'user',
      pid: 4242,
      pidPath: '/opt/homebrew/bin/ollama',
    },
  });

  const r = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });

  assert.equal(r.state, DELETE_STATE.SKIP_CLEAN);
  assert.equal(r.code, 'spawn_untrusted');
  assert.equal(transport.writes, 0);
});

test('V7-4：三要素全中才真正写一次（keep_alive:0）', async () => {
  const { transport, deleter, deleted } = setup({
    leaseRef: {
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      modelId: 'qwen3:32b',
      spawnedBy: 'dsh',
      pid: 4242,
    },
  });

  const r = await deleter.delete('s1', {
    releaseVram: true,
    level: 'model',
    confirmModel: true,
    sampler: seqSampler([8 * 1024 ** 3, 8 * 1024 ** 3, 1024 ** 3]),
    verifyTimeoutMs: 300,
    verifyIntervalMs: 1,
  });

  assert.equal(r.state, DELETE_STATE.VERIFIED);
  assert.equal(r.releaseStatus, 'released_verified');
  assert.equal(transport.writes, 1, '只有归属确认后才允许一次写操作');
  assert.equal(transport.calls.filter((c) => c.method === 'POST').length, 1);
  assert.deepEqual(deleted, ['s1']);
});

test('V7-5：model 档未显式勾选 -> blocked，不写', async () => {
  const { transport, deleter } = setup({
    leaseRef: {
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      modelId: 'qwen3:32b',
      spawnedBy: 'dsh',
    },
  });

  const r = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: false });

  assert.equal(r.state, DELETE_STATE.SKIP_CLEAN);
  assert.equal(r.code, 'model_requires_confirmation');
  assert.equal(transport.writes, 0);
});

test('V7-6：UI 描述——absent 不渲染，foreign/unknown 渲染为禁用态', async () => {
  const absent = fakeAdapter({
    snapshot: { installed: true, models: [], slots: [] },
  });
  const { deleter } = setup();
  const deleterAbsent = new SessionDeleter({
    leases: new LeaseRegistry({}),
    probe: new EngineProbe({ ttlMs: 0 }),
    adapters: [absent],
    transport: fakeTransport(() => ({ models: [] })),
    host: { deleteSession: async () => {} },
  });

  const foreignDesc = deleter.describeCleanupOption({
    probeResult: { state: 'foreign', snapshot: { models: [{ modelId: 'qwen3:32b' }] } },
    lease: null,
  });
  assert.equal(foreignDesc.render, true);
  assert.equal(foreignDesc.enabled, false);
  assert.equal(foreignDesc.reason, 'no_lease');

  const absentDesc = deleterAbsent.describeCleanupOption({
    probeResult: { state: 'absent', snapshot: { models: [] } },
    lease: null,
  });
  assert.equal(absentDesc.render, false);

  const unknownDesc = deleter.describeCleanupOption({
    probeResult: { state: 'unknown', snapshot: null },
    lease: null,
  });
  assert.equal(unknownDesc.render, true);
  assert.equal(unknownDesc.enabled, false);
});

test('V7-7：登记时形状不全 -> 拒绝登记（宁可 unknown，不留半截租约）', () => {
  const leases = new LeaseRegistry({});
  const r = leases.register('s1', { provider: 'ollama', endpoint: 'http://x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ref_incomplete');
  assert.equal(leases.get('s1'), null);
});
