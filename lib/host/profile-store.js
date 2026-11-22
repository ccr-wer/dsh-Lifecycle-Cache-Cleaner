/**
 * 用户自有的“助手设定”：称呼、名字、回复风格、长期指令、人设。
 *
 * 和 `lib/core/memory-store.js` 是两回事，刻意分开：
 *   - 记忆是**模型提议、用户确认**，条目化、去重、可升级；
 *   - 这里是**只有用户能写**的一份设定，模型没有写入口（没有工具、没有接口），
 *     落盘在 `<rootDir>/lifecycle-cache/profile.json`，重建时原样注入 prompt。
 *
 * 写入走 `writeFileAtomic`：设定文件很小，但半写会让下一次读出 JSON 语法错误，
 * 与其在读取端兜底，不如在写入端保证要么旧要么新。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';

/** 回复风格的封闭取值；UI 用本地化标签展示，prompt 里写成人话。 */
export const STYLE_IDS = Object.freeze(['default', 'concise', 'detailed']);

const STYLE_TEXT = Object.freeze({
  default: '默认',
  concise: '简洁，先给结论',
  detailed: '详细，给出推理与依据',
});

/** 字段长度上限：挡住一次误粘贴把 prompt 撑爆。 */
export const LIMITS = Object.freeze({
  assistantName: 60,
  userName: 60,
  instructions: 4000,
  persona: 4000,
});

export const PROFILE_FILE = 'profile.json';

const EMPTY = Object.freeze({
  assistantName: '',
  userName: '',
  style: 'default',
  instructions: '',
  persona: '',
  updatedAt: 0,
});

/** 校验失败时抛这个，`code` 直接进 HTTP 响应。 */
export class ProfileError extends Error {
  constructor(message) {
    super(message);
    this.code = 'invalid_profile';
  }
}

function text(value, key) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ProfileError(`${key} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > LIMITS[key]) {
    throw new ProfileError(`${key} 超过 ${LIMITS[key]} 个字符（当前 ${trimmed.length}）`);
  }
  return trimmed;
}

/** 把任意输入收敛成一个完整、可序列化的设定对象。 */
export function normalizeProfile(raw) {
  if (raw === undefined || raw === null) return { ...EMPTY };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ProfileError('设定必须是对象');
  const style = STYLE_IDS.includes(raw.style) ? raw.style : 'default';
  return {
    assistantName: text(raw.assistantName, 'assistantName'),
    userName: text(raw.userName, 'userName'),
    style,
    instructions: text(raw.instructions, 'instructions'),
    persona: text(raw.persona, 'persona'),
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : 0,
  };
}

/** 只有用户填过东西才值得占 prompt；全空就返回空串，不生成空标题。 */
export function isEmptyProfile(profile) {
  return !profile.assistantName && !profile.userName && !profile.instructions && !profile.persona;
}

/**
 * 渲染成 prompt 片段。全空返回空串；部分填写只渲染填了的那几行。
 */
export function renderProfilePrompt(profile) {
  const value = normalizeProfile(profile);
  if (isEmptyProfile(value)) return '';
  const lines = ['## 用户设定的助手设定（由用户在界面里编辑，模型不写）', ''];
  if (value.userName) lines.push(`- 称呼用户：${value.userName}`);
  if (value.assistantName) lines.push(`- 你的名字：${value.assistantName}`);
  if (value.style && value.style !== 'default') lines.push(`- 回复风格：${STYLE_TEXT[value.style]}`);
  if (value.instructions) {
    lines.push('- 长期指令：');
    for (const line of value.instructions.split(/\r?\n/)) lines.push(`  ${line}`.trimEnd());
  }
  if (value.persona) {
    lines.push('- 人设：');
    for (const line of value.persona.split(/\r?\n/)) lines.push(`  ${line}`.trimEnd());
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 设定文件的位置与读写。读取永远不抛：坏文件按“还没设置”处理，
 * 但**写入**必须成功，否则 UI 会以为保存了。
 */
export class ProfileStore {
  constructor({ rootDir } = {}) {
    if (!rootDir) throw new Error('ProfileStore: rootDir required');
    this.rootDir = rootDir;
    this.path = path.join(rootDir, 'lifecycle-cache', PROFILE_FILE);
  }

  read() {
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      return normalizeProfile(JSON.parse(raw));
    } catch (err) {
      if (err instanceof ProfileError) return { ...EMPTY };
      return { ...EMPTY };
    }
  }

  /** 合并式写入：只覆盖传进来的字段，`updatedAt` 由这里盖章。 */
  write(patch) {
    const merged = { ...this.read(), ...(patch ?? {}), updatedAt: Date.now() };
    const normalized = normalizeProfile(merged);
    writeFileAtomic(this.path, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }

  promptText() {
    return renderProfilePrompt(this.read());
  }
}
