/**
 * llama.cpp / llama-server 适配器。
 *
 * 探测：GET /slots（只读）。单模型服务器，模型名由启动参数给定。
 * 释放：
 *   slot    -> POST /slots/{id}?action=erase
 *              **只清指针，不降 RSS**（seq_rm 语义）。返回 verifiable:false，
 *              刻意不伪装成已释放。
 *   process -> 结束 dsh 自己派生的进程（唯一能真正归还内存的路径）
 *   model   -> 不支持（llama-server 没有"卸载模型保留进程"的接口）
 */

export function normalizeSlotsPayload(body, modelId) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.slots) ? body.slots : null;
  if (!list) throw new Error('bad_slots_payload');
  const slots = list.map((s) => ({
    slotId: s.id ?? s.slot_id ?? s.slotId,
    modelId,
    busy: Boolean(s.is_processing ?? s.busy ?? false),
  }));
  const busy = slots.some((s) => s.busy);
  return {
    installed: true,
    models: [{ modelId, sizeBytes: null, busy }],
    slots,
  };
}

export function createLlamaCppAdapter({
  transport,
  endpoint = 'http://127.0.0.1:8080',
  modelId,
  pid = null,
  kill = null,
} = {}) {
  if (!transport) throw new Error('transport required');
  if (!modelId) throw new Error('modelId required（llama-server 是单模型）');

  return {
    provider: 'llamacpp',
    endpoint,
    pid,

    capabilities: {
      levels: ['slot', 'process'],
      slotSupported: true,
      slotFreesMemory: false, // seq_rm 只清指针
      sharedService: false,
      verifiableBy: 'footprint',
    },

    async read({ transport: ro }) {
      const res = await ro.request({ method: 'GET', url: `${endpoint}/slots` });
      return normalizeSlotsPayload(res, modelId);
    },

    async release({ level, lease }) {
      if (level === 'slot') {
        const slotId = lease?.ref?.slotId ?? 0;
        await transport.request({
          method: 'POST',
          url: `${endpoint}/slots/${slotId}?action=erase`,
        });
        return {
          requested: true,
          verifiable: false,
          method: 'slot_erase',
          // README 必须写明：这一步不降 RSS，别把"清空"当"释放"
          note: 'slot_erase_does_not_free_rss',
        };
      }

      if (level === 'process') {
        if (lease?.ref?.spawnedBy !== 'dsh') {
          return { requested: false, reason: 'process_requires_dsh_spawn' };
        }
        const targetPid = lease.ref.pid ?? pid;
        if (!targetPid) return { requested: false, reason: 'pid_unknown' };
        if (typeof kill !== 'function') return { requested: false, reason: 'kill_not_injected' };
        await kill(targetPid);
        return { requested: true, verifiable: true, method: 'process_kill' };
      }

      return { requested: false, reason: 'level_unsupported' };
    },
  };
}
