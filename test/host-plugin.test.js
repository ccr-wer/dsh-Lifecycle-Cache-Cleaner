import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../index.js';
import { HostRuntime } from '../lib/host/runtime.js';
import { SessionWatcher } from '../lib/host/session-watcher.js';
import { TypedMemoryStore } from '../lib/core/memory-store.js';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-host-'));

function makeCtx({ withPrompt = true } = {}) {
  const tools = new Map();
  const variables = new Map();
  const sections = [];
  const ctx = {
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
    },
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
  };
  if (withPrompt) {
    ctx.systemPrompt = {
      variable(name, read) {
        variables.set(name, read);
        return () => variables.delete(name);
      },
      section(s) {
        sections.push(s);
        return () => {
          const i = sections.indexOf(s);
          if (i >= 0) sections.splice(i, 1);
        };
      },
    };
    // 真实宿主里 systemPrompt 只能通过 ctx.inject 拿到；直接读属性会抛。
    ctx.inject = (names, cb) => {
      if (names.includes('systemPrompt') && ctx.systemPrompt) cb(ctx.systemPrompt);
    };
  }
  return { ctx, tools, variables, sections };
}

const fakeAdapter = (snapshot) => ({
  probeEngine: async () => snapshot,
  destroyEngine: async () => {},
});

test('H0 workspaceRegistry 要单独注入：只在 web 回调里 ctx.get 会拿到 undefined', () => {
  const injected = [];
  const registry = { list: () => [{ id: 'w1', path: 'D:\\Vision-Pilot', title: 'Vision-Pilot' }] };
  const ctx = {
    tools: { register: () => () => {} },
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    get(name) {
      // 关键：这里的 get 永远拿不到 workspaceRegistry（模拟“服务晚于 web 就绪”）。
      if (name === 'systemPrompt') return { variable: () => () => {}, section: () => () => {} };
      return undefined;
    },
    inject(names, cb) {
      injected.push(names.join(','));
      if (names.includes('systemPrompt')) cb({ variable: () => () => {}, section: () => () => {} });
      if (names.includes('workspaceRegistry')) cb({ workspaceRegistry: registry });
      if (names.includes('webServer')) {
        cb({ webServer: { register: () => () => {} }, connection: {} });
      }
    },
  };

  apply(ctx, { rootDir: tmpRoot(), engine: { kind: 'none' } });

  assert.ok(
    injected.some((name) => name.includes('workspaceRegistry')),
    '必须显式 inject workspaceRegistry，否则新建工作区永远不出现在记忆面板里',
  );
});

test('H1 apply 注册两个工具并保持定义可注册', () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, { rootDir: tmpRoot(), engine: { kind: 'none' } });

  assert.deepEqual([...tools.keys()].sort(), ['lifecycle_cache_clean', 'lifecycle_cache_status', 'lifecycle_memory_propose']);
  for (const def of tools.values()) {
    assert.equal(typeof def.execute, 'function');
    assert.equal(typeof def.output.render, 'function');
    assert.ok(def.output.schema);
    assert.equal(def.parameters.type, 'object');
  }
});

test('H2 status 工具输出引擎状态与闸门结论', async () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, { rootDir: tmpRoot(), engine: { kind: 'none' } });

  const text = await tools.get('lifecycle_cache_status').execute({}, {});
  assert.match(text, /本地引擎：unknown/);
  assert.match(text, /清理闸门：拒绝/);
  assert.match(text, /记忆：共享 0 条/);
});

test('H3 探测 absent 时 clean 拒绝释放', async () => {
  const runtime = new HostRuntime({
    rootDir: tmpRoot(),
    adapter: fakeAdapter({ installed: false, models: [], slots: [] }),
  });
  const r = await runtime.clean({ confirm: true });
  assert.equal(r.released, false);
  assert.equal(r.code, 'skip_absent');
});

