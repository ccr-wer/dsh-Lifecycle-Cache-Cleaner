/**
 * 廉价微固化（默认路径，不是可选优化）。
 *
 * 每轮结束由程序把「最近 user 消息 + 工具签名」append 到 `## 原始轨迹`。
 * 规则：不调模型、不校验、不阻塞、失败静默。
 * 不变量：`## 原始轨迹` 必须是日志最后一节，append 才是 O(1) 且永不破坏前面的结构。
 */
import fs from 'node:fs';
import path from 'node:path';

export const TRACE_SECTION = '## 原始轨迹';
const MAX_USER_CHARS = 500;

function fmtTool(t) {
  if (typeof t === 'string') return t.slice(0, 80);
  const name = t?.name || 'tool';
  let args = t?.args;
  if (args !== undefined) {
    args = typeof args === 'string' ? args : JSON.stringify(args);
    args = String(args).replace(/\s+/g, ' ').slice(0, 60);
  }
  return args ? `${name}(${args})` : `${name}()`;
}

export function ensureTraceSection(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# Worklog\n\n${TRACE_SECTION}\n`, 'utf8');
    return;
  }
  const content = fs.readFileSync(logPath, 'utf8');
  if (!content.includes(TRACE_SECTION)) {
    fs.appendFileSync(logPath, `\n${TRACE_SECTION}\n`, 'utf8');
  }
}

/**
 * @returns {boolean} 是否写入成功。失败静默，绝不抛。
 */
export function appendRawTrace({ logPath, turn, userText = '', tools = [] }) {
  try {
    ensureTraceSection(logPath);
    const user = String(userText).replace(/\s+/g, ' ').trim().slice(0, MAX_USER_CHARS);
    const sig = (Array.isArray(tools) ? tools : []).map(fmtTool).join(', ') || '-';
    fs.appendFileSync(logPath, `- t${turn} | user: ${user || '-'} | tools: ${sig}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 取原始轨迹整段（重建时原样保留，不能被 render 覆盖掉）。 */
export function extractTraceSection(md) {
  if (!md) return '';
  const i = md.indexOf(TRACE_SECTION);
  if (i < 0) return '';
  return md.slice(i + TRACE_SECTION.length).replace(/^\s*\n/, '');
}

export function readRawTraceTail({ logPath, maxTurns = 3, maxChars = 2000 }) {
  try {
    if (!fs.existsSync(logPath)) return '';
    const body = extractTraceSection(fs.readFileSync(logPath, 'utf8'));
    const lines = body.split('\n').filter((l) => l.trim().startsWith('- t'));
    const tail = lines.slice(-Math.max(1, maxTurns)).join('\n');
    return tail.slice(-maxChars);
  } catch {
    return '';
  }
}
