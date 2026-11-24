/**
 * 上下文压缩钩子：压缩成功后清一次 KV 缓存。
 *
 * 挂载点选 **`compaction/end`**，不是 `user/message` + source 判断：
 * - 成功：`compaction/end` 的 data 是 `{ compactionId, turn, sourceCommandId? }`；
 * - 失败：同一个事件，data 里多一个 `error`。
 * 所以“有没有 error”就是成功与否的判据，不必去解析 checkpoint 消息。
 *
 * 压缩会换掉整段上下文，旧 KV cache 已经没有复用价值；但**失败的压缩不清**——
 * 失败了上下文根本没变，清了只会让下一次请求重新算一遍。
 *
 * 为什么要 debounce：一次手动压缩可能连续收尾多个 span，或者连着两次压缩，
 * 没必要每次都走一遍探测 + 闸门。
 */

/** 默认合并窗口：同一个窗口内的多次压缩收尾只清一次。 */
export const COMPACT_DEBOUNCE_MS = 1500;

/**
 * 安装压缩钩子。
 * @param {object} ctx     Host 插件上下文（需要 `on`）
 * @param {object} runtime HostRuntime（需要 `clean` 与 `diagnostics`）
 * @param {object} [options]
 * @param {number} [options.debounceMs] 合并窗口
 * @param {Function} [options.setTimer]  可注入的定时器（测试用）
 * @param {Function} [options.clearTimer]
 * @returns {() => void} 卸载函数
 */
export function installCompactionHook(ctx, runtime, options = {}) {
  const { debounceMs = COMPACT_DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = options;
  if (!ctx || typeof ctx.on !== 'function' || !runtime) return () => {};

  let pending = null;

  const run = () => {
    pending = null;
    Promise.resolve()
      .then(() => runtime.clean({ confirm: true, trigger: 'compact' }))
      .catch((err) => runtime.diagnostics.push(`clean after compact: ${err?.message ?? err}`));
  };

  const listener = (session, event) => {
    if (!event || event.type !== 'compaction/end') return;
    // 失败的压缩什么也没换成，别清。
    if (event.data && event.data.error) return;
    if (pending !== null) return;
    pending = setTimer(run, debounceMs);
  };

  const off = ctx.on('session/event', listener, { global: true });

  return () => {
    try {
      off?.();
    } catch {
      /* 卸载异常不外抛 */
    }
    if (pending !== null) {
      clearTimer(pending);
      pending = null;
    }
  };
}
