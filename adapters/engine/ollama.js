/**
 * Ollama 适配器。
 *
 * 探测：GET /api/ps（只读）。
 * 释放：POST /api/generate {keep_alive:0} —— 这是**服务级**动作，
 *       Ollama 是共享服务，/api/ps 不告诉你模型被哪个客户端占用。
 *       所以只有租约三要素全中才允许走这里。
 */

export function normalizePsPayload(body) {
  const list = Array.isArray(body?.models) ? body.models : null;
  if (!list) throw new Error('bad_ps_payload');
  const models = list.map((m) => ({
    modelId: String(m.name ?? m.model ?? ''),
    sizeBytes: Number(m.size_vram ?? m.size ?? NaN),
    busy: false,
  }));
  return { installed: true, models, slots: [] };
}

export function createOllamaAdapter({ transport, endpoint = 'http://127.0.0.1:11434' } = {}) {
  if (!transport) throw new Error('transport required');

  return {
    provider: 'ollama',
    endpoint,

    capabilities: {
      levels: ['slot', 'model', 'process'],
      // slot 档对 Ollama 无意义：它没有 per-slot 概念
      slotSupported: false,
      // keep_alive:0 会卸载整个模型实例，同机其它客户端一起受影响
      sharedService: true,
      verifiableBy: 'ps_absence',
    },

    async read({ transport: ro }) {
      const res = await transportRequest(ro, { method: 'GET', url: `${endpoint}/api/ps` });
      return normalizePsPayload(res);
    },

    async release({ level, lease }) {
      if (level === 'slot') {
        return { requested: false, reason: 'ollama_has_no_slot_level' };
      }
      if (level === 'process' && lease?.ref?.spawnedBy !== 'dsh') {
        return { requested: false, reason: 'process_requires_dsh_spawn' };
      }
      await transportRequest(transport, {
        method: 'POST',
        url: `${endpoint}/api/generate`,
        body: { model: lease.ref.modelId, keep_alive: 0 },
      });
      return {
        requested: true,
        verifiable: true,
        method: 'keep_alive:0',
        note: 'shared_service_unload',
      };
    },
  };
}

function transportRequest(t, opts) {
  return t.request(opts);
}
