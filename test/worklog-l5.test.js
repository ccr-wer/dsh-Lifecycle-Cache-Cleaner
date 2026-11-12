/** V4 证伪：对抗日志必被拒。四种攻击全部必须被拦。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseModelEntries,
  assignIds,
  renderWorklog,
  parseWorklog,
  validateWorklog,
  mergeNegations,
  extractEntities,
  jaccard,
} from '../worklog.js';

const PREV_MD = renderWorklog({
  sessionId: 's1',
  goal: '重构 parse 模块，目标 src/parse.js',
  entries: [
    { id: 'L1', status: 'done', text: '完成 parse 模块，文件 src/parse.js' },
    { id: 'L2', status: 'todo', text: '编写测试 test/parse.test.js' },
    { id: 'L3', status: 'decision', text: '选择 Node 内置 test runner，因为零依赖' },
    { id: 'L4', status: 'dropped', text: '放弃 jest 方案 reason: ESM 兼容问题' },
  ],
  negations: ['[N1] L4: 放弃 jest 方案 reason: ESM 兼容问题'],
});

const prev = parseWorklog(PREV_MD);
const check = (entries, extra = {}) =>
  validateWorklog({
    prev,
    next: parseWorklog(renderWorklog({ sessionId: 's1', goal: prev.goal, entries, ...extra })),
  });

const baseEntries = () => prev.entries.map((e) => ({ ...e }));

test('攻击 1：ID 重编号（内容互换）必被拒', () => {
  const e = baseEntries();
  [e[0].text, e[1].text] = [e[1].text, e[0].text];
  const v = check(e);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.startsWith('diff_not_allowed')), v.reasons.join(','));
});

test('攻击 1b：模型自带的 id 字段必须被丢弃', () => {
  const parsed = parseModelEntries('[{"id":"L99","status":"todo","text":"写 test c"}]');
  assert.equal(Object.hasOwn(parsed[0], 'id'), false, '模型不得输出 ID');
  assert.equal(parsed[0].text, '写 test c');
});

test('攻击 2：dropped -> done 状态翻转必被拒', () => {
  const e = baseEntries();
  e[3].status = 'done';
  const v = check(e);
  assert.equal(v.ok, false);
  assert.ok(
    v.reasons.some((r) => r.startsWith('illegal_transition:L4:dropped->')),
    v.reasons.join(','),
  );
});

test('攻击 3：两条合一（旧条目消失）必被拒', () => {
  const e = baseEntries().filter((x) => x.id !== 'L2');
  const v = check(e);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes('entry_vanished:L2'), v.reasons.join(','));
});

test('攻击 4：同状态改写文本必被拒', () => {
  const e = baseEntries();
  e[2].text = '选择 vitest 而不是 Node runner，因为生态完善';
  const v = check(e);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes('diff_not_allowed:L3'), v.reasons.join(','));
});

test('攻击 5：批量 drop（信息坍缩）必被拒', () => {
  const e = baseEntries();
  for (const x of e.slice(0, 3)) {
    x.status = 'dropped';
    x.text = `${x.text} reason: 并入其他条目`;
  }
  const v = check(e);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes('negation_collapse'), v.reasons.join(','));
});

test('攻击 6：状态推进但正文被整体改写必被拒', () => {
  const e = baseEntries();
  e[1].status = 'done';
  e[1].text = 'omega sigma 完全无关的内容 vvv';
  const v = check(e);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.startsWith('entry_rewritten:L2')), v.reasons.join(','));
});

test('合法推进：todo->done 且正文一致时通过', () => {
  const e = baseEntries();
  e[1].status = 'done';
  const v = check(e);
  assert.equal(v.ok, true, v.reasons.join(','));
});

test('negations 是 append-only：旧行不被删，新 drop 自动追加', () => {
  const prevNeg = [...prev.negations];
  const nextEntries = baseEntries();
  nextEntries[2].status = 'dropped';
  nextEntries[2].text = `${nextEntries[2].text} reason: 改用 vitest`;
  const merged = mergeNegations(prevNeg, prev.entries, nextEntries);
  assert.equal(merged[0], prevNeg[0], '旧否定信息必须原样保留');
  assert.ok(merged.some((n) => n.includes('L3') && n.startsWith('[N2]')), merged.join('|'));
});

test('assignIds：ref_id 命中则复用，未命中发新号，且不接受模型 id', () => {
  const out = assignIds(
    [
      { id: 'L99', status: 'done', text: 'a', ref_id: 'L2' },
      { id: 'L77', status: 'todo', text: 'b' },
    ],
    prev.entries,
  );
  assert.equal(out[0].id, 'L2');
  assert.equal(out[1].id, 'L5');
});

test('实体 Jaccard 地基正确', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(), new Set()), 1);
  assert.ok(jaccard(extractEntities('alpha beta gamma'), new Set(['z'])) < 0.6);
});

test('renderWorklog 保留原始轨迹（重建不能吃掉微固化记录）', () => {
  const doc = renderWorklog({
    sessionId: 's1',
    goal: 'g',
    entries: [{ id: 'L1', status: 'todo', text: 't' }],
    negations: [],
    rawTrace: '- t1 | user: 你好 | tools: Read(a.js)',
  });
  assert.match(doc, /## 原始轨迹\n- t1 \| user: 你好 \| tools: Read\(a\.js\)/);
  assert.equal(doc.trimEnd().split('\n').pop().startsWith('- t1'), true, '轨迹必须留在最后一节');
});
