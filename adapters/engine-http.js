/**
 * 本地引擎适配器（HTTP 侧）。
 *
 * 只做两件事：只读探测、经闸门放行后的释放。
 * 探测永远只有 GET；释放只有 ollama 有官方卸载语义（keep_alive: 0），
 * llama.cpp 的 server 没有卸载接口——那就明确报 absent/unsupported，
 * 不假装"清过了"。
 */

const DEFAULTS = Object.freeze({
  ollama: 'http://127.0.0.1:11434',
  llamacpp: 'http://127.0.0.1:8080',
});

async function getJson(url, { signal, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ac.abort(signal?.reason);
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.json() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

export class HttpEngineAdapter {
  constructor({ kind = 'auto', baseUrl = null, timeoutMs = 400 } = {}) {
    this.kind = kind;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  #urls() {
    if (this.baseUrl) return [{ kind: this.kind === 'auto' ? 'ollama' : this.kind, base: this.baseUrl }];
    if (this.kind === 'ollama') return [{ kind: 'ollama', base: DEFAULTS.ollama }];
    if (this.kind === 'llamacpp') return [{ kind: 'llamacpp', base: DEFAULTS.llamacpp }];
    return [
      { kind: 'ollama', base: DEFAULTS.ollama },
      { kind: 'llamacpp', base: DEFAULTS.llamacpp },
    ];
  }

  /** @returns {Promise<{installed:boolean, models:Array, slots:Array, kind:string}>} */
  async probeEngine({ signal } = {}) {
    const models = [];
    const slots = [];
    let kind = 'none';

    for (const target of this.#urls()) {
      try {
        if (target.kind === 'ollama') {
          const r = await getJson(`${target.base}/api/ps`, { signal, timeoutMs: this.timeoutMs });
          if (!r.ok) continue;
          const list = Array.isArray(r.body?.models) ? r.body.models : [];
          for (const m of list) {
            models.push({ name: m?.name ?? m?.model ?? 'unknown', kind: 'ollama', sizeVram: m?.size_vram ?? null });
          }
          kind = 'ollama';
          if (models.length > 0) break;
        } else {
          const r = await getJson(`${target.base}/props`, { signal, timeoutMs: this.timeoutMs });
          if (!r.ok) continue;
          const id = r.body?.model_path ?? r.body?.model_alias ?? r.body?.default_generation_settings?.model;
          if (id) models.push({ name: String(id), kind: 'llamacpp', sizeVram: null });
          kind = 'llamacpp';
          if (models.length > 0 || r.ok) break;
        }
      } catch {
        // 探测失败按"没探到"处理，最终由闸门判 unknown/absent，不在这里抛。
      }
    }

    return { installed: models.length > 0 || slots.length > 0, models, slots, kind };
  }

  /**
   * 释放。ollama：逐模型 keep_alive:0 卸载；llama.cpp 无卸载接口，直接报错让闸门链路上层看到。
   */
  async destroyEngine({ signal } = {}) {
    const snapshot = await this.probeEngine({ signal });
    if (snapshot.kind !== 'ollama') {
      throw new Error(`engine "${snapshot.kind}" 没有卸载接口，拒绝伪造释放结果`);
    }
    const base = this.baseUrl ?? DEFAULTS.ollama;
    for (const m of snapshot.models) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), Math.max(this.timeoutMs, 5000));
      try {
        const res = await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: m.name, keep_alive: 0, prompt: '' }),
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`unload ${m.name} failed: HTTP ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

export function createEngineAdapter(config = {}) {
  const engine = config.engine ?? {};
  if (engine.kind === 'none' || engine.enabled === false) return null;
  return new HttpEngineAdapter({
    kind: engine.kind ?? 'auto',
    baseUrl: engine.baseUrl ?? null,
    timeoutMs: engine.timeoutMs ?? 400,
  });
}
