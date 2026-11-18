/**
 * 跨平台能力：采样器、路径归一、rename 重试。
 *
 * 这组用例钉的是「同一套判定在三平台上行为一致」，
 * 而不是某个平台的实现细节：
 *  X1 按环境选采样器；未知平台 -> 没有采样器（归 unverifiable）
 *  X2 Windows 工作集采样（tasklist CSV，含千分位）
 *  X3 Linux Pss 采样，回退 VmRSS，进程消失 -> 0
 *  X4 采样器与平台不匹配时直接抛，不许静默降级
 *  X5 路径归一能解软链/junction 别名；不归一时该判定为不放行
 *  X6 win32 大小写归一、linux 保持敏感
 *  X7 rename 只对瞬时错误重试，真实错误一次就抛
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeSampler, pickSamplerKind, SAMPLER_KIND } from '../lib/core/vram-cleaner.js';
import { canonicalPath, makeCanonicalizer, decide, VERDICT } from '../lib/core/ownership.js';
import { renameWithRetry } from '../lib/core/atomic.js';

test('X1：按平台/硬件选采样器，未知平台返回 null', () => {
  assert.equal(pickSamplerKind({ platform: 'darwin' }), SAMPLER_KIND.FOOTPRINT);
  assert.equal(pickSamplerKind({ platform: 'linux' }), SAMPLER_KIND.PROC_RSS);
  assert.equal(pickSamplerKind({ platform: 'win32' }), SAMPLER_KIND.WIN_RSS);
  assert.equal(pickSamplerKind({ platform: 'linux', hasNvidia: true }), SAMPLER_KIND.NVIDIA);
  assert.equal(pickSamplerKind({ platform: 'win32', hasNvidia: true }), SAMPLER_KIND.NVIDIA);
  assert.equal(pickSamplerKind({ platform: 'freebsd' }), null);
});

test('X2：Windows 工作集采样解析 tasklist CSV（含千分位），进程不在即 0', async () => {
  const exec = async (cmd, args) => {
    assert.equal(cmd, 'tasklist');
    assert.ok(args.includes('/NH'));
    return '"node.exe","1234","Console","1","1,234,567 K"\r\n';
  };
  const hit = makeSampler({ kind: SAMPLER_KIND.WIN_RSS, pid: 1234, exec, platform: 'win32' });
  assert.equal(await hit(), 1234567 * 1024);

  const miss = makeSampler({ kind: SAMPLER_KIND.WIN_RSS, pid: 999, exec, platform: 'win32' });
  assert.equal(await miss(), 0, '不在列表 = 进程已退出');
});

test('X3：Linux 优先 Pss，回退 VmRSS，进程消失即 0', async () => {
  const pssReader = async (file) => {
    assert.match(file, /^\/proc\/1234\/smaps_rollup$/);
    return 'Pss:              2048 kB\n';
  };
  const byPss = makeSampler({
    kind: SAMPLER_KIND.PROC_RSS,
    pid: 1234,
    exec: async () => '',
    readText: pssReader,
    platform: 'linux',
  });
  assert.equal(await byPss(), 2048 * 1024);

  const fallback = async (file) => {
    if (file.endsWith('smaps_rollup')) throw new Error('EACCES');
    return 'Name:\tnode\nVmRSS:\t    4096 kB\n';
  };
  const byRss = makeSampler({
    kind: SAMPLER_KIND.PROC_RSS,
    pid: 1234,
    exec: async () => '',
    readText: fallback,
    platform: 'linux',
  });
  assert.equal(await byRss(), 4096 * 1024);

  const gone = makeSampler({
    kind: SAMPLER_KIND.PROC_RSS,
    pid: 4321,
    exec: async () => '',
    readText: async () => {
      throw new Error('ENOENT');
    },
    platform: 'linux',
  });
  assert.equal(await gone(), 0);
});

test('X4：采样器与平台不匹配直接抛，不静默降级', () => {
  const exec = async () => '';
  assert.throws(
    () => makeSampler({ kind: SAMPLER_KIND.WIN_RSS, pid: 1, exec, platform: 'linux' }),
    /仅 Windows/,
  );
  assert.throws(
    () => makeSampler({ kind: SAMPLER_KIND.PROC_RSS, pid: 1, exec, platform: 'win32' }),
    /仅 Linux/,
  );
  assert.throws(
    () => makeSampler({ kind: SAMPLER_KIND.FOOTPRINT, pid: 1, exec, platform: 'linux' }),
    /仅 macOS/,
  );
});

const LEASE_ALIAS = {
  ref: {
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    modelId: 'qwen3:32b',
    spawnedBy: 'user',
    pidPath: 'C:\\link\\ollama.exe',
  },
};
const SNAPSHOT = { models: [{ modelId: 'qwen3:32b' }], slots: [] };

test('X5：路径归一能解软链/junction 别名；不归一时不放行', () => {
  const noAlias = decide({
    lease: LEASE_ALIAS,
    snapshot: SNAPSHOT,
    probeState: 'present',
    allowedPidPaths: ['C:\\Tools\\Ollama'],
    canonicalize: makeCanonicalizer({ platform: 'win32' }),
  });
  assert.equal(noAlias.verdict, VERDICT.UNKNOWN, '别名不归一 -> 判不出来就不许清理');

  const withAlias = decide({
    lease: LEASE_ALIAS,
    snapshot: SNAPSHOT,
    probeState: 'present',
    allowedPidPaths: ['C:\\Tools\\Ollama'],
    canonicalize: makeCanonicalizer({
      platform: 'win32',
      realpath: (p) => String(p).replace(/^C:\\link/i, 'C:\\Tools\\Ollama'),
    }),
  });
  assert.equal(withAlias.verdict, VERDICT.OWNED);
});

test('X6：win32 大小写归一，linux 保持敏感', () => {
  assert.equal(
    canonicalPath('C:\\Tools\\Ollama', { platform: 'win32' }),
    'c:\\tools\\ollama',
  );
  assert.equal(
    canonicalPath('C:\\Tools\\Ollama', { platform: 'linux' }),
    'C:\\Tools\\Ollama',
  );
});

test('X7：rename 只对瞬时错误重试，真实错误一次就抛', () => {
  let n = 0;
  const flaky = {
    renameSync: () => {
      n += 1;
      if (n < 3) {
        const e = new Error('locked by scanner');
        e.code = 'EPERM';
        throw e;
      }
    },
  };
  const ok = renameWithRetry('a.tmp', 'a', { fs: flaky, sleep: () => {} });
  assert.deepEqual(ok, { ok: true, attempts: 3 });

  let m = 0;
  const hard = {
    renameSync: () => {
      m += 1;
      const e = new Error('no such file');
      e.code = 'ENOENT';
      throw e;
    },
  };
  assert.throws(() => renameWithRetry('a.tmp', 'a', { fs: hard, sleep: () => {} }), /no such file/);
  assert.equal(m, 1, '非瞬时错误不许重试');

  let k = 0;
  const always = {
    renameSync: () => {
      k += 1;
      const e = new Error('busy');
      e.code = 'EBUSY';
      throw e;
    },
  };
  assert.throws(() => renameWithRetry('a.tmp', 'a', { fs: always, retries: 2, sleep: () => {} }), /busy/);
  assert.equal(k, 3, 'retries + 1 次尝试');
});
