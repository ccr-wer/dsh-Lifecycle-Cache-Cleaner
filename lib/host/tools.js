/**
 * 模型可调用的两个工具。
 *
 * 直接用普通对象定义：`ctx.tools.register()` 只校验 `output.schema` 与 `render`，
 * 不要求经过 `defineTool()`，因此无需从宿主包 import 任何东西。
 */

const OUTPUT_TEXT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

export function formatStatus(r) {
  const lines = [];
  lines.push(`本地引擎：${r.engine.state}${r.engine.code ? `（${r.engine.code}）` : ''}`);
  if (r.engine.models.length > 0) lines.push(`已加载模型：${r.engine.models.join(', ')}`);
  lines.push(`归属模式：${r.engine.ownership}`);
  lines.push(`清理闸门：${r.gate.proceed ? '放行' : '拒绝'}（${r.gate.code}）`);
  lines.push(
    `记忆：共享 ${r.memory.shared} 条 / 本工作区 ${r.memory.workspace} 条` +
      `${r.memory.truncated > 0 ? `，截断 ${r.memory.truncated} 条` : ''}`,
  );
  lines.push(`工作区记忆文档：${r.memory.workspaceDocBytes} B`);
  if (r.sessionWatcher) {
    lines.push(
      `会话监听：跟踪 ${r.sessionWatcher.tracked} 个 / 已扫描 ${r.sessionWatcher.scans} 次` +
        `${r.sessionWatcher.running ? '' : '（未运行）'}`,
    );
  }
  if (r.recentDeletions?.length > 0) {
    const last = r.recentDeletions[0];
    lines.push(
      `最近一次删除：${last.sessions.length} 个会话，` +
        `${last.released ? '已释放引擎' : `未释放（${last.code}）`}`,
    );
  }
  lines.push(`数据目录：${r.rootDir}`);
  if (r.workspaceId) lines.push(`工作区：${r.workspaceId}`);
  if (r.diagnostics.length > 0) lines.push(`诊断：${r.diagnostics.join(' | ')}`);
  return lines.join('\n');
}

export function formatCleanResult(r) {
  return r.released
    ? `已释放。${r.reason}`
    : `未释放（${r.code}）：${r.reason}`;
}

/** 提议结果的说法要让人一眼知道“还没写进去，等人确认”。 */
export function formatProposalResult(r) {
  if (!r.ok) return `提议未提交（${r.code}）：${r.reason ?? r.code}`;
  if (r.code === 'duplicate') return '已有一条完全相同的待确认提议，没有重复添加。';
  return `已提交，等待用户在「记忆」面板里确认（当前待确认 ${r.pending ?? 1} 条）。在你收到确认前，它还没有进长期记忆。`;
}

/**
 * 记忆提议工具：只管“排队”，不直接写。
 *
 * 为什么不是直接写：记忆的写入口必须是用户确认过的（D15 / D25）。
 * 模型能看到的事实值得记，但它判断不了“该不该跨工作区共享”，
 * 所以这里只生成一条待确认提议，由用户在面板里点接受或拒绝。
 */
export function createProposeMemoryTool(runtime) {
  return {
    name: 'lifecycle_memory_propose',
    description:
      'Queue a fact for the user to confirm before it enters long-term memory. Nothing is stored until the user accepts it in the Memory panel. Use scope=shared only for facts that hold in every workspace; use scope=workspace plus the absolute workspace path for anything tied to one project, port, path, or file.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'One sentence stating the fact to remember, in the same language the user speaks.',
        },
        scope: {
          type: 'string',
          enum: ['shared', 'workspace'],
          description: 'shared = every workspace; workspace = only the given workspace path.',
        },
        workspace: {
          type: 'string',
          description: 'Absolute workspace directory path. Required when scope is workspace.',
        },
        reason: {
          type: 'string',
          description: 'Why this is worth remembering now (shown to the user with the proposal).',
        },
      },
      required: ['text', 'scope'],
      additionalProperties: false,
    },
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.();
      const result = runtime.proposals.add({
        text: args?.text,
        scope: args?.scope,
        workspaceId: args?.workspace ?? null,
        reason: args?.reason ?? '',
      });
      return formatProposalResult(result);
    },
  };
}

export function createStatusTool(runtime) {
  return {
    name: 'lifecycle_cache_status',
    description:
      'Report the local engine probe, the cleanup gate verdict, and how much workspace/shared memory is loaded. Read-only: writes nothing and never touches an engine.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    output: OUTPUT_TEXT,
    async execute(_args, exec) {
      exec?.signal?.throwIfAborted?.();
      return formatStatus(await runtime.status());
    },
  };
}

export function createCleanTool(runtime) {
  return {
    name: 'lifecycle_cache_clean',
    description:
      'Release the local engine through the unified cleanup gate. The gate refuses whenever the engine cannot be proven present and owned; set confirm=true to actually release after a passing verdict. Re-running with confirm=false only reports the verdict.',
    parameters: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'Set true to perform the release; false only reports the gate verdict.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.();
      const result = await runtime.clean({ confirm: args?.confirm === true });
      return formatCleanResult(result);
    },
  };
}
