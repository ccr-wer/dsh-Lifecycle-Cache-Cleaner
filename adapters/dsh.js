/**
 * DSH (DeepSeek Harness / Cordis) 适配器 —— 空壳，待填。
 *
 * 待确认的宿主 API（全部标 TODO，不要凭猜测实现）：
 *
 * 1) 生命周期钩子名
 *    - 是否存在"上下文将满"事件？（对应 rebuild_watermark 的最好挂载点）
 *    - 插件卸载语义：Cordis 的 ctx.on('dispose') / ctx.effect() 是否可作为
 *      "引擎销毁前"窗口？若可，onModelSwitch 的前置窗口就有了。
 *    - 是否存在 session end / beforeExit？
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
 *    - 是否有官方 usage（含模板/工具 schema）？还是只能自己算？
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

  async usageRatio() {
    // TODO: 优先读宿主 usage；退化方案见 README「待宿主确认项」
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
