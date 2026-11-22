import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { listSessions, resolveSession, trashSession, isValidSessionId, readSessionTitle } from '../lib/host/session-store.js';

// Z 系列：会话清单与“移到回收站”。
// 判定都在文件系统层面，所以用真目录真文件，不用 mock。

const UUID_A = '94f60096-4603-4885-a34f-a99f2693c5a9';
const UUID_B = '9924cb1b-b1ec-41a5-b93c-cc447e92652d';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sessions-'));
  const sessionsDir = path.join(root, 'sessions');
  const trashDir = path.join(root, 'lifecycle-cache', 'trash');
  fs.mkdirSync(path.join(sessionsDir, 'ws-a', `session-${UUID_A}`), { recursive: true });
  fs.mkdirSync(path.join(sessionsDir, 'ws-b', `session-${UUID_B}`), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'ws-a', `session-${UUID_A}`, 'session.v4.jsonl.zstd'), Buffer.alloc(2048));
  fs.writeFileSync(path.join(sessionsDir, 'ws-b', `session-${UUID_B}`, 'session.v4.jsonl.zstd'), Buffer.alloc(64));
  // 旧时间：让“最近有写入”的守卫不会误伤
  const past = new Date(Date.now() - 60 * 60 * 1000);
  for (const dir of [path.join(sessionsDir, 'ws-a', `session-${UUID_A}`), path.join(sessionsDir, 'ws-b', `session-${UUID_B}`)]) {
    fs.utimesSync(path.join(dir, 'session.v4.jsonl.zstd'), past, past);
  }
  return { root, sessionsDir, trashDir };
}

test('Z1 列出会话：按最后活动倒序，带工作区与字节数', () => {
  const { sessionsDir } = makeRoot();
  const sessions = listSessions(sessionsDir);
  assert.equal(sessions.length, 2);
  const a = sessions.find((s) => s.id === UUID_A);
  assert.equal(a.workspaceKey, 'ws-a');
  assert.equal(a.key, `ws-a/session-${UUID_A}`);
  assert.equal(a.bytes, 2048);
  const newer = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(path.join(sessionsDir, 'ws-b', `session-${UUID_B}`, 'session.v4.jsonl.zstd'), newer, newer);
  assert.equal(listSessions(sessionsDir)[0].id, UUID_B, '最新活动的排最前');
});

test('Z2 目录名不合法的会话不进入清单', () => {
  const { sessionsDir } = makeRoot();
  fs.mkdirSync(path.join(sessionsDir, 'ws-a', 'session-not-a-uuid'), { recursive: true });
  fs.mkdirSync(path.join(sessionsDir, 'ws-a', 'random-folder'), { recursive: true });
  const ids = listSessions(sessionsDir).map((s) => s.id);
  assert.deepEqual(ids.sort(), [UUID_A, UUID_B].sort());
});

test('Z3 删除 = 移动到回收站，原目录消失、回收站里能找回来', async () => {
  const { sessionsDir, trashDir } = makeRoot();
  const result = await trashSession({ sessionsDir, trashDir, id: UUID_A });

  assert.equal(result.moved, true);
  assert.equal(result.code, 'trashed');
  assert.equal(result.session.key, `ws-a/session-${UUID_A}`);
  assert.equal(fs.existsSync(path.join(sessionsDir, 'ws-a', `session-${UUID_A}`)), false, '原目录必须消失');
  assert.equal(fs.existsSync(result.trashPath), true, '回收站里必须有它');
  assert.equal(fs.readFileSync(path.join(result.trashPath, 'session.v4.jsonl.zstd')).length, 2048, '内容原样保留');
});

test('Z4 当前会话拒绝删除', async () => {
  const { sessionsDir, trashDir } = makeRoot();
  const result = await trashSession({ sessionsDir, trashDir, id: UUID_A, currentSessionId: UUID_A });
  assert.equal(result.moved, false);
  assert.equal(result.code, 'is_current');
  assert.equal(fs.existsSync(path.join(sessionsDir, 'ws-a', `session-${UUID_A}`)), true);
});

test('Z5 最近有写入的会话被当成“仍在用”，拒绝删除', async () => {
  const { sessionsDir, trashDir } = makeRoot();
  // 两个目录都是 1 小时前写的：窗口外，可以删
  const stale = await trashSession({ sessionsDir, trashDir, id: UUID_A, minIdleMs: 60 * 60 * 1000 });
  assert.equal(stale.moved, true);

  // UUID_B 刚刚被写过：窗口内，拒绝
  fs.writeFileSync(path.join(sessionsDir, 'ws-b', `session-${UUID_B}`, 'session.v4.jsonl.zstd'), Buffer.alloc(128));
  const fresh = await trashSession({ sessionsDir, trashDir, id: UUID_B, minIdleMs: 60 * 60 * 1000 });
  assert.equal(fresh.moved, false);
  assert.equal(fresh.code, 'busy');
  assert.equal(fs.existsSync(path.join(sessionsDir, 'ws-b', `session-${UUID_B}`)), true);
});

