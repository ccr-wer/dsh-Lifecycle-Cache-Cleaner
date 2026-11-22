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
