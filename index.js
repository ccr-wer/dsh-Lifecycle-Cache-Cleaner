/**
 * DSH 插件入口（Host 侧）。
 *
 * 宿主规范（`dsh-doc/references/host-plugin.md`）：
 * bundle 的 `package.json` 声明 `dsh.bundle.patch`，patch 里 insert 本包名，
 * 宿主据此加载本模块，期望导出 `apply(ctx, config)`。
 *
 * 实际能力（三个，全部可验证）：
 *   1. `lifecycle_cache_status` 工具 —— 引擎探测 + 闸门结论 + 记忆用量，只读
 *   2. `lifecycle_cache_clean` 工具 —— 经统一闸门释放引擎（需 confirm）
 *   3. system prompt 记忆注入 —— 共享/工作区记忆进模型上下文
 *
 * 不 import 任何 `@deepseek-ai/*` 包：profile 里解析不到宿主包，
 * 一切通过注入的 ctx 与 config 访问。
 */
import os from 'node:os';
import path from 'node:path';
import { HostRuntime } from './lib/host/runtime.js';
import { createStatusTool, createCleanTool } from './lib/host/tools.js';
import { createEngineAdapter } from './adapters/engine-http.js';

/** 只要 tools 服务；systemPrompt 是可选的，用 ctx.inject 单独接。 */
export const inject = ['tools'];

function resolveRootDir(config) {
  return config.rootDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function apply(ctx, config = {}) {
  const runtime = new HostRuntime({
    rootDir: resolveRootDir(config),
    workspaceId: config.workspaceId ?? process.cwd(),
    adapter: createEngineAdapter(config),
    ownership: config.ownership ?? 'adapter-exclusive',
    config,
  });

  const registerTools = () => {
    const disposers = [];
    disposers.push(ctx.tools.register(createStatusTool(runtime)));
    disposers.push(ctx.tools.register(createCleanTool(runtime)));
    return () => {
      for (const d of disposers.reverse()) {
        try {
          d?.();
        } catch (err) {
          runtime.diagnostics.push(`tool dispose: ${err?.message ?? err}`);
        }
      }
    };
  };

  const wirePrompt = (systemPrompt) => {
    if (!systemPrompt?.variable || !systemPrompt?.section) {
      runtime.diagnostics.push('systemPrompt 缺少 variable/section，跳过记忆注入');
      return () => {};
    }
    const disposeVariable = systemPrompt.variable('lifecycle_memory', () => runtime.memoryText());
    const disposeSection = systemPrompt.section({
      name: 'plugin:lifecycle-memory',
      order: 9200,
      text: '## 记忆\n\n{{lifecycle_memory}}',
    });
    return () => {
      try {
        disposeSection?.();
      } catch {}
      try {
        disposeVariable?.();
      } catch {}
    };
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => registerTools());
  } else {
    registerTools();
  }

  // systemPrompt 是**可选服务**：只能通过 ctx.inject 拿到。
  // 直接读 `ctx.systemPrompt` 会在未注入时抛
  // `cannot get property "variable" without inject`——即使包在 try 里也没用，
  // 因为取值本身就会抛。所以这里不碰属性，只在 inject 回调里用。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (systemPrompt) => {
      const dispose = wirePrompt(systemPrompt);
      ctx.effect(() => dispose);
    });
  } else {
    runtime.diagnostics.push('ctx.inject 不可用，跳过记忆注入');
  }
}

/** 库接口保持不变：入口从 `cleaner.js` 迁到本文件后仍可从这里导入。 */
export { LifecycleCacheCleaner, DEFAULTS } from './cleaner.js';
export * from './lib/core/index.js';
