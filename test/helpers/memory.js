/**
 * 内存测量：只用 vmmap / footprint，**绝不用 top**。
 * top 的 RSS 在 macOS 上既漏 compressor，也对 malloc_zone 归还迟钝 -> 假安全来源。
 */
import { spawnSync } from 'node:child_process';

function toBytes(num, unit) {
  const n = Number(num);
  const u = String(unit).toUpperCase();
  if (u.startsWith('K')) return n * 1024;
  if (u.startsWith('M')) return n * 1024 ** 2;
  if (u.startsWith('G')) return n * 1024 ** 3;
  return n;
}

export function measureFootprintBytes(pid = process.pid) {
  if (process.platform !== 'darwin') {
    throw new Error(`measureFootprintBytes 仅支持 macOS（当前 ${process.platform}）`);
  }

  const vmmap = spawnSync('vmmap', ['-summary', String(pid)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const m1 = /Physical footprint:\s+([\d.]+)([KMG])/i.exec(vmmap.stdout || '');
  if (m1) return toBytes(m1[1], m1[2]);

  const fp = spawnSync('footprint', ['-p', String(pid)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const m2 = /phys_footprint:\s+([\d.]+)\s*([KMG]?B)/i.exec(fp.stdout || '');
  if (m2) return toBytes(m2[1], m2[2]);

  throw new Error('vmmap 与 footprint 均未给出可解析的 physical footprint');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待内存降到阈值以下，返回是否达成。 */
export async function waitForDrop(before, minDrop, { timeoutMs = 4000, stepMs = 200, pid } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = before;
  while (Date.now() < deadline) {
    global.gc?.();
    await sleep(stepMs);
    last = measureFootprintBytes(pid);
    if (before - last >= minDrop) return { ok: true, after: last };
  }
  return { ok: false, after: last };
}
