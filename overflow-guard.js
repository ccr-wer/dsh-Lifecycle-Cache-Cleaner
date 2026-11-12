/**
 * overflow_guard —— 入口闸门。纯程序，禁止调模型。
 *
 * 与 rebuild_watermark 彻底分开：
 *   - overflow_guard  : 单条工具输出 > 5% n_ctx，或插入后总水位 > 95%，直接落盘。
 *   - rebuild_watermark: 计划性重建触发器（75~80%），不在这里。
 * 两者共用同一个阈值变量 === 设计事故（见 README 的翻车点 #1）。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 默认 token 估算。CJK 约 1.5 char/token，其余约 4 char/token。
 * 注意：这只是估算，权威数字必须来自 adapter.usageRatio()（含模板/工具 schema 开销）。
 * 估算误差 > 5% 时应下调水位线，详见 test/overflow-guard.test.js。
 */
export function defaultCountTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

let seq = 0;

export class OverflowGuard {
  constructor({
    nCtx,
    singleToolRatio = 0.05,
    postInsertRatio = 0.95,
    spillDir,
    countTokens = defaultCountTokens,
  }) {
    if (!nCtx || nCtx <= 0) throw new Error('nCtx required');
    this.nCtx = nCtx;
    this.singleToolRatio = singleToolRatio;
    this.postInsertRatio = postInsertRatio;
    this.spillDir = spillDir;
    this.countTokens = countTokens;
  }

  get singleToolLimit() {
    return Math.floor(this.singleToolRatio * this.nCtx);
  }

  /** 插入后总水位是否越界。 */
  exceedsPostInsert(currentTokens, incomingTokens = 0) {
    if (!this.nCtx) return false;
    return (currentTokens + incomingTokens) / this.nCtx > this.postInsertRatio;
  }

  /**
   * @returns {{text:string, truncated:boolean, tokens:number, originalTokens:number, spillPath:string|null}}
   */
  guardToolOutput(text, { currentTokens = 0, id = 'tool' } = {}) {
    const raw = String(text ?? '');
    const originalTokens = this.countTokens(raw);
    const overSingle = originalTokens > this.singleToolLimit;
    const overPost = this.exceedsPostInsert(currentTokens, originalTokens);

    if (!overSingle && !overPost) {
      return {
        text: raw,
        truncated: false,
        tokens: originalTokens,
        originalTokens,
        spillPath: null,
      };
    }

    const spillPath = this.#spill(raw, id);
    const reason = overSingle ? 'single-entry' : 'post-insert';
    const placeholder = `[tool output truncated: ${spillPath}, ${originalTokens} tokens, reason=${reason}]`;
    return {
      text: placeholder,
      truncated: true,
      tokens: this.countTokens(placeholder),
      originalTokens,
      spillPath,
    };
  }

  #spill(content, id) {
    const dir = this.spillDir || path.join(process.cwd(), 'spill');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(id).replace(/[^\w.-]/g, '_').slice(0, 40);
    seq += 1;
    const file = path.join(dir, `${safe}-${Date.now()}-${seq}.txt`);
    fs.writeFileSync(file, content, 'utf8');
    return file;
  }
}
