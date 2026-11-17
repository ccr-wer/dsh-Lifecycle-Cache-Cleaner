/**
 * V10 并发：删除与压缩重建同时触发 -> 互斥生效，无双清理、无死锁。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LeaseRegistry } from '../lib/core/engine-lease.js';
import { EngineProbe } from '../lib/core/engine-probe.js';
import { SessionDeleter, DELETE_STATE } from '../session-deleter.js';
import { createOllamaAdapter } from '../adapters/ollama.js';
import { fakeTransport, seqSampler } from './helpers/fakes.js';

const LEASE = {
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  modelId: 'qwen3:32b',
  spawnedBy: 'dsh',
};

function setup({ busy = () => false } = {}) {
  const transport = fakeTransport(() => ({ models: [{ name: 'qwen3:32b', size_vram: 8 * 1024 ** 3 }] }));
  const adapter = createOllamaAdapter({ transport });
  const leases = new LeaseRegistry({});
  leases.register('s1', LEASE);
  const deleted = [];
  const deleter = new SessionDeleter({
    leases,
    probe: new EngineProbe({ timeoutMs: 50, ttlMs: 0 }),
    adapters: [adapter],
    transport,
    host: { deleteSession: async (id) => { deleted.push(id); } },
    isBusy: busy,
  });
  return { transport, leases, deleter, deleted };
}

const dropSampler = () => seqSampler([8 * 1024 ** 3, 8 * 1024 ** 3, 1024 ** 3]);

test('V10-1：压缩重建进行中 -> skipped_busy，不探测、不清理、不排队', async () => {
  const { transport, deleter, deleted } = setup({ busy: () => true });

  const r = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });

  assert.equal(r.state, DELETE_STATE.SKIPPED_BUSY);
  assert.equal(r.code, 'compression_in_progress');
  assert.equal(r.cleaned, false);
  assert.equal(transport.calls.length, 0, '互斥时不碰引擎');
  assert.deepEqual(deleted, ['s1'], '会话仍然要删');
});

test('V10-2：并发删除同一会话 -> 幂等，只清理一次', async () => {
  const { transport, deleter, deleted } = setup();

  const [a, b] = await Promise.all([
    deleter.delete('s1', {
      releaseVram: true,
      level: 'model',
      confirmModel: true,
      sampler: dropSampler(),
      verifyTimeoutMs: 300,
      verifyIntervalMs: 1,
    }),
    deleter.delete('s1', {
      releaseVram: true,
      level: 'model',
      confirmModel: true,
      sampler: dropSampler(),
      verifyTimeoutMs: 300,
      verifyIntervalMs: 1,
    }),
  ]);

  assert.equal(a, b, '并发删除应复用同一个 Promise');
  assert.equal(transport.writes, 1, '不得双清理');
  assert.deepEqual(deleted, ['s1'], '不得重复删会话');
});

test('V10-3：与重建互斥不引入死锁（2s 内必须收敛）', async () => {
  let busy = true;
  const { deleter } = setup({ busy: () => busy });

  const first = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });
  assert.equal(first.state, DELETE_STATE.SKIPPED_BUSY);

  // 重建结束后可以正常清理（无残留锁）
  busy = false;
  const guard = new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 2000));
  const second = await Promise.race([
    deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true }),
    guard,
  ]);
  assert.notEqual(second.state, DELETE_STATE.SKIPPED_BUSY);
});

test('V10-4：清理失败不回滚、不阻塞，且租约必被释放', async () => {
  const { transport, leases, deleter, deleted } = setup();
  transport.request = async (opts) => {
    const method = String(opts.method || 'GET').toUpperCase();
    if (method === 'GET') return { models: [{ name: 'qwen3:32b', size_vram: 8 * 1024 ** 3 }] };
    throw new Error('engine exploded');
  };

  const r = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });

  assert.equal(r.state, DELETE_STATE.CLEANUP_FAILED);
  assert.equal(r.deleted, true, '清理失败不影响会话删除');
  assert.deepEqual(deleted, ['s1']);
  assert.equal(leases.get('s1'), null, '租约必须释放，避免留下幽灵归属');
});

test('V10-5：删除完成后重复调用 -> 不会二次释放', async () => {
  const { transport, deleter } = setup();
  await deleter.delete('s1', {
    releaseVram: true,
    level: 'model',
    confirmModel: true,
    sampler: dropSampler(),
    verifyTimeoutMs: 300,
    verifyIntervalMs: 1,
  });
  const writesAfterFirst = transport.writes;

  const again = await deleter.delete('s1', { releaseVram: true, level: 'model', confirmModel: true });
  assert.equal(again.state, DELETE_STATE.SKIP_CLEAN, '租约已释放 -> 无归属，不清理');
  assert.equal(transport.writes, writesAfterFirst);
});
