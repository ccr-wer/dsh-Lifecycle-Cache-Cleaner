import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ProfileStore,
  ProfileError,
  STYLE_IDS,
  LIMITS,
  normalizeProfile,
  renderProfilePrompt,
  isEmptyProfile,
  PROFILE_FILE,
} from '../lib/host/profile-store.js';
import { apply } from '../index.js';

// R 系列：用户自有的助手设定（称呼 / 名字 / 风格 / 指令 / 人设）。
// 关键约束：只有用户能写；文件坏了按“没设置”读；渲染时空设定不占 prompt。

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-profile-'));

test('R1 没有文件时读到空设定，且不抛', () => {
  const store = new ProfileStore({ rootDir: tmpRoot() });
  const profile = store.read();
  assert.deepEqual(profile, {
    assistantName: '',
    userName: '',
    style: 'default',
    instructions: '',
    persona: '',
    updatedAt: 0,
  });
  assert.equal(isEmptyProfile(profile), true);
  assert.equal(store.promptText(), '');
});

test('R2 写入后能读回，updatedAt 由存储盖章', () => {
  const store = new ProfileStore({ rootDir: tmpRoot() });
  const saved = store.write({ userName: '沃野熠烨', assistantName: '夜枭' });
  assert.equal(saved.userName, '沃野熠烨');
  assert.equal(saved.assistantName, '夜枭');
  assert.ok(saved.updatedAt > 0);

  const reread = store.read();
  assert.equal(reread.userName, '沃野熠烨');
  assert.equal(reread.assistantName, '夜枭');
  assert.equal(fs.existsSync(store.path), true);
  assert.match(path.basename(store.path), new RegExp(PROFILE_FILE.replace('.', '\\.')));
});

test('R3 合并式写入：只传一个字段不会抹掉其它字段', () => {
  const store = new ProfileStore({ rootDir: tmpRoot() });
  store.write({ userName: 'A', instructions: '先给结论' });
  const merged = store.write({ persona: '你是夜枭。' });
  assert.equal(merged.userName, 'A');
  assert.equal(merged.instructions, '先给结论');
  assert.equal(merged.persona, '你是夜枭。');
});

test('R4 超长字段被拒（不写盘），未知风格落回 default', () => {
  const store = new ProfileStore({ rootDir: tmpRoot() });
  assert.throws(
    () => store.write({ instructions: 'x'.repeat(LIMITS.instructions + 1) }),
    (err) => err instanceof ProfileError && err.code === 'invalid_profile',
  );
  assert.equal(fs.existsSync(store.path), false, '校验失败时不许留下半个文件');

  const normalized = store.write({ style: 'chaotic' });
  assert.equal(normalized.style, 'default');
  assert.deepEqual([...STYLE_IDS].sort(), ['concise', 'default', 'detailed']);
});

test('R5 坏文件按“还没设置”处理，且下一次写入能把文件修好', () => {
  const root = tmpRoot();
  const store = new ProfileStore({ rootDir: root });
  fs.mkdirSync(path.dirname(store.path), { recursive: true });
  fs.writeFileSync(store.path, '{ this is not json');
  assert.equal(store.read().userName, '');
  const saved = store.write({ userName: 'B' });
  assert.equal(saved.userName, 'B');
  assert.equal(store.read().userName, 'B');
});

test('R6 渲染：全空不占 prompt，部分填写只出对应的行', () => {
  assert.equal(renderProfilePrompt(normalizeProfile({})), '');
  const onlyName = renderProfilePrompt(normalizeProfile({ assistantName: '夜枭' }));
  assert.match(onlyName, /你的名字：夜枭/);
  assert.equal(/称呼用户/.test(onlyName), false);

  const full = renderProfilePrompt(
    normalizeProfile({
      userName: '沃野熠烨',
      assistantName: '夜枭',
      style: 'concise',
      instructions: '先给结论\n再给依据',
      persona: '说话直接。',
    }),
  );
  assert.match(full, /^## 用户设定的助手设定/);
  assert.match(full, /称呼用户：沃野熠烨/);
  assert.match(full, /你的名字：夜枭/);
  assert.match(full, /回复风格：简洁/);
  assert.match(full, /长期指令：/);
  assert.match(full, /先给结论/);
  assert.match(full, /人设：/);
  assert.match(full, /说话直接/);
});

test('R7 风格 default 不单独成行，避免 prompt 里出现废话', () => {
  const text = renderProfilePrompt(normalizeProfile({ userName: 'A', style: 'default' }));
  assert.equal(/回复风格/.test(text), false);
});

test('R8 apply 注册 lifecycle_profile，并塞进同一个 prompt section', () => {
  const rootDir = tmpRoot();
  new ProfileStore({ rootDir }).write({ assistantName: '夜枭', persona: '说话直接。' });

  const variables = new Map();
  const sections = [];
  const ctx = {
    tools: { register: () => () => {} },
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    inject(names, cb) {
      if (names.includes('systemPrompt')) {
        cb({
          variable(name, read) {
            variables.set(name, read);
            return () => variables.delete(name);
          },
          section(s) {
            sections.push(s);
            return () => {};
          },
        });
      }
    },
  };

  apply(ctx, { rootDir, workspaceId: 'ws-r8', engine: { kind: 'none' } });

  assert.ok(variables.has('lifecycle_profile'), '没有注册 lifecycle_profile');
  assert.ok(variables.has('lifecycle_memory'), '记忆变量被弄丢了');
  assert.equal(sections.length, 1, '仍然只注册一个 section');
  assert.match(sections[0].text, /\{\{lifecycle_profile\}\}/);
  assert.match(sections[0].text, /\{\{lifecycle_memory\}\}/);

  const rendered = variables.get('lifecycle_profile')();
  assert.match(rendered, /你的名字：夜枭/);
  assert.match(rendered, /说话直接/);
});
