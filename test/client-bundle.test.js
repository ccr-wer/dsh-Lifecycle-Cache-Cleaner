import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROUTE_BASE } from '../lib/host/web-api.js';

// C 系列：Client 半边的清单与注册。没有浏览器，所以用一个最小的
// `window.__ModuleLoader__` + React shim 跑通「注册 → apply → 渲染一次」，
// 只验证接线与文本，不冒充界面验收（那要在真实页面里看）。

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const p = (...s) => path.join(root, ...s);
const pkg = JSON.parse(fs.readFileSync(p('package.json'), 'utf8'));
const clientSource = fs.readFileSync(p('client.js'), 'utf8');

const reactShim = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
};

/** 把 client.js 当一个普通脚本跑：它只依赖全局 window.__ModuleLoader__。 */
function loadBundle() {
  const registered = [];
  const window = {
    __ModuleLoader__: {
      load(registration) {
        registered.push(registration);
      },
    },
  };
  // new Function 而不是 import：client.js 是给浏览器加载的脚本，不是 ESM 模块。
  const run = new Function('window', clientSource);
  run(window);
  assert.equal(registered.length, 1, 'client.js 必须注册恰好一个 bundle');
  const registration = registered[0];
  const mod = registration.factory((name) => {
    if (name === 'react') return reactShim;
    throw new Error(`unexpected require: ${name}`);
  });
  return { registration, mod };
}

function makeClientCtx() {
  const slots = [];
  const dictionaries = new Map();
  const injected = [];
  const refreshers = {};
  const ctx = {
    locale: {
      register(ns, dictionary) {
        dictionaries.set(ns, dictionary);
        return () => dictionaries.delete(ns);
      },
    },
    slots: {
      inject(owner, callback) {
        return callback();
      },
      register(options, component) {
        slots.push({ options, component });
        return () => {
          const i = slots.findIndex((entry) => entry.options === options);
          if (i >= 0) slots.splice(i, 1);
        };
      },
    },
    // 真实客户端 ctx 有 inject；用来确认我们只通过它拿 sessions / workspaces。
    inject(names, callback) {
      injected.push(names.join(','));
      const scoped = {};
      for (const name of names) {
        scoped[name] = {
          refresh: () => {
            refreshers[name] = (refreshers[name] ?? 0) + 1;
          },
        };
      }
      callback(scoped);
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
  };
  return { ctx, slots, dictionaries, injected, refreshers };
}

/** 在 createElement 树上找满足条件的节点。 */
function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, out);
  return out;
}

test('C1 清单声明 web Client 半边，且不上传多余文件', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.dsh.client.immediately, true);
  assert.ok(Array.isArray(pkg.dsh.client.inject), 'inject 用于排序激活');
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'));
  assert.equal(pkg.exports?.['./client'], './client.js');
  assert.ok(fs.existsSync(p('./client.js')));
  assert.ok(pkg.files.includes('client.js'), 'files 必须带上 client.js');
});

test('C2 bundle 的注册 id 等于包名（模块表按包名建行）', () => {
  const { registration } = loadBundle();
  assert.equal(registration.id, pkg.name);
});

