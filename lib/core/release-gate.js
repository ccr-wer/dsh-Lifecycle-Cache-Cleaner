/**
 * 统一清理闸门。
 *
 * 所有清理路径（会话删除 / 压缩完成 / 水位重建 / 手动）都必须经过这里，
 * 且只有这里能把「探测结论」翻译成「是否允许动引擎」。
 *
 * 铁律（与用户约定一致）：
 *  - 探测到本地没有部署（absent）      -> 不清理
 *  - 探测失败 / 适配器没实现探测（unknown）-> 不清理（fail-closed）
 *  - 有部署但归属对不上                 -> 不清理
 * 只有 present 且归属成立才 proceed。
 */
import { decide, VERDICT } from './ownership.js';

export const GATE_CODE = Object.freeze({
  OWNED: 'owned',
  SKIP_ABSENT: 'skip_absent',
  SKIP_UNKNOWN: 'skip_unknown',
  SKIP_NO_LEASE: 'skip_no_lease',
  SKIP_FOREIGN: 'skip_foreign',
});

const DEFAULT_TIMEOUT_MS = 300;

/**
 * “现场确实有东西”的状态集合。
 *
 * EngineProbe 返回 owned_idle/owned_busy/foreign，而 probeAdapter 只返回 present；
 * 两者都算“已部署”，具体归属交给 decide() 判。
 */
const DEPLOYED_STATES = new Set(['present', 'owned_idle', 'owned_busy', 'foreign']);

/**
 * 探测适配器背后的本地引擎。
 *
 * 适配器没实现 probeEngine 时返回 unknown —— 这是有意的：
 * 拿不到证据就不许删，宁可什么都不做。
 */
export async function probeAdapter(adapter, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!adapter || typeof adapter.probeEngine !== 'function') {
    return { state: 'unknown', snapshot: null, code: 'probe_unimplemented' };
  }

  let timer = null;
  try {
    const raw = await Promise.race([
      adapter.probeEngine(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe_timeout')), timeoutMs);
      }),
    ]);

    if (!raw || typeof raw !== 'object') {
      return { state: 'unknown', snapshot: null, code: 'probe_bad_snapshot' };
    }

    const models = Array.isArray(raw.models) ? raw.models : [];
    const slots = Array.isArray(raw.slots) ? raw.slots : [];

    if (raw.installed === false || (models.length === 0 && slots.length === 0)) {
      return { state: 'absent', snapshot: raw, code: 'engine_absent' };
    }
    return { state: 'present', snapshot: raw, code: 'ok' };
  } catch (err) {
    const code = err?.message === 'probe_timeout' ? 'probe_timeout' : 'probe_failed';
    return { state: 'unknown', snapshot: null, code };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把探测结论 + 归属证据翻译成放行/拒绝。
 *
 * @param {object} args
 * @param {string} args.probeState              'present' | 'absent' | 'unknown'
 * @param {object|null} [args.snapshot]
 * @param {object|null} [args.lease]            会话建立时登记的租约
 * @param {'lease'|'adapter-exclusive'} [args.ownership]
 *        lease                —— 必须有租约且三要素匹配（删除会话链路）
 *        adapter-exclusive    —— 适配器自身就是引擎所有者（单插件内自建引擎）
 * @param {string[]} [args.allowedPidPaths]
 */
export function evaluateGate({
  probeState,
  snapshot = null,
  lease = null,
  ownership = 'lease',
  allowedPidPaths = [],
  canonicalize = undefined,
} = {}) {
  if (!DEPLOYED_STATES.has(probeState)) {
    const v = decide({ lease, snapshot, probeState, allowedPidPaths, canonicalize });
    return {
      proceed: false,
      code: probeState === 'absent' ? GATE_CODE.SKIP_ABSENT : GATE_CODE.SKIP_UNKNOWN,
      cause: v.code,
      verdict: v.verdict,
      probeState,
    };
  }

  if (ownership === 'adapter-exclusive') {
    return { proceed: true, code: GATE_CODE.OWNED, probeState };
  }

  const v = decide({ lease, snapshot, probeState, allowedPidPaths, canonicalize });
  if (v.verdict === VERDICT.OWNED) {
    return { proceed: true, code: GATE_CODE.OWNED, probeState, detail: v };
  }
  return {
    proceed: false,
    code: v.code === 'no_lease' ? GATE_CODE.SKIP_NO_LEASE : GATE_CODE.SKIP_FOREIGN,
    cause: v.code,
    verdict: v.verdict,
    probeState,
  };
}
