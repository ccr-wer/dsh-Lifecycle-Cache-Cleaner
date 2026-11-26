/**
 * 会话删除监听。
 *
 * 宿主没有“会话已删除”事件：删除是 UI/其它插件做文件级操作
 * （`dsh-session-manager` 就是自己 rm 会话目录）。
 * 所以我们只能观察文件系统：`sessions/<工作区目录>/session-<uuid>/`。
 *
 * 轮询而不是 fs.watch：Windows 上递归 watch 会漏事件，
 * 两层 readdir 每几秒一次的成本可以忽略，且行为在所有平台一致。
 */
import fs from 'node:fs';
import path from 'node:path';

export class SessionWatcher {
  constructor({ sessionsDir, intervalMs = 5000, onRemoved = null, onError = null } = {}) {
    if (!sessionsDir) throw new Error('SessionWatcher: sessionsDir required');
    this.sessionsDir = sessionsDir;
    this.intervalMs = intervalMs;
    this.onRemoved = onRemoved;
    this.onError = onError;
    this.prev = new Set();
    this.timer = null;
    this.scans = 0;
    this.lastScanAt = null;
  }

  #list() {
    let workspaces;
    try {
      workspaces = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      const wsDir = path.join(this.sessionsDir, ws.name);
      let entries;
      try {
        entries = fs.readdirSync(wsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // 目录名有两种：`session-<uuid>`（本机新建）与 `<uuid>`（App 历史导入）。
        if (!isSessionDirName(entry.name)) continue;
        out.push(`${ws.name}/${entry.name}`);
      }
    }
    return out;
  }

  /** 扫描一次并返回差异。第一次调用只建立基线，不报删除。 */
  scan() {
    this.scans += 1;
    this.lastScanAt = Date.now();
    const now = new Set(this.#list());
    const removed = [...this.prev].filter((p) => !now.has(p));
    const added = [...now].filter((p) => !this.prev.has(p));
    this.prev = now;

    if (removed.length > 0 && typeof this.onRemoved === 'function') {
      try {
        const ret = this.onRemoved(removed, { added, scans: this.scans });
        if (ret && typeof ret.catch === 'function') ret.catch((err) => this.onError?.(err));
      } catch (err) {
        this.onError?.(err);
      }
    }
    return { removed, added, tracked: now.size };
  }

  start() {
    if (this.timer) return this;
    this.prev = new Set(this.#list());
    this.lastScanAt = Date.now();
    this.timer = setInterval(() => this.scan(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stats() {
    return {
      tracked: this.prev.size,
      scans: this.scans,
      lastScanAt: this.lastScanAt,
      running: this.timer !== null,
    };
  }
}

/** 目录名是否是会话目录（`session-<anything>` 或导入的裸 `<uuid>`）。 */
export function isSessionDirName(name) {
  const value = String(name ?? '');
  if (value.startsWith('session-') && value.length > 'session-'.length) return true;
  return /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(value);
}

/** 从 `工作区/session-xxx` 或 `工作区/<uuid>` 取出**裸会话 id**（租约按裸 id 登记）。 */
export function sessionIdOf(relativePath) {
  const parts = String(relativePath).split('/');
  const last = parts[parts.length - 1] ?? '';
  return last.replace(/^session-/, '');
}
