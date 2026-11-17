/**
 * 宿主适配器契约。插件只依赖这 6 + 1 个方法。
 *
 * level 语义（误用最贵的一档就退化）：
 *   'ctx'     : 仅销毁/重建 context，保留 model 句柄（libllama 嵌入 / MLX）。亚秒级，可密触发。
 *   'engine'  : 释放引擎实例（vLLM sleep/wake 等）。1~3s，中频。
 *   'process' : 结束进程（llama-server / Ollama runner）。1~8s，低频。
 *
 * destroyEngine() 必须是**进程级**语义：
 *   多 slot（--parallel N>1）时，调用它意味着所有会话一起消失，
 *   调用方必须先把 N 份日志全部通过 L5+L6 才允许调用。
 *   写成"只清当前 slot"就是 bug，会把别的会话打挂。
 */
export class BaseAdapter {
  /** @returns {Promise<number>} 0~1 水位，必须含 chat template + 工具 schema 开销 */
  async usageRatio() {
    throw new Error('usageRatio() not implemented');
  }

  /** @returns {Promise<string>} 模型总结原文（JSON 数组字符串） */
  async summarize(_prompt, _opts) {
    throw new Error('summarize() not implemented');
  }

  /** @returns {Promise<void>} 真释放句柄。进程级语义。 */
  async destroyEngine() {
    throw new Error('destroyEngine() not implemented');
  }

  /** @returns {Promise<void>} 以新 n_ctx 重建会话（注入 systemPrompt） */
  async rebuildSession(_args) {
    throw new Error('rebuildSession() not implemented');
  }

  /** @returns {Promise<number>} 可用物理内存字节数，用于启动时定 n_ctx 档 */
  async availableMemory() {
    throw new Error('availableMemory() not implemented');
  }

  /** @returns {Promise<string>} 当前模型 ID，用于换模型检测 */
  async currentModelId() {
    throw new Error('currentModelId() not implemented');
  }

  /** @returns {Promise<boolean>} 句柄是否可用。默认 true，真实现应做 1-token 探活。 */
  async health() {
    return true;
  }

  /**
   * 本地引擎探测。必须反映“本机到底有没有部署”。
   *
   * 返回 `{ installed: boolean, models: Array, slots?: Array }`。
   * **不实现 = 未知 = 永不清理**（fail-closed），这是统一闸门的默认行为。
   *
   * @returns {Promise<{installed:boolean, models:Array, slots?:Array}>}
   */
  async probeEngine() {
    throw new Error('probeEngine() not implemented');
  }
}
