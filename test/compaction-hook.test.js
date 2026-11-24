import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installCompactionHook, COMPACT_DEBOUNCE_MS } from '../lib/host/compaction-hook.js';

// L 系列：上下文压缩钩子。压缩成功才清，失败不清；同一窗口合并成一次。

const wait = () => new Promise((resolve) => setImmediate(resolve));

/** 记录 ctx.on 的监听器，能手动派发 session/event。 */
function makeCtx() {
  const listeners = [];
  return {
    on(name, listener, options) {
      listeners.push({ name, listener, options });
      return () => {
        const index = listeners.findIndex((entry) => entry.listener === listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    fire(session, event) {
      for (const entry of listeners.filter((item) => item.name === 'session/event')) {
        entry.listener(session, event);
      }
    },
    get count() {
      return listeners.length;
    },
  };
}

/** 立即执行的定时器：把 debounce 压成同步调用，便于断言。 */
const immediateTimer = (fn) => {
  fn();
  return 1;
};

function makeRuntime() {
  const calls = [];
  return {
    diagnostics: [],
    calls,
    clean: async (options) => {
      calls.push(options);
      return { released: true, code: 'released' };
    },
  };
}

const compactEnd = (data = {}) => ({ type: 'compaction/end', data: { compactionId: 'c1', turn: 't1', ...data } });

test('L1 压缩成功后会清一次，trigger=compact', async () => {
  const ctx = makeCtx();
  const runtime = makeRuntime();
  const dispose = installCompactionHook(ctx, runtime, { setTimer: immediateTimer });

  ctx.fire({}, compactEnd());
  await wait();

  assert.deepEqual(runtime.calls, [{ confirm: true, trigger: 'compact' }]);
  dispose();
});

test('L2 压缩失败（data.error）不清——上下文根本没变', async () => {
  const ctx = makeCtx();
  const runtime = makeRuntime();
  const dispose = installCompactionHook(ctx, runtime, { setTimer: immediateTimer });

  ctx.fire({}, compactEnd({ error: { name: 'Error', message: 'summary failed' } }));
  await wait();

  assert.deepEqual(runtime.calls, []);
  dispose();
});

test('L3 同一窗口内多次压缩收尾只清一次', async () => {
  const ctx = makeCtx();
  const runtime = makeRuntime();
  const timers = [];
  const dispose = installCompactionHook(ctx, runtime, {
    // 手动控制的定时器：先攒着，不立刻执行。
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
  });

  ctx.fire({}, compactEnd());
  ctx.fire({}, compactEnd());
  ctx.fire({}, compactEnd());
  assert.equal(timers.length, 1, '三连压缩只排一个定时器');

  timers[0]();
  await wait();
  assert.equal(runtime.calls.length, 1);

  // 窗口过了再来一次，应该重新排。
  ctx.fire({}, compactEnd());
  assert.equal(timers.length, 2);
  dispose();
});

test('L4 其它会话事件不触发（只认 compaction/end）', async () => {
  const ctx = makeCtx();
  const runtime = makeRuntime();
  const dispose = installCompactionHook(ctx, runtime, { setTimer: immediateTimer });

  ctx.fire({}, { type: 'compaction/start', data: {} });
  ctx.fire({}, { type: 'compaction/summary', data: {} });
  ctx.fire({}, { type: 'user/message', data: {} });
  ctx.fire({}, { type: 'step/end', data: {} });
  ctx.fire({}, null);
  await wait();

  assert.deepEqual(runtime.calls, []);
  dispose();
});

test('L5 卸载后不再清，也不留定时器', async () => {
  const ctx = makeCtx();
  const runtime = makeRuntime();
  const timers = [];
  const dispose = installCompactionHook(ctx, runtime, {
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {
      timers.length = 0;
    },
  });

  ctx.fire({}, compactEnd());
  assert.equal(timers.length, 1);
  dispose();
  assert.equal(timers.length, 0, '卸载要清掉未执行的定时器');
  assert.equal(ctx.count, 0, '监听器要摘掉');
});

test('L6 clean 抛错只记 diagnostics，不外抛', async () => {
  const ctx = makeCtx();
  const runtime = {
    diagnostics: [],
    clean: async () => {
      throw new Error('探测超时');
    },
  };
  const dispose = installCompactionHook(ctx, runtime, { setTimer: immediateTimer });

  ctx.fire({}, compactEnd());
  await wait();
  await wait();

  assert.match(runtime.diagnostics.join('\n'), /探测超时/);
  dispose();
});

test('L7 默认合并窗口是 1.5 秒', () => {
  assert.equal(COMPACT_DEBOUNCE_MS, 1500);
});