test('C3 工厂返回的 apply/inject 不 import 任何 @deepseek-ai/* 运行时包', () => {
  const { mod } = loadBundle();
  assert.deepEqual(mod.inject, ['slots', 'locale']);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(/require\(\s*['"]@deepseek-ai/.test(clientSource), false, '不允许 require 宿主 Client 包');
  assert.equal(/from\s+['"]@deepseek-ai/.test(clientSource), false, '不允许 import 宿主 Client 包');
});

test('C4 apply 注册插件页配置区、会话面板与个性化面板，并注册中英文字典', () => {
  const { mod } = loadBundle();
  const { ctx, slots, dictionaries } = makeClientCtx();
  mod.apply(ctx);

  const ids = slots.map((slot) => slot.options.id).sort();
  assert.deepEqual(ids, [
    'lifecycle-cache-config',
    'lifecycle-cache-memory',
    'lifecycle-cache-profile',
    'lifecycle-cache-sessions',
  ]);

  const card = slots.find((slot) => slot.options.id === 'lifecycle-cache-config');
  assert.equal(card.options.name, 'plugins.bundle.config');
  assert.equal(card.options.key, pkg.name);
  assert.equal(card.options.locale, 'lifecycle-cache-cleaner');
  assert.equal(typeof card.component, 'function');

  for (const id of ['lifecycle-cache-sessions', 'lifecycle-cache-profile', 'lifecycle-cache-memory']) {
    const panel = slots.find((slot) => slot.options.id === id);
    assert.equal(panel.options.name, 'sidebar.footer.action');
    assert.equal(panel.options.locale, 'lifecycle-cache-cleaner');
    assert.equal(typeof panel.component, 'function');
  }

  const dict = dictionaries.get('lifecycle-cache-cleaner');
  assert.ok(dict, '字典没注册');
  assert.equal(dict.zh['card.title'], '生命周期缓存');
  assert.equal(dict.en['card.title'], 'Lifecycle cache');
  assert.equal(dict.zh['card.release'], '释放引擎');
  assert.equal(dict.en['card.release'], 'Release engine');
  assert.equal(dict.zh['panel.delete'], '删除');
  assert.equal(dict.en['panel.delete'], 'Delete');
  assert.ok(dict.zh['panel.confirm'], '缺中文确认文案');
  assert.equal(dict.zh['profile.button'], '个性化');
  assert.equal(dict.en['profile.button'], 'Personalize');
  assert.equal(dict.zh['profile.style.concise'], '简洁');
  assert.ok(dict.zh['profile.save'], '缺保存文案');
  assert.equal(dict.zh['memory.button'], '记忆');
  assert.equal(dict.en['memory.button'], 'Memory');
  assert.equal(dict.zh['memory.tab.shared'], '共享记忆');
  assert.ok(dict.zh['memory.add'], '缺添加文案');
  assert.ok(dict.zh['memory.docSave'], '缺文档保存文案');
  for (const key of ['skip_absent', 'skip_unknown', 'skip_no_lease', 'skip_foreign', 'no_destroy']) {
    assert.ok(dict.zh[`gate.${key}`], `缺中文文案 gate.${key}`);
    assert.ok(dict.en[`gate.${key}`], `缺英文文案 gate.${key}`);
  }
});

test('C5 状态卡渲染出状态行与两个按钮；未拿到状态时释放按钮禁用', () => {
  const { mod } = loadBundle();
  const { ctx, slots } = makeClientCtx();
  mod.apply(ctx);
  const Card = slots.find((slot) => slot.options.name === 'plugins.bundle.config').component;

  const tree = Card({ view: 'page', t: (key) => key });
  const buttons = findAll(tree, (node) => node.type === 'button');
  assert.equal(buttons.length, 2, '应有刷新与释放两个按钮');
  const release = buttons.find((node) => node.props['data-lc-action'] === 'release');
  assert.ok(release, '缺释放按钮');
  assert.equal(release.props.disabled, true, '没有状态（或闸门未放行）时不许点');
  // 注入的 t 返回 key 本身时，组件会退到本地字典（Node 里没有 document，落英文）。
  assert.equal(release.children[0], 'Release engine');

  const meta = findAll(tree, (node) => node.props['data-lc-meta'] === '1');
  assert.equal(meta.length, 1);
  assert.match(meta[0].children[0], /Loading/);
});

test('C6 状态卡 summary 视图只回一行文本，不渲染按钮', () => {
  const { mod } = loadBundle();
  const { ctx, slots } = makeClientCtx();
  mod.apply(ctx);
  const Card = slots.find((slot) => slot.options.name === 'plugins.bundle.config').component;

  const tree = Card({ view: 'summary', t: (key) => key });
  assert.equal(tree.type, 'span');
  assert.equal(findAll(tree, (node) => node.type === 'button').length, 0);
});

test('C7 浏览器端 API 前缀与 Host 路由一致', () => {
  const match = clientSource.match(/const API = '([^']+)'/);
  assert.ok(match, 'client.js 里找不到 API 常量');
  assert.equal(match[1], ROUTE_BASE);
});

test('C8 会话面板收起时只渲染入口按钮，不渲染对话框', () => {
  const { mod } = loadBundle();
  const { ctx, slots } = makeClientCtx();
  mod.apply(ctx);
  const Panel = slots.find((slot) => slot.options.id === 'lifecycle-cache-sessions').component;

  const tree = Panel({ wide: true, t: (key) => key });
  const buttons = findAll(tree, (node) => node.type === 'button');
  assert.equal(buttons.length, 1, '收起状态只有一个入口按钮');
  assert.equal(buttons[0].props['data-lc-action'], 'open-sessions');
  assert.equal(buttons[0].children[0].children[0], 'Sessions');
  assert.equal(findAll(tree, (node) => node.props['data-lc-sessions'] === '1').length, 0, '收起时不该有对话框');
});

test('C9 个性化面板收起时只有一个入口按钮，不渲染表单', () => {
  const { mod } = loadBundle();
  const { ctx, slots } = makeClientCtx();
  mod.apply(ctx);
  const Panel = slots.find((slot) => slot.options.id === 'lifecycle-cache-profile').component;

  const tree = Panel({ wide: true, t: (key) => key });
  const buttons = findAll(tree, (node) => node.type === 'button');
  assert.equal(buttons.length, 1, '收起状态只有一个入口按钮');
  assert.equal(buttons[0].props['data-lc-action'], 'open-profile');
  assert.equal(buttons[0].children[0].children[0], 'Personalize');
  assert.equal(findAll(tree, (node) => node.props['data-lc-profile'] === '1').length, 0, '收起时不该有表单');
  assert.equal(findAll(tree, (node) => node.props['data-lc-field']).length, 0, '收起时不该有字段');
});

test('C10 记忆面板收起时只有一个入口按钮，不渲染列表或编辑器', () => {
  const { mod } = loadBundle();
  const { ctx, slots } = makeClientCtx();
  mod.apply(ctx);
  const Panel = slots.find((slot) => slot.options.id === 'lifecycle-cache-memory').component;

  const tree = Panel({ wide: true, t: (key) => key });
  const buttons = findAll(tree, (node) => node.type === 'button');
  assert.equal(buttons.length, 1, '收起状态只有一个入口按钮');
  assert.equal(buttons[0].props['data-lc-action'], 'open-memory');
  assert.equal(buttons[0].children[0].children[0], 'Memory');
  assert.equal(findAll(tree, (node) => node.props['data-lc-memory'] === '1').length, 0, '收起时不该有对话框');
  assert.equal(findAll(tree, (node) => node.props['data-lc-field']).length, 0, '收起时不该有编辑区');
});

test('C11 只通过 ctx.inject 拿 sessions / workspaces，不裸读 ctx 属性', () => {
  const { mod } = loadBundle();
  const { ctx, injected } = makeClientCtx();
  mod.apply(ctx);

  assert.ok(injected.includes('sessions'), '没有注入 sessions：删除后列表不会刷新');
  assert.ok(injected.includes('workspaces'), '没有注入 workspaces：分组归属不会刷新');
  // 裸读 `ctx.sessions` 在真实宿主会抛 cannot get property ... without inject。
  // 只看代码行，注释里提到这个名字不算（否则会把说明文字误判成用法）。
  const code = clientSource
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
  assert.equal(/ctx\.sessions/.test(code), false, 'client.js 不允许裸读 ctx.sessions');
  assert.equal(/ctx\.workspaces/.test(code), false, 'client.js 不允许裸读 ctx.workspaces');
});
