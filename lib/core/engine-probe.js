/**
 * 只读探测层。
 *
 * 约束：
 *  - 返回枚举，不返回布尔。
 *  - 异步 + 短超时（默认 300ms），绝不阻塞删除流程。
 *  - TTL 缓存（默认 30s），absent 命中即短路。
 *  - 只走只读端点；探测期发生写操作 = 直接抛，被归约为 unknown。
 *  - 任何异常/超时/字段缺失 -> unknown，不外抛。
 */
const nowDefault = () => Date.now();

export const PROBE_STATE = Object.freeze({
  ABSENT: 'absent',
  FOREIGN: 'foreign',
  OWNED_IDLE: 'owned_idle',
  OWNED_BUSY: 'owned_busy',
  UNKNOWN: 'unknown',
});

/** 读操作白名单：探测路径上只允许 GET。 */
export function readOnlyTransport(transport) {
  return {
    async request(opts = {}) {
      const method = String(opts.method || 'GET').toUpperCase();
      if (method !== 'GET') {
        throw new Error(`probe_violation: ${method} ${opts.url}`);
      }
      return transport.request(opts);
    },
  };
}

function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeMode(snapshot) {
  const models = Array.isArray(snapshot?.models) ? snapshot.models : [];
  const slots = Array.isArray(snapshot?.slots) ? snapshot.slots : [];
  return {
    installed: snapshot?.installed !== false,
    models: models.map((m) => ({
      modelId: String(m.modelId ?? ''),
      sizeBytes: Number.isFinite(m.sizeBytes) ? m.sizeBytes : null,
      busy: Boolean(m.busy),
    })),
    slots: slots.map((s) => ({
      slotId: s.slotId,
      modelId: s.modelId === undefined ? null : String(s.modelId),
      busy: Boolean(s.busy),
    })),
  };
}

/** 探测标签（给 UI 用的粗分类）；真正的安全阀在 ownership.js。 */
export function classify(snapshot, lease) {
  const s = normalizeMode(snapshot);
  // 租约有两种形态：registry 返回的 {ref:{...}}，或裸的 engine_ref。两种都吃。
  const ref = lease?.ref ?? lease ?? null;

  if (!s.installed) return PROBE_STATE.ABSENT;
  if (s.models.length === 0 && s.slots.length === 0) return PROBE_STATE.ABSENT;
  if (!ref) return PROBE_STATE.FOREIGN;

  const modelHit =
    s.models.some((m) => m.modelId === ref.modelId) ||
    s.slots.some((x) => x.modelId && x.modelId === ref.modelId);
  if (!modelHit) return PROBE_STATE.UNKNOWN; // 租约与现场矛盾 -> 不猜

  if (ref.slotId !== undefined && ref.slotId !== null) {
    const slot = s.slots.find((x) => String(x.slotId) === String(ref.slotId));
    if (!slot) return PROBE_STATE.UNKNOWN;
    return slot.busy ? PROBE_STATE.OWNED_BUSY : PROBE_STATE.OWNED_IDLE;
  }

  const busy =
    s.models.some((m) => m.modelId === ref.modelId && m.busy) ||
    s.slots.some((x) => x.modelId === ref.modelId && x.busy);
  return busy ? PROBE_STATE.OWNED_BUSY : PROBE_STATE.OWNED_IDLE;
}

export class EngineProbe {
  constructor({ timeoutMs = 300, ttlMs = 30_000, now = nowDefault, audit = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.ttlMs = ttlMs;
    this.now = now;
    this.audit = audit;
    this.cache = new Map();
  }

  cacheKey(adapter) {
    return `${adapter.provider}|${adapter.endpoint}`;
  }

  /**
   * @returns {{state:string, snapshot:object|null, cached:boolean, elapsedMs:number, code:string}}
   * 永不抛异常。
   */
  async probe({ adapter, lease, transport }) {
    const started = this.now();
    const key = this.cacheKey(adapter);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) {
      return { ...hit.result, cached: true, elapsedMs: this.now() - started };
    }

    let result;
    try {
      const ro = readOnlyTransport(transport);
      const snapshot = await withTimeout(
        adapter.read({ transport: ro, timeoutMs: this.timeoutMs }),
        this.timeoutMs,
        'probe_timeout',
      );
      const state = classify(snapshot, lease);
      result = { state, snapshot: normalizeMode(snapshot), cached: false, code: 'ok' };
    } catch (err) {
      // 超时 / 非法 JSON / 字段缺失 / 探测期写了东西 -> 一律 unknown
      result = {
        state: PROBE_STATE.UNKNOWN,
        snapshot: null,
        cached: false,
        code: err?.message === 'probe_timeout' ? 'probe_timeout' : 'probe_error',
      };
    }

    // unknown 不进缓存：下次删除必须重新探测
    if (result.state !== PROBE_STATE.UNKNOWN) {
      this.cache.set(key, { at: this.now(), result });
    }
    this.audit({ type: 'probe', key, state: result.state, code: result.code });
    return { ...result, elapsedMs: this.now() - started };
  }

  invalidate(adapter) {
    this.cache.delete(this.cacheKey(adapter));
  }
}
