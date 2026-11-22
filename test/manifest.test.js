import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// P1–P6：组合包清单必须满足宿主的 host-plugin.md 规范，
// 否则 DSH 会拒绝安装（"declares no dsh.bundle"）。
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const p = (...s) => path.join(root, ...s);
const pkg = JSON.parse(fs.readFileSync(p('package.json'), 'utf8'));
const norm = (s) => s.replace(/^\.\//, '');

const covered = (target) => {
  const t = norm(target);
  return (pkg.files ?? []).map(norm).some((f) => {
    if (f === t) return true;
    if (f.endsWith('/') && t.startsWith(f)) return true;
    if (f.includes('*')) {
      const re = new RegExp(`^${f.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      return re.test(t);
    }
    return false;
  });
};

test('P1 声明 dsh.bundle.patch 且文件存在', () => {
  const patch = pkg.dsh?.bundle?.patch;
  assert.equal(typeof patch, 'string', 'package.json 缺少 dsh.bundle.patch');
  assert.ok(patch.length > 0);
  assert.ok(fs.existsSync(p(patch)), `patch 不存在: ${patch}`);
  assert.equal(pkg.dsh.bundle.platforms, undefined, '未声明 platforms 才是全平台');
});

test('P2 patch 插入本包且行 id 唯一', () => {
  const yaml = fs.readFileSync(p(pkg.dsh.bundle.patch), 'utf8');
  assert.match(yaml, /^-\s*insert:/m);
  assert.ok(yaml.includes(pkg.name), 'patch 必须引用本包名');
  const ids = [...yaml.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(ids.length > 0, 'patch 至少一行插件条目');
  assert.equal(new Set(ids).size, ids.length, '行 id 不能重复');
});

test('P3 exports["."] 与 icon 都指向真实文件', () => {
  const dot = pkg.exports?.['.'];
  assert.equal(typeof dot, 'string');
  assert.ok(fs.existsSync(p(dot)), `exports["."] 不存在: ${dot}`);
  assert.ok(fs.existsSync(p(pkg.icon)), `icon 不存在: ${pkg.icon}`);

  const buf = fs.readFileSync(p(pkg.icon));
  assert.equal(buf.toString('utf8', 0, 4), '<svg', 'icon 必须是 SVG');
  assert.ok(buf.length <= 256 * 1024, `icon 超过 256 KiB: ${buf.length}`);
});

test('P4 locale 提供 meta.title 与 meta.description', () => {
  for (const lang of ['en', 'zh']) {
    const j = JSON.parse(fs.readFileSync(p(`locale/${lang}.json`), 'utf8'));
    assert.ok(j.meta?.title, `locale/${lang}.json 缺 meta.title`);
    assert.ok(j.meta?.description, `locale/${lang}.json 缺 meta.description`);
  }
});

test('P5 files 覆盖分发所需的全部资源', () => {
  for (const t of ['index.js', 'cordis.patch.yml', pkg.icon, 'locale/en.json', 'locale/zh.json', 'lib/core/release-gate.js']) {
    assert.ok(covered(t), `files 未覆盖 ${t}`);
  }
});

test('P6 index.js 导出 apply 且保留库接口', async () => {
  const mod = await import(new URL(`file:///${p('index.js').replace(/\\/g, '/')}`).href);
  assert.equal(typeof mod.apply, 'function', 'apply 必须是函数');
  assert.equal(typeof mod.LifecycleCacheCleaner, 'function');
  assert.ok(mod.DEFAULTS);
});
