/**
 * 崩溃恢复状态机 + 原子持久化。
 *
 * 关键约束（不可改）：
 *  - committed_log_path 只在 validated -> tearing_down 迁移时写入。
 *  - 非法迁移直接抛错，不许静默放过。
 *  - 每次迁移都落盘（tmp -> fsync -> rename），否则 tearing_down 崩了就丢。
 */
import fs from 'node:fs';
import path from 'node:path';

export const PHASES = Object.freeze({
  IDLE: 'idle',
  SUMMARIZING: 'summarizing',
  VALIDATED: 'validated',
  TEARING_DOWN: 'tearing_down',
  REBUILDING: 'rebuilding',
  COMMITTED: 'committed',
  ROLLED_BACK: 'rolled_back',
});

const LEGAL = {
  [PHASES.IDLE]: [PHASES.SUMMARIZING],
  [PHASES.SUMMARIZING]: [PHASES.VALIDATED, PHASES.ROLLED_BACK],
  [PHASES.VALIDATED]: [PHASES.TEARING_DOWN, PHASES.ROLLED_BACK],
  [PHASES.TEARING_DOWN]: [PHASES.REBUILDING, PHASES.ROLLED_BACK],
  [PHASES.REBUILDING]: [PHASES.COMMITTED, PHASES.ROLLED_BACK],
  [PHASES.COMMITTED]: [PHASES.IDLE],
  [PHASES.ROLLED_BACK]: [PHASES.IDLE],
};

export function isLegalTransition(from, to) {
  return (LEGAL[from] || []).includes(to);
}

/** 启动时读 phase，决定续跑动作。 */
export function recoveryAction(phase) {
  switch (phase) {
    case PHASES.TEARING_DOWN:
      return 'resume_rebuild'; // 日志已提交、引擎已销毁 -> 直接重建
    case PHASES.REBUILDING:
      return 'retry_rebuild'; // 重建中断 -> 重试
    case PHASES.SUMMARIZING:
    case PHASES.VALIDATED:
      return 'discard'; // 尚未提交日志 -> 丢弃临时态
    default:
      return 'none';
  }
}

export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export class StateStore {
  constructor(file, { sessionId = 'default' } = {}) {
    this.file = file;
    this.sessionId = sessionId;
    this.state = readJson(file) || {
      session_id: sessionId,
      phase: PHASES.IDLE,
      target_ctx: null,
      committed_log_path: null,
      last_error: null,
      reason: null,
      updated_at: Date.now(),
    };
  }

  get phase() {
    return this.state.phase;
  }

  transition(to, patch = {}) {
    const from = this.state.phase;
    if (!isLegalTransition(from, to)) {
      throw new Error(`illegal transition: ${from} -> ${to}`);
    }
    if (to === PHASES.TEARING_DOWN) {
      if (!patch.committed_log_path) {
        throw new Error('tearing_down requires committed_log_path (日志必须先提交)');
      }
    } else if (patch.committed_log_path !== undefined && to !== PHASES.IDLE) {
      throw new Error(`committed_log_path 只允许在 validated->tearing_down 写入 (got ${to})`);
    }
    this.state = { ...this.state, ...patch, phase: to, updated_at: Date.now() };
    writeJsonAtomic(this.file, this.state);
    return this.state;
  }
}
