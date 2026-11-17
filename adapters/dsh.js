/**
 * DSH (DeepSeek Harness / Cordis) 适配器 —— 空壳，待填。
 *
 * 待确认的宿主 API（全部标 TODO，不要凭猜测实现）：
 *
 * 1) 生命周期钩子名
 *    - 【已确认】存在原生上下文压缩：服务 `ctx.compaction`（CompactionEngine），
 *      随包自带 `@deepseek-ai/dsh-compaction-basic`（自动）与 `/compact`（手动）。
 *      压缩会向会话日志追加 `compaction/start|summary|end`，**只写日志、不进 surface**。
 *      我们的挂载点：`compaction/end`（无 error）-> LifecycleCacheCleaner.onCompacted()。
 *    - 【已确认】token 计量走 `ctx.tokenMeter`，不要再按字符数自估。
 *    - 【待确认】Cordis 的 ctx.on('dispose') / ctx.effect() 能否作为"引擎销毁前"窗口。
 *
 * 2) 引擎清理接口
 *    - DSH 是否自己持有 llama.cpp context？还是走外部 llama-server / Ollama？
 *    - 有没有 export 出 ctx 句柄（决定用 'ctx' 档还是 'process' 档）
 *    - 若走外部 server：进程 pid / 端口从哪拿？
 *
 * 3) parallel 模式默认值
 *    - 默认 --parallel 是 1 还是 N？这决定"一进程一会话"是否成立。
 *
 * 4) token 计量
 *    - 【已确认】见 part 1：`ctx.tokenMeter`。
 *
 * 5) 模型切换
 *    - 切换是"改 provider 配置"还是"重启 runtime"？有无切换前回调？
 */
import { BaseAdapter } from './base.js';

export class DshAdapter extends BaseAdapter {
  constructor(host) {
    super();
    this.host = host;
    this._handle = null;
  }

  /**
   * 能力探测。宿主没挂压缩后端时 compaction=false，
   * cleaner 会自动回退到自带水位触发——绝不假设能力存在。
   */
  get capabilities() {
    const ctx = this.host?.ctx;
    return {
      compaction: Boolean(ctx?.compaction),
      tokenMeter: Boolean(ctx?.tokenMeter),
    };
  }

  /**
   * 压缩锁：DSH 用未闭合的 `compaction/start` 当持久锁。
   * 宿主未实现时抛错，cleaner 会按“忙”处理（宁可不动）。
   */
  async isCompactionOpen() {
    if (typeof this.host?.isCompactionOpen === 'function') {
      return await this.host.isCompactionOpen();
    }
    throw new Error('TODO: DshAdapter.isCompactionOpen（需读会话日志中未闭合的 compaction/start）');
  }

  async usageRatio() {
    // TODO: 优先读宿主 ctx.tokenMeter；拿不到再退到 defaultCountTokens 估算
    throw new Error('TODO: DshAdapter.usageRatio');
  }

  async summarize(prompt, opts) {
    // TODO: 用当前会话的模型做一次独立调用（temperature=0，maxTokens=opts.maxTokens）
    throw new Error('TODO: DshAdapter.summarize');
  }

  async destroyEngine() {
    // TODO: 进程级销毁。绝不允许退化成"只清当前 slot"
    throw new Error('TODO: DshAdapter.destroyEngine');
  }

  async rebuildSession({ nCtx, systemPrompt, level }) {
    // TODO: 按 level 走 ctx / engine / process 三档
    throw new Error(`TODO: DshAdapter.rebuildSession(${level}, nCtx=${nCtx})`);
  }

  async availableMemory() {
    // TODO: macOS 上建议读 memory pressure 而非"空闲内存"
    throw new Error('TODO: DshAdapter.availableMemory');
  }

  async currentModelId() {
    // TODO: 返回稳定的模型标识（含量化档位，换量化也应触发重建）
    throw new Error('TODO: DshAdapter.currentModelId');
  }

  async health() {
    // TODO: 1-token 探活
    return false;
  }
}
