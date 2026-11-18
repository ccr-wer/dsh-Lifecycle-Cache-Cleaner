/**
 * 原子落盘 + rename 重试。
 *
 * 为什么需要重试：Windows 上杀软扫描、索引服务、编辑器句柄会让 rename 瞬时
 * 抛 EPERM / EBUSY / EACCES；Linux/macOS 基本不会。这类失败是瞬时的，
 * 退避重试即可，不该直接判成"清理失败"。
 *
 * 只对这三个错误码重试；其它错误（ENOENT、EXDEV……）照常抛出，
 * 不允许把真实错误吞掉变成"看起来成功"。
 */
import fs from 'node:fs';
import path from 'node:path';

export const RETRYABLE_RENAME = Object.freeze(new Set(['EPERM', 'EBUSY', 'EACCES']));

/** 同步退避：没有异步上下文可用时（writeFileSync 链路）只能这样等。 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // 极端情况下退化为忙等，只在重试路径上发生
    }
  }
}

/**
 * @param {string} from
 * @param {string} to
 * @param {{fs?:object, retries?:number, delayMs?:number, sleep?:Function}} [opts]
 * @returns {{ok:true, attempts:number}}
 */
export function renameWithRetry(
  from,
  to,
  { fs: fsImpl = fs, retries = 5, delayMs = 20, sleep = sleepSync } = {},
) {
  let lastErr = null;
  for (let i = 0; i <= retries; i += 1) {
    try {
      fsImpl.renameSync(from, to);
      return { ok: true, attempts: i + 1 };
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_RENAME.has(err?.code)) throw err;
      if (i === retries) break;
      sleep(delayMs * (i + 1)); // 线性退避，最坏 20+40+60+80+100 = 300ms
    }
  }
  lastErr.attempts = retries + 1;
  throw lastErr;
}

/**
 * tmp -> fsync -> rename 的完整原子写。
 *
 * @param {string} file
 * @param {string|Buffer} data
 */
export function writeFileAtomic(
  file,
  data,
  { fs: fsImpl = fs, retries = 5, delayMs = 20, sleep = sleepSync, fsync = true } = {},
) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const fd = fsImpl.openSync(tmp, 'w');
  try {
    fsImpl.writeSync(fd, data);
    if (fsync && typeof fsImpl.fsyncSync === 'function') fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
  renameWithRetry(tmp, file, { fs: fsImpl, retries, delayMs, sleep });
  return file;
}