test('H4 闸门放行但未 confirm 时不动作', async () => {
  let destroyed = 0;
  const runtime = new HostRuntime({
    rootDir: tmpRoot(),
    adapter: {
      probeEngine: async () => ({ installed: true, models: [{ name: 'm' }], slots: [] }),
      destroyEngine: async () => {
        destroyed++;
      },
    },
    ownership: 'adapter-exclusive',
  });

  const r = await runtime.clean({ confirm: false });
  assert.equal(r.released, false);
  assert.equal(r.code, 'confirm_required');
  assert.equal(destroyed, 0);
});

test('H5 放行 + confirm 才真正释放', async () => {
  let destroyed = 0;
  const runtime = new HostRuntime({
    rootDir: tmpRoot(),
    adapter: {
      probeEngine: async () => ({ installed: true, models: [{ name: 'm' }], slots: [] }),
      destroyEngine: async () => {
        destroyed++;
      },
    },
    ownership: 'adapter-exclusive',
  });

  const r = await runtime.clean({ confirm: true });
  assert.equal(r.released, true);
  assert.equal(r.code, 'released');
  assert.equal(destroyed, 1);
});

test('H6 租约模式下无租约不放行（fail-closed）', async () => {
  const runtime = new HostRuntime({
    rootDir: tmpRoot(),
    adapter: fakeAdapter({ installed: true, models: [{ name: 'm' }], slots: [] }),
    ownership: 'lease',
  });
  const r = await runtime.clean({ confirm: true });
  assert.equal(r.released, false);
  assert.equal(r.code, 'skip_no_lease');
});

test('H7 记忆注入：注册 variable 与 section，且读到已写入的共享记忆', () => {
  const rootDir = tmpRoot();
  const store = new TypedMemoryStore({ rootDir });
  const wrote = store.propose({ text: '发布前必须跑完整测试套件', scope: 'shared', confirmed: true });
  assert.equal(wrote.ok, true);

  const { ctx, variables, sections } = makeCtx();
  apply(ctx, { rootDir, workspaceId: 'ws-h7', engine: { kind: 'none' } });

  assert.ok(variables.has('lifecycle_memory'), '未注册 lifecycle_memory 变量');
  assert.equal(sections.length, 1);
  assert.match(sections[0].text, /\{\{lifecycle_memory\}\}/);
  assert.match(variables.get('lifecycle_memory')(), /发布前必须跑完整测试套件/);
});

test('H9 提供 ctx.inject 时走可选服务路径，避免重复注册 section', () => {
  const rootDir = tmpRoot();
  const { ctx, tools, variables, sections } = makeCtx();
  const injectCalls = [];
  ctx.inject = (names, cb) => {
    injectCalls.push(names.join(','));
    if (names.includes('systemPrompt') && ctx.systemPrompt) cb(ctx.systemPrompt);
  };

  apply(ctx, { rootDir, workspaceId: 'ws-h9', engine: { kind: 'none' } });

  assert.deepEqual(injectCalls, ['systemPrompt']);
  assert.equal(tools.size, 3);
  assert.equal(sections.length, 1, 'section 只能注册一次');
  assert.ok(variables.has('lifecycle_memory'));
});

test('H10 未注入时读取 ctx.systemPrompt 不得被触发（重现 cannot get property without inject）', () => {
  const seen = [];
  const ctx = {
    tools: { register: (d) => { seen.push(d.name); return () => {}; } },
    effect: (fn) => {
      const dispose = fn();
      return () => dispose?.();
    },
  };
  Object.defineProperty(ctx, 'systemPrompt', {
    get() {
      throw new Error('cannot get property "variable" without inject');
    },
  });

  assert.doesNotThrow(() => apply(ctx, { rootDir: tmpRoot(), engine: { kind: 'none' } }));
  assert.deepEqual(seen.sort(), ['lifecycle_cache_clean', 'lifecycle_cache_status', 'lifecycle_memory_propose']);
});

