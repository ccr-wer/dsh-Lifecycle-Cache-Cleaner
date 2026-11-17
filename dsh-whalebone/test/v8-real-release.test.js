/**
 * V8 假释放：必须验证真实下降。
 * 采样只用 footprint / vmmap / nvidia-smi，禁用 top；轮询 + 超时，不做单次快照断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeSampler,
  cleanAndVerify,
  SAMPLER_KIND,
} from '../../whalebone-core/vram-cleaner.js';
import { LeaseRegistry } from '../../whalebone-core/engine-lease.js';
import { EngineProbe } from '../../whalebone-core/engine-probe.js';
import { SessionDeleter, DELETE_STATE } from '../session-deleter.js';
import { createLlamaCppAdapter } from '../adapters/llamacpp.js';
import { fakeTransport, seqSampler, sleep } from './helpers/fakes.js';

const GB = 1024 ** 3;

test('V8-1：采样器拒绝 top，只允许 footprint / nvidia-smi', () => {
  assert.throws(
    () => makeSampler({ kind: 'top', pid: 1, exec: async () => '' }),
    /只允许 footprint \/ nvidia-smi/,
  );
  assert.throws(
    () => makeSampler({ kind: 'ps', pid: 1, exec: async () => '' }),
    /sampler_rejected/,
  );
});

test('V8-2：轮询检测到真实下降才算 verified', async () => {
  const sampler = seqSampler([8 * GB, 8 * GB, 8 * GB, 1 * GB]);
  const outcome = await cleanAndVerify({
    level: 'model',
    lease: { ref: { modelId: 'qwen3:32b', spawnedBy: 'dsh' } },
    adapter: { release: async () => ({ requested: true, verifiable: true }) },
    sampler,
    confirmed: true,
    timeoutMs: 400,
    intervalMs: 1,
  });

  assert.equal(outcome.status, 'released_verified');
  assert.equal(outcome.verified, true);
  assert.ok(outcome.deltaBytes >= 0.5 * outcome.before);
  assert.ok(outcome.attempts >= 1, '必须是轮询出来的，不是单次快照');
});

test('V8-3：一直没有下降 -> release_requested（不是失败，也不假装 verified）', async () => {
  const outcome = await cleanAndVerify({
    level: 'model',
    lease: { ref: { modelId: 'qwen3:32b', spawnedBy: 'dsh' } },
    adapter: { release: async () => ({ requested: true, verifiable: true }) },
    sampler: async () => 8 * GB,
    confirmed: true,
    timeoutMs: 60,
    intervalMs: 10,
  });

  assert.equal(outcome.status, 'release_requested');
  assert.equal(outcome.verified, false);
  assert.match(outcome.note, /已请求释放/);
  assert.ok(outcome.attempts >= 1);
});

test('V8-4：llama.cpp slot 档 -> unverifiable，明确标注不降 RSS', async () => {
  const transport = fakeTransport((call) => {
    if (call.method === 'GET' && call.url.endsWith('/slots')) {
      return [{ id: 0, is_processing: false }];
    }
    return {};
  });
  const adapter = createLlamaCppAdapter({
    transport,
    modelId: 'qwen3-32b-q4',
    pid: 4242,
  });
  const leases = new LeaseRegistry({});
  leases.register('s1', {
    provider: 'llamacpp',
    endpoint: 'http://127.0.0.1:8080',
    modelId: 'qwen3-32b-q4',
    slotId: 0,
    pid: 4242,
    spawnedBy: 'dsh',
  });

  const deleted = [];
  const deleter = new SessionDeleter({
    leases,
    probe: new EngineProbe({ timeoutMs: 50, ttlMs: 0 }),
    adapters: [adapter],
    transport,
    host: { deleteSession: async (id) => { deleted.push(id); } },
  });

  const r = await deleter.delete('s1', { releaseVram: true, level: 'slot' });

  assert.equal(r.state, DELETE_STATE.VERIFIED);
  assert.equal(r.releaseStatus, 'unverifiable');
  assert.equal(r.code, 'slot_erase_does_not_free_rss');
  assert.equal(r.verified, false, '清指针不等于释放内存');
  assert.deepEqual(deleted, ['s1']);
});

test('V8-5：nvidia-smi 采样按 MiB 解析，进程消失即视为 0', async () => {
  let phase = 0;
  const exec = async (cmd, args) => {
    assert.equal(cmd, 'nvidia-smi');
    assert.ok(args.includes('--query-compute-apps=pid,used_memory'));
    return phase++ === 0 ? '9999, 100\n1234, 512' : '9999, 100';
  };
  const sampler = makeSampler({ kind: SAMPLER_KIND.NVIDIA, pid: 1234, exec });

  assert.equal(await sampler(), 512 * 1024 ** 2);
  assert.equal(await sampler(), 0);
});

test('V8-6：footprint 采样在非 macOS 上直接拒绝，不产生假数据', () => {
  assert.throws(
    () => makeSampler({ kind: SAMPLER_KIND.FOOTPRINT, pid: 1, exec: async () => '', platform: 'linux' }),
    /仅 macOS/,
  );
});

test('V8-7：process 档只给 dsh 派生的引擎', async () => {
  const blocked = await cleanAndVerify({
    level: 'process',
    lease: { ref: { modelId: 'm', spawnedBy: 'user' } },
    adapter: { release: async () => ({ requested: true, verifiable: true }) },
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'process_requires_dsh_spawn');
});