test('Z6 形状像但不存在 / 路径穿越都被挡', async () => {
  const { sessionsDir, trashDir } = makeRoot();
  assert.equal((await trashSession({ sessionsDir, trashDir, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })).code, 'not_found');
  for (const bad of ['../ws-a', '..', 'a/b', '', null, 123]) {
    const result = await trashSession({ sessionsDir, trashDir, id: bad });
    assert.equal(result.moved, false);
    assert.equal(result.code, 'invalid_id', `id=${String(bad)} 必须被判非法`);
  }
  assert.equal(isValidSessionId(UUID_A), true);
  assert.equal(isValidSessionId('..'), false);
});

test('Z7 resolveSession 只认 sessions 根下的 session-<uuid> 目录', () => {
  const { sessionsDir } = makeRoot();
  assert.equal(resolveSession(sessionsDir, UUID_A).workspaceKey, 'ws-a');
  assert.equal(resolveSession(sessionsDir, 'aaaaaaaa-1111-2222-3333-444444444444'), null);
  const UUID_C = 'aaaaaaaa-1111-2222-3333-444444444444';
  fs.writeFileSync(path.join(sessionsDir, 'ws-a', `session-${UUID_C}`), 'not a directory');
  assert.equal(resolveSession(sessionsDir, UUID_C), null, '同名文件不算会话目录');
});

test('Z8 sessions 根不存在时清单为空而不是抛错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sessions-empty-'));
  assert.deepEqual(listSessions(path.join(root, 'missing')), []);
  assert.equal(resolveSession(path.join(root, 'missing'), UUID_A), null);
});

// ---- 标题：阅读会话日志里的 session/title 事件 ----

function writeTitleLog(dir, entries, { zstd = false } = {}) {
  // makeRoot 的夹具里已经有 session.v4.jsonl.zstd（全零，没有标题事件），先清掉，
  // 否则 findSessionLog 会优先挑到它。
  for (const name of fs.readdirSync(dir)) {
    if (/^session\..*\.jsonl(\.zstd)?$/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  const file = path.join(dir, zstd ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl');
  fs.writeFileSync(file, zstd ? zlib.zstdCompressSync(Buffer.from(body, 'utf8')) : body);
  return file;
}

test('Z9 从 JSONL 日志里读出标题（取 seq 最大的一个）', () => {
  const { sessionsDir } = makeRoot();
  const dir = path.join(sessionsDir, 'ws-a', `session-${UUID_A}`);
  writeTitleLog(dir, [
    { type: 'session', seq: 1 },
    { type: 'session/title', seq: 15, data: { title: '旧标题', source: { kind: 'fallback' } } },
    { type: 'session/title', seq: 17, data: { title: '新标题', source: { kind: 'provider' } } },
  ]);

  const listed = listSessions(sessionsDir).find((s) => s.id === UUID_A);
  assert.equal(listed.title, '新标题');
  assert.equal(readSessionTitle(dir), '新标题');
  assert.equal(resolveSession(sessionsDir, UUID_A).title, '新标题');
});

test('Z10 从 zstd 拼接日志里也能读标题（按帧解）', () => {
  const { sessionsDir } = makeRoot();
  const dir = path.join(sessionsDir, 'ws-b', `session-${UUID_B}`);
  writeTitleLog(dir, [{ type: 'session', seq: 1 }, { type: 'session/title', seq: 9, data: { title: '压缩标题' } }], { zstd: true });

  assert.equal(readSessionTitle(dir), '压缩标题');
  assert.equal(listSessions(sessionsDir).find((s) => s.id === UUID_B).title, '压缩标题');
});

test('Z11 没有标题事件 / 坏日志时返回空串，不抛', () => {
  const { sessionsDir } = makeRoot();
  const dir = path.join(sessionsDir, 'ws-a', `session-${UUID_A}`);
  writeTitleLog(dir, [{ type: 'session', seq: 1 }, { type: 'session/title', seq: 2, data: { title: '' } }]);
  assert.equal(readSessionTitle(dir), '');

  const broken = path.join(sessionsDir, 'ws-b', `session-${UUID_B}`);
  fs.writeFileSync(path.join(broken, 'session.v4.jsonl'), 'not json at all\n');
  assert.equal(readSessionTitle(broken), '');
  assert.equal(readSessionTitle(path.join(sessionsDir, 'ws-a', 'nope')), '');
});
