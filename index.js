/**
 * DSH 插件入口（Host 侧）。
 *
 * 宿主规范（`dsh-doc/references/host-plugin.md`）：
 * bundle 的 `package.json` 声明 `dsh.bundle.patch`，patch 里 insert 本包名，
 * 宿主据此加载本模块，期望导出 `apply(ctx, config)`。
 *
 * 实际能力（六个，全部可验证）：
 *   1. `lifecycle_cache_status` 工具 —— 引擎探测 + 闸门结论 + 记忆用量，只读
 *   2. `lifecycle_cache_clean` 工具 —— 经统一闸门释放引擎（需 confirm）
 *   3. system prompt 注入 —— 共享/工作区记忆 + 用户自己写的助手设定
 *   4. 插件页状态卡 —— 读状态、按按钮释放（仍走同一个 runtime）
 *   5. 侧栏「会话」面板 —— 列出会话、把选中的会话移到回收站（不 rm）
 *   6. 侧栏「个性化」面板 —— 称呼 / 名字 / 风格 / 指令 / 人设，只有用户能写
 *
 * 不 import 任何 `@deepseek-ai/*` 包：profile 里解析不到宿主包，
 * 一切通过注入的 ctx 与 config 访问。
 */
import os from 'node:os';
import path from 'node:path';
import { HostRuntime } from './lib/host/runtime.js';
import { installCompactionHook } from './lib/host/compaction-hook.js';
import { createStatusTool, createCleanTool, createProposeMemoryTool } from './lib/host/tools.js';
import { SessionWatcher } from './lib/host/session-watcher.js';
import { registerWebApi } from './lib/host/web-api.js';
import { createEngineAdapter } from './adapters/engine-http.js';

/** 只要 tools 服务；systemPrompt / webServer 是可选的，用 ctx.inject 单独接。 */
export const inject = ['tools'];