test('H11 ctx.inject 存在但服务缺席时，不注册 section 也不抛', () => {
  const { ctx, tools, sections } = makeCtx();
  ctx.inject = () => {}; // 服务永远不出现

  assert.doesNotThrow(() => apply(ctx, { rootDir: tmpRoot(), engine: { kind: 'none' } }));
  assert.equal(tools.size, 3);
  assert.equal(sections.length, 0);
});

test('H12 会话目录消失能被监听到', () => {
  const root = tmpRoot();
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(path.join(sessionsDir, 'ws1', 'session-a'), { recursive: true });
  fs.mkdirSync(path.join(sessionsDir, 'ws1', 'session-b'), { recursive: true });

  const removedSeen = [];
  const watcher = new SessionWatcher({
    sessionsDir,
    onRemoved: (removed) => removedSeen.push(...removed),
  });

  const first = watcher.scan();
  assert.deepEqual(first.removed, [], '首次扫描只建基线');
  assert.equal(first.tracked, 2);

  fs.rmSync(path.join(sessionsDir, 'ws1', 'session-a'), { recursive: true, force: true });
  const second = watcher.scan();
  assert.deepEqual(second.removed, ['ws1/session-a']);
  assert.deepEqual(removedSeen, ['ws1/session-a']);
});

test('H13 删除会话后：释放租约并按闸门释放引擎', async () => {
  let destroyed = 0;
  const released = [];
  const runtime = new HostRuntime({
    rootDir: tmpRoot(),
    adapter: {
      probeEngine: async () => ({ installed: true, models: [{ name: 'm' }], slots: [] }),
      destroyEngine: async () => {
        destroyed++;
      },
    },
    leases: { release: (id, reason) => released.push([id, reason]) },
  });

  const entry = await runtime.handleSessionsRemoved(['ws/session-xyz']);
  assert.deepEqual(released, [['session-xyz', 'session_deleted']]);
  assert.equal(entry.released, true);
  assert.equal(entry.code, 'released');
  assert.equal(destroyed, 1);
});

test('H14 无本地引擎时删除会话：不释放，但不报错', async () => {
  const runtime = new HostRuntime({
    rootDir: tmpRoot(),
    adapter: { probeEngine: async () => ({ installed: false, models: [], slots: [] }) },
  });
  const entry = await runtime.handleSessionsRemoved(['ws/session-q']);
  assert.equal(entry.released, false);
  assert.equal(entry.code, 'skip_absent');
  assert.equal(runtime.recentDeletions.length, 1);
});

test('H15 releaseOnDelete=false 时只记录不释放', async () => {
  let destroyed = 0;
  const runtime = new HostRuntime({
    rootDir: tmpRoot(),
    adapter: {
      probeEngine: async () => ({ installed: true, models: [{ name: 'm' }], slots: [] }),
      destroyEngine: async () => {
        destroyed++;
      },
    },
    config: { releaseOnDelete: false },
  });
  const entry = await runtime.handleSessionsRemoved(['ws/session-r']);
  assert.equal(entry.code, 'release_disabled');
  assert.equal(destroyed, 0);
});

test('H16 status 显示会话监听状态', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'sessions', 'ws1', 'session-a'), { recursive: true });
  const { ctx, tools } = makeCtx();
  apply(ctx, { rootDir: root, config: {}, engine: { kind: 'none' }, watchIntervalMs: 60000 });

  const text = await tools.get('lifecycle_cache_status').execute({}, {});
  assert.match(text, /会话监听：跟踪 1 个/);
});

test('H8 没有 systemPrompt 服务时不抛错，且记录诊断', () => {
  const { ctx, tools } = makeCtx({ withPrompt: false });
  assert.doesNotThrow(() => apply(ctx, { rootDir: tmpRoot(), engine: { kind: 'none' } }));
  assert.equal(tools.size, 3);
});
