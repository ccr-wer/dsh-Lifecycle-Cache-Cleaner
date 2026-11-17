/** 测试用假适配器：模拟"句柄"生命周期，不碰真引擎。 */
import { BaseAdapter } from '../../adapters/base.js';

export const VALID_SUMMARY = JSON.stringify([
  { status: 'decision', text: '选择 Node 内置 test runner，因为零依赖，文件 test/a.test.js' },
  { status: 'todo', text: '补 V4 对抗日志，文件 test/b.test.js' },
]);

export class FakeAdapter extends BaseAdapter {
  constructor(opts = {}) {
    super();
    this._usage = opts.usage ?? 0.5;
    this.modelId = opts.modelId ?? 'qwen3-32b-q4';
    this.summary = opts.summary ?? VALID_SUMMARY;
    this.summarizeCalls = 0;
    this.destroyCalls = 0;
    this.rebuildCalls = 0;
    this.handleValid = true;
    this.destroyed = false;
    this.failSummarize = opts.failSummarize ?? false;
    this.failRebuild = opts.failRebuild ?? 0; // 剩余失败次数
    this.lastSystemPrompt = null;
    this.lastNCtx = null;
    this.lastLevel = null;
    this.probeCalls = 0;
    // 默认模拟“本机有部署”；传 { probe: {...} } / { probe: () => ... } / { probe: new Error() } 可改
    this.probeResult = opts.probe ?? {
      installed: true,
      models: [{ modelId: this.modelId, sizeBytes: 8 * 1024 ** 3 }],
      slots: [],
    };
  }

  async probeEngine() {
    this.probeCalls += 1;
    if (this.probeResult instanceof Error) throw this.probeResult;
    if (typeof this.probeResult === 'function') return await this.probeResult();
    return this.probeResult;
  }

  async usageRatio() {
    return this._usage;
  }

  async summarize() {
    this.summarizeCalls += 1;
    if (this.failSummarize) throw new Error('model oom');
    return this.summary;
  }

  async destroyEngine() {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.handleValid = false;
  }

  async rebuildSession({ nCtx, systemPrompt, level }) {
    this.rebuildCalls += 1;
    if (this.failRebuild > 0) {
      this.failRebuild -= 1;
      this.handleValid = false;
      throw new Error('rebuild boom');
    }
    this.handleValid = true;
    this.destroyed = false;
    this.lastNCtx = nCtx;
    this.lastLevel = level;
    this.lastSystemPrompt = systemPrompt;
  }

  async availableMemory() {
    return 64 * 1024 ** 3;
  }

  async currentModelId() {
    return this.modelId;
  }

  async health() {
    return this.handleValid;
  }
}
