/**
 * 工作区记忆的存储与归档。
 *
 * 纪律（与共享日志一致）：
 *  - 写入必须 confirmed:true，模型不能自己写。
 *  - **删除**没有直接接口。只有 archive()：移动到归档目录，可 restore 撤销。
 *  - 归档同样要 confirmed:true，且绝不因为"会话删光了"而自动发生。
 */
import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry, writeFileAtomic } from './atomic.js';

const nowDefault = () => Date.now();

export function safeWorkspaceKey(workspaceId) {
  const raw = String(workspaceId ?? '');
  if (!raw) throw new Error('workspaceId required');
  const cleaned = raw.replace(/[^\w.-]/g, '_').slice(0, 64);
  if (cleaned !== raw) {
    // 路径敏感字符被替换时补一段短哈希，避免两个不同工作区撞名
    let h = 0;
    for (let i = 0; i < raw.length; i += 1) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
    return `${cleaned}-${h.toString(36).slice(0, 6)}`;
  }
  if (cleaned.startsWith('.')) throw new Error('workspaceId 不得以 . 开头');
  return cleaned;
}

export class WorkspaceMemoryStore {
  constructor({ rootDir, archiveDir = null, now = nowDefault } = {}) {
    if (!rootDir) throw new Error('rootDir required');
    this.rootDir = rootDir;
    this.archiveDir = archiveDir || path.join(rootDir, 'memory', '.archive');
    this.now = now;
  }

  fileFor(workspaceId) {
    return path.join(this.rootDir, 'memory', 'workspaces', `${safeWorkspaceKey(workspaceId)}.md`);
  }

  exists(workspaceId) {
    return fs.existsSync(this.fileFor(workspaceId));
  }

  read(workspaceId) {
    try {
      return fs.readFileSync(this.fileFor(workspaceId), 'utf8');
    } catch {
      return '';
    }
  }

  sizeOf(workspaceId) {
    try {
      return fs.statSync(this.fileFor(workspaceId)).size;
    } catch {
      return 0;
    }
  }

  write(workspaceId, content, { confirmed = false } = {}) {
    if (!confirmed) return { ok: false, code: 'confirm_required' };
    const text = String(content ?? '').trim();
    if (!text) return { ok: false, code: 'empty_content' };
    const file = this.fileFor(workspaceId);
    writeFileAtomic(file, `${text}\n`);
    return { ok: true, code: 'written', path: file };
  }

  /**
   * 归档 = 移动，不是删除。没有 confirmed 一律拒绝。
   */
  archive(workspaceId, { confirmed = false } = {}) {
    if (!confirmed) return { ok: false, code: 'confirm_required' };
    const file = this.fileFor(workspaceId);
    if (!fs.existsSync(file)) return { ok: false, code: 'memory_absent' };
    fs.mkdirSync(this.archiveDir, { recursive: true });
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.archiveDir, `${safeWorkspaceKey(workspaceId)}-${stamp}.md`);
    renameWithRetry(file, target);
    return { ok: true, code: 'archived', archivePath: target };
  }

  listArchives(workspaceId) {
    try {
      const prefix = `${safeWorkspaceKey(workspaceId)}-`;
      return fs
        .readdirSync(this.archiveDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
        .sort()
        .map((f) => path.join(this.archiveDir, f));
    } catch {
      return [];
    }
  }

  restore(archivePath, workspaceId, { confirmed = false } = {}) {
    if (!confirmed) return { ok: false, code: 'confirm_required' };
    if (!fs.existsSync(archivePath)) return { ok: false, code: 'archive_absent' };
    const file = this.fileFor(workspaceId);
    if (fs.existsSync(file)) return { ok: false, code: 'target_exists' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    renameWithRetry(archivePath, file);
    return { ok: true, code: 'restored', path: file };
  }
}
