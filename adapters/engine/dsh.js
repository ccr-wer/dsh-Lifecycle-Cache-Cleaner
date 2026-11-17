/**
 * DSH 宿主适配器。
 *
 * 这是唯一允许 `spawnedBy === 'dsh'` 的来源：引擎由 DSH 自己拉起，
 * 因此进程级释放才有资格。宿主通过注入的 handle 暴露能力，
 * core 不 require 宿主模块、也不直接 fetch。
 */

export function createDshAdapter({
  handle,
  endpoint = 'http://127.0.0.1:0',
  modelId,
  pid = null,
} = {}) {
  if (!handle) throw new Error('handle required（由宿主注入）');

  return {
    provider: 'dsh',
    endpoint,
    pid,
    spawnedBy: 'dsh',

    capabilities: {
      levels: ['slot', 'process'],
      slotSupported: true,
      slotFreesMemory: false,
      sharedService: false,
      verifiableBy: 'footprint',
      processLevelAllowed: true,
    },

    async read() {
      const snap = await handle.probeEngine();
      if (!snap || typeof snap !== 'object') throw new Error('dsh_handle_bad_snapshot');
      return {
        installed: snap.installed !== false,
        models: Array.isArray(snap.models) ? snap.models : [{ modelId, sizeBytes: snap.sizeBytes ?? null, busy: Boolean(snap.busy) }],
        slots: Array.isArray(snap.slots) ? snap.slots : [],
      };
    },

    async release({ level, lease }) {
      if (level === 'slot') {
        if (typeof handle.releaseSlot !== 'function') {
          return { requested: false, reason: 'host_has_no_slot_release' };
        }
        await handle.releaseSlot(lease?.ref?.slotId ?? 0);
        return { requested: true, verifiable: false, note: 'slot_release_does_not_free_rss' };
      }
      if (level === 'process') {
        // destroyEngine 是进程级语义，不是 slot 级
        await handle.destroyEngine();
        return { requested: true, verifiable: true, method: 'destroy_engine_process_level' };
      }
      return { requested: false, reason: 'level_unsupported' };
    },
  };
}
