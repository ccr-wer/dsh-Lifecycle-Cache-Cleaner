/**
 * 分级清理 + 真实释放验证。
 *
 * 分级：slot（默认）-> model（keep_alive:0，需显式勾选）-> process（仅 dsh 派生）。
 * 验证只认 footprint / vmmap / nvidia-smi；**禁用 top**（top 的 RSS 漏 compressor，
 * 对 malloc_zone 归还也迟钝，是"假释放"的主要来源）。
 * 验证一律轮询 + 超时，不做单次快照断言。
 */
export const CLEAN_LEVELS = Object.freeze({ SLOT: 'slot', MODEL: 'model', PROCESS: 'process' });

export const CLEAN_STATUS = Object.freeze({
  VERIFIED: 'released_verified',
  REQUESTED: 'release_requested',
  UNVERIFIABLE: 'unverifiable',
  BLOCKED: 'blocked',
  FAILED: 'cleanup_failed',
});

export const SAMPLER_KIND = Object.freeze({ FOOTPRINT: 'footprint', NVIDIA: 'nvidia-smi' });

const VALID_LEVELS = new Set(Object.values(CLEAN_LEVELS));

function parseSize(text) {
  const m = /([\d.]+)\s*(K|M|G|KiB|MiB|GiB)?/i.exec(String(text).trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const u = String(m[2] || '').toUpperCase();
  if (u.startsWith('K')) return n * 1024;
  if (u.startsWith('M')) return n * 1024 ** 2;
  if (u.startsWith('G')) return n * 1024 ** 3;
  return n;
}

/**
 * 采样器工厂。exec 由宿主注入（core 不直接起进程）。
 * kind 只允许 footprint / nvidia-smi —— 传其它（尤其 'top'）直接抛。
 */
export function makeSampler({ kind, pid, exec, platform = process.platform }) {
  if (!Object.values(SAMPLER_KIND).includes(kind)) {
    throw new Error(`sampler_rejected: ${kind}（只允许 footprint / nvidia-smi，禁用 top）`);
  }
  if (typeof exec !== 'function') throw new Error('exec required');

  if (kind === SAMPLER_KIND.FOOTPRINT) {
    if (platform !== 'darwin') throw new Error('footprint sampler 仅 macOS');
    return async () => {
      const out = String((await exec('vmmap', ['-summary', String(pid)])) ?? '');
      const m = /Physical footprint:\s+([\d.]+)([KMG])/i.exec(out);
      if (!m) throw new Error('footprint_unparsable');
      return parseSize(`${m[1]}${m[2]}`);
    };
  }

  return async () => {
    const out = String(
      (await exec('nvidia-smi', [
        '--query-compute-apps=pid,used_memory',
        '--format=csv,noheader,nounits',
      ])) ?? '',
    );
    for (const line of out.split('\n')) {
      const [p, used] = line.split(',').map((x) => x.trim());
      if (String(p) === String(pid)) {
        // nounits 模式下数字单位是 MiB；带单位时按单位解析
        if (/[A-Za-z]/.test(used || '')) return parseSize(used) ?? 0;
        const n = Number(used);
        return Number.isFinite(n) ? n * 1024 ** 2 : 0;
      }
    }
    return 0; // 进程已不在计算应用列表里 = 已释放
  };
}

/**
 * @returns {{status:string, level:string, verified:boolean, before:number|null,
 *            after:number|null, deltaBytes:number|null, attempts:number, code:string, note?:string}}
 */
export async function cleanAndVerify({
  level = CLEAN_LEVELS.SLOT,
  lease,
  adapter,
  snapshot = null,
  sampler = null,
  timeoutMs = 1500,
  intervalMs = 100,
  minDropBytes = null,
  minDropRatio = 0.5,
  confirmed = false,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  audit = () => {},
} = {}) {
  const base = { level, verified: false, before: null, after: null, deltaBytes: null, attempts: 0 };

  if (!VALID_LEVELS.has(level)) {
    return { ...base, status: CLEAN_STATUS.BLOCKED, code: 'level_invalid' };
  }

  // process 档只给 dsh 自己派生的引擎
  if (level === CLEAN_LEVELS.PROCESS && lease?.ref?.spawnedBy !== 'dsh') {
    audit({ type: 'clean_blocked', level, code: 'process_requires_dsh_spawn' });
    return { ...base, status: CLEAN_STATUS.BLOCKED, code: 'process_requires_dsh_spawn' };
  }
  // model 档会波及同实例的其它客户端，必须显式勾选
  if (level === CLEAN_LEVELS.MODEL && confirmed !== true) {
    audit({ type: 'clean_blocked', level, code: 'model_requires_confirmation' });
    return { ...base, status: CLEAN_STATUS.BLOCKED, code: 'model_requires_confirmation' };
  }

  const caps = adapter?.capabilities || {};
  if (Array.isArray(caps.levels) && !caps.levels.includes(level)) {
    audit({ type: 'clean_blocked', level, code: 'level_unsupported' });
    return { ...base, status: CLEAN_STATUS.BLOCKED, code: 'level_unsupported' };
  }

  let before = null;
  if (sampler) {
    try {
      before = await sampler();
    } catch {
      before = null;
    }
  }

  let release;
  try {
    release = await adapter.release({ level, lease, snapshot });
  } catch (err) {
    audit({ type: 'clean_failed', level, code: 'release_threw', message: err.message });
    return { ...base, before, status: CLEAN_STATUS.FAILED, code: 'release_threw' };
  }

  if (!release?.requested) {
    audit({ type: 'clean_blocked', level, code: release?.reason || 'release_declined' });
    return { ...base, before, status: CLEAN_STATUS.BLOCKED, code: release?.reason || 'release_declined' };
  }

  // 引擎自述"这次动作不会降内存"（如 llama.cpp slot erase / seq_rm）-> 不装作验证过
  if (release.verifiable === false) {
    audit({ type: 'clean_unverifiable', level, code: release.note || 'not_verifiable' });
    return {
      ...base,
      before,
      status: CLEAN_STATUS.UNVERIFIABLE,
      code: release.note || 'not_verifiable',
      note: release.note,
    };
  }

  if (!sampler || before === null || before <= 0) {
    audit({ type: 'clean_unverifiable', level, code: 'no_sampler_or_zero_baseline' });
    return { ...base, before, status: CLEAN_STATUS.UNVERIFIABLE, code: 'no_sampler_or_zero_baseline' };
  }

  const need = Number.isFinite(minDropBytes) ? minDropBytes : before * minDropRatio;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let after = before;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    attempts += 1;
    try {
      after = await sampler();
    } catch {
      break;
    }
    const delta = before - after;
    if (delta >= need) {
      audit({ type: 'clean_verified', level, before, after, delta, attempts });
      return {
        ...base,
        before,
        after,
        deltaBytes: delta,
        attempts,
        verified: true,
        status: CLEAN_STATUS.VERIFIED,
        code: 'drop_detected',
      };
    }
  }

  audit({ type: 'clean_requested', level, before, after, attempts });
  return {
    ...base,
    before,
    after,
    deltaBytes: before - after,
    attempts,
    status: CLEAN_STATUS.REQUESTED,
    code: 'timeout_waiting_drop',
    note: '已请求释放，生效有延迟',
  };
}
