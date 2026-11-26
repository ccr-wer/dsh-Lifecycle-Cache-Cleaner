import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionWatcher, isSessionDirName, sessionIdOf } from '../lib/host/session-watcher.js';

// Z14~Z17：会话目录监听要同时认两种命名。
// 本机新建的是 `session-<uuid>`；从 App 消息历史导入的是裸 `<uuid>`。
// 只认前者会让导入的会话在删除时“静默不触发清理”，在面板里也看不见。

const tmpSessions = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-watch-'));

const UUID_IMPORTED = '00bf8edc-cf82-4685-af5b-80f1fcc2cf1a';
const UUID_NATIVE = '94f60096-4603-4885-a34f-a99f2693c5a9';

function seed(root) {
  fs.mkdirSync(path.join(root, 'ws-a', UUID_IMPORTED), { recursive: true });
  fs.mkdirSync(path.join(root, 'ws-a', `session-${UUID_NATIVE}`), { recursive: true });
  fs.mkdirSync(path.join(root, 'ws-a', 'random-folder'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ws-a', 'notes.txt'), { recursive: true });
}

test('Z14 目录名判定：两种会话命名都算，普通目录不算', () => {
  assert.equal(isSessionDirName(UUID_IMPORTED), true, '导入的裸 uuid');
  assert.equal(isSessionDirName(`session-${UUID_NATIVE}`), true, '本机的 session- 前缀');
  assert.equal(isSessionDirName('random-folder'), false);
  assert.equal(isSessionDirName('notes.txt'), false);
  assert.equal(isSessionDirName('session-'), false, '只有前缀没有 id 不算');
});

test('Z15 watcher 跟踪导入的会话目录，并且只跟踪会话目录', () => {
  const root = tmpSessions();
  seed(root);
  const watcher = new SessionWatcher({ sessionsDir: root, intervalMs: 100000 });
  const scan = watcher.scan();
  // 第一次 scan 只建立基线：added 里应有两条会话，不含 random-folder / notes.txt。
  assert.equal(scan.tracked, 2);
  assert.deepEqual(
    scan.added.sort(),
    [`ws-a/${UUID_IMPORTED}`, `ws-a/session-${UUID_NATIVE}`].sort(),
  );
});

test('Z16 删除导入的会话目录会触发 onRemoved，且 id 是裸 uuid', () => {
  const root = tmpSessions();
  seed(root);
  const removed = [];
  const watcher = new SessionWatcher({
    sessionsDir: root,
    intervalMs: 100000,
    onRemoved: (paths) => removed.push(...paths.map(sessionIdOf)),
  });
  watcher.scan(); // 基线
  fs.rmSync(path.join(root, 'ws-a', UUID_IMPORTED), { recursive: true, force: true });
  watcher.scan();

  assert.deepEqual(removed, [UUID_IMPORTED], '租约按裸 id 登记，不能带 session- 前缀');
});

test('Z17 sessionIdOf 对两种路径都返回裸 id', () => {
  assert.equal(sessionIdOf(`ws-a/session-${UUID_NATIVE}`), UUID_NATIVE);
  assert.equal(sessionIdOf(`ws-a/${UUID_IMPORTED}`), UUID_IMPORTED);
  assert.equal(sessionIdOf('ws-a'), 'ws-a');
});