function resolveRootDir(config) {
  return config.rootDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function apply(ctx, config = {}) {
  const sessionsDir = config.sessionsDir || path.join(resolveRootDir(config), 'sessions');
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
    disposers.push(ctx.tools.register(createProposeMemoryTool(runtime)));
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
    // 用户自己的设定（称呼 / 名字 / 风格 / 指令 / 人设）走同一个 section：
    // 一个 section 里放两个变量，避免多注册一个 section 打乱既有断言。
    const disposeProfile = systemPrompt.variable('lifecycle_profile', () => runtime.profileText());
    const disposeSection = systemPrompt.section({
      name: 'plugin:lifecycle-memory',
      order: 9200,
      text: '{{lifecycle_profile}}{{lifecycle_memory}}',
    });
    return () => {
      try {
        disposeSection?.();
      } catch {}
      try {
        disposeProfile?.();
      } catch {}
      try {
        disposeVariable?.();
      } catch {}
    };
  };

  const startWatcher = () => {
    if (config.watchSessions === false) return () => {};
    const watcher = new SessionWatcher({
      sessionsDir,
      intervalMs: config.watchIntervalMs ?? 5000,
      onRemoved: (removed) => runtime.handleSessionsRemoved(removed),
      onError: (err) => runtime.diagnostics.push(`watcher: ${err?.message ?? err}`),
    });
    runtime.attachWatcher(watcher);
    watcher.start();
    return () => watcher.stop();
  };

  /**
   * 上下文压缩之后也清一次：压缩换掉了整段上下文，旧 KV cache 不再有复用价值。
   * 失败的压缩不清（上下文没变）。合并窗口见 compaction-hook.js。
   */
  const startCompactionHook = () => {
    if (config.releaseOnCompact === false) return () => {};
    return installCompactionHook(ctx, runtime, { debounceMs: config.compactDebounceMs ?? undefined });
  };

  const boot = () => {
    const disposers = [registerTools(), startWatcher(), startCompactionHook()];
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose?.();
        } catch (err) {
          runtime.diagnostics.push(`dispose: ${err?.message ?? err}`);
        }
      }
    };
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(boot);
  } else {
    boot();
  }

  // systemPrompt 是**可选服务**。两条路都要走一遍：
  //   1. 服务已经在了 —— `ctx.get()` 拿到（Cordis 的 Context 才有 get，纯对象假 ctx 没有）；
  //   2. 还没上线 —— `ctx.inject(['systemPrompt'], …)` 等它。
  // 只写第 2 条会踩坑：服务早在本插件激活前就绪时，单靠 inject 的等待语义不够可靠，
  // 结果是 section 根本没注册、prompt 里什么都没有（实测：会话日志里查不到记忆段）。
  // 直接读 `ctx.systemPrompt` 仍是不行的：未注入时取值本身就抛，包在 try 里也没用。
  const attachPrompt = (systemPrompt, via) => {
    runtime.diagnostics.push(`prompt: 已通过 ${via} 接上 systemPrompt`);
    const dispose = wirePrompt(systemPrompt);
    return () => {
      runtime.diagnostics.push('prompt: systemPrompt 接入已断开');
      dispose();
    };
  };

  const directPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
  if (directPrompt) {
    ctx.effect(() => attachPrompt(directPrompt, 'ctx.get'));
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (systemPrompt) => {
      ctx.effect(() => attachPrompt(systemPrompt, 'ctx.inject'));
    });
  } else {
    runtime.diagnostics.push('ctx.inject 不可用，跳过记忆注入');
  }

  // 工作区记忆必须**按会话的 cwd** 渲染：桌面进程里插件的 workspaceId 是 profile 目录，
  // 用它渲染会把所有项目的条目串在一起。所以给每个 agent 注册一段 scoped section，
  // 共享层仍然在全局 section 里（`runtime.memoryText()` 现在只渲染共享层）。
  const agentMemoryFibers = new Map();
  const installAgentMemory = (agent) => {
    if (!agent || !agent.id || agentMemoryFibers.has(agent.id)) return;
    const workspaceId = agent?.session?.header?.cwd ?? null;
    if (!workspaceId || !agent.ctx || typeof agent.ctx.inject !== 'function') return;
    try {
      const fiber = agent.ctx.inject(['systemPrompt'], (scoped) => {
        scoped.systemPrompt.section({
          name: 'plugin:lifecycle-workspace-memory',
          order: 9210,
          text: () => runtime.workspaceMemoryText(workspaceId),
        });
      });
      agentMemoryFibers.set(agent.id, fiber);
    } catch (err) {
      runtime.diagnostics.push(`agent memory section: ${err?.message ?? err}`);
    }
  };

  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', ({ agent }) => {
      installAgentMemory(agent);
    });
    // 插件热重载时，已经存在的 agent 不会再有 agent/created 事件，补一遍。
    try {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
      for (const agent of agents?.list?.() ?? []) installAgentMemory(agent);
    } catch (err) {
      runtime.diagnostics.push(`agents.list: ${err?.message ?? err}`);
    }
    ctx.effect(() => () => {
      for (const fiber of agentMemoryFibers.values()) {
        try {
          fiber?.();
        } catch {}
      }
      agentMemoryFibers.clear();
    });
  }

  // UI 的 HTTP 面：同样只能靠 ctx.inject 等 webServer/connection 上线。
  // `ctx.get` 用来判断“这是不是真正的 Cordis Context”——纯对象假 ctx（测试）
  // 没有 get()，也没有可选服务解析能力，此时不注册第二条 inject，
  // 免得既有测试的 inject 调用序列被改变。
  if (typeof ctx.inject === 'function' && typeof ctx.get === 'function') {
    /**
     * workspaceRegistry 是可选服务，而且可能晚于 webServer/connection 就绪。
     * 只在 web 注入回调里 `ctx.get()` 一次会拿到 undefined，并且**永远**是 undefined——
     * 表现就是：新建了工作区，记忆面板里却一直只有旧的那些组。
     * 所以单独 inject 一份实时引用，回调触发时才赋值。
     */
    let workspaceRegistry = null;
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['workspaceRegistry'], (registryCtx) => {
          workspaceRegistry = registryCtx.workspaceRegistry ?? null;
        });
      } catch {
        /* 宿主没装 workspace 服务：保持 null，功能降级 */
      }
    }
    const getWorkspaceRegistry = () => {
      if (workspaceRegistry) return workspaceRegistry;
      try {
        return ctx.get('workspaceRegistry') ?? null;
      } catch {
        return null;
      }
    };
    let reportedMissingRegistry = false;

    ctx.inject(['webServer', 'connection'], (webCtx) => {
      const listWorkspaces = () => {
        const registry = getWorkspaceRegistry();
        if (!registry || typeof registry.list !== 'function') {
          if (!reportedMissingRegistry) {
            reportedMissingRegistry = true;
            runtime.diagnostics.push('workspaceRegistry: 不可用（记忆面板只显示已有记忆里的工作区）');
          }
          return [];
        }
        try {
          return registry
            .list()
            .map((workspace) => ({
              id: workspace?.id,
              path: workspace?.path ?? workspace?.id,
              title: workspace?.title ?? workspace?.name ?? '',
            }))
            .filter((workspace) => typeof workspace.path === 'string' && workspace.path !== '');
        } catch (err) {
          runtime.diagnostics.push(`workspaceRegistry.list: ${err?.message ?? err}`);
          return [];
        }
      };
      const dispose = registerWebApi({
        runtime,
        webServer: webCtx.webServer,
        connection: webCtx.connection,
        sessionsDir,
        trashDir: path.join(runtime.rootDir, 'lifecycle-cache', 'trash'),
        minIdleMs: config.sessionDeleteMinIdleMs ?? 120000,
        profileStore: runtime.profiles,
        listWorkspaces,
        rootDir: runtime.rootDir,
        // 删除会话后必须把宿主导航页的数据源也清掉，否则索引里还记着它（D30）。
        // 每次调用都重新取 registry：服务晚就绪时也接得上。
        workspaceHooks: {
          listIndex: () => {
            const registry = getWorkspaceRegistry();
            if (!registry || typeof registry.list !== 'function') return null;
            try {
              return registry.list().map((workspace) => ({
                path: workspace?.path ?? null,
                sessionIds: Array.isArray(workspace?.sessionIds) ? [...workspace.sessionIds] : [],
              }));
            } catch (err) {
              runtime.diagnostics.push(`workspaceRegistry.list: ${err?.message ?? err}`);
              return null;
            }
          },
          detachSession: async (sessionId) => {
            const registry = getWorkspaceRegistry();
            if (!registry || typeof registry.list !== 'function') return;
            // 宿主 sessionIds 里存的是 `session-<uuid>`；我们手里可能是裸 uuid。
            // 两边都归一化再比，真正 detach 时传宿主那份原值。
            const normalize = (raw) => String(raw ?? '').replace(/^session-/, '');
            const target = normalize(sessionId);
            for (const workspace of registry.list()) {
              const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : [];
              const hit = ids.find((raw) => normalize(raw) === target);
              if (hit !== undefined) await workspace.detachSession(hit);
            }
          },
          // 让客户端的会话列表立刻少掉这一行：删历史会话时宿主不会自己发这个事件。
          notifyRemoved: (sessionId) => {
            if (typeof ctx.emit === 'function') ctx.emit('api-session/removed', sessionId);
          },
        },
      });
      ctx.effect(() => dispose);
    });
  }
}

/** 库接口保持不变：入口从 `cleaner.js` 迁到本文件后仍可从这里导入。 */
export { LifecycleCacheCleaner, DEFAULTS } from './cleaner.js';
export * from './lib/core/index.js';
