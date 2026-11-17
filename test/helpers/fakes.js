/** 测试替身：不依赖真实引擎。 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带写操作计数的假 transport。
 * handler 收到的 {method,url,body} 决定返回什么。
 */
export function fakeTransport(handler, { delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    get writes() {
      return calls.filter((c) => c.method !== 'GET').length;
    },
    get reads() {
      return calls.filter((c) => c.method === 'GET').length;
    },
    async request(opts = {}) {
      const call = {
        method: String(opts.method || 'GET').toUpperCase(),
        url: opts.url,
        body: opts.body,
      };
      calls.push(call);
      if (delayMs) await sleep(delayMs);
      return handler(call);
    },
  };
}

/** 通用假适配器：read/release 都可注入。 */
export function fakeAdapter({
  provider = 'ollama',
  endpoint = 'http://127.0.0.1:11434',
  snapshot = {
    installed: true,
    models: [{ modelId: 'qwen3:32b', sizeBytes: 8 * 1024 ** 3, busy: false }],
    slots: [],
  },
  releaseImpl = async () => ({ requested: true, verifiable: true, method: 'fake' }),
  capabilities = { levels: ['slot', 'model', 'process'] },
  readImpl = null,
} = {}) {
  return {
    provider,
    endpoint,
    capabilities,
    async read() {
      if (readImpl) return readImpl();
      return snapshot;
    },
    async release(args) {
      return releaseImpl(args);
    },
  };
}

/** 按序列产出采样值，耗尽后重复最后一个。 */
export function seqSampler(values) {
  let i = 0;
  const fn = async () => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    return v;
  };
  fn.calls = () => i;
  return fn;
}
