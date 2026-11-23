/**
 * dsh-lifecycle-cache-cleaner —— Client 半边。
 *
 * 两块 UI，共用同一个 Host HTTP 面：
 *   1. 插件页状态卡（`plugins.bundle.config`）：引擎 / 闸门 / 记忆 + 释放按钮。
 *   2. 侧栏「会话」面板（`sidebar.footer.action`）：列出会话、把选中的会话移到回收站。
 *
 * 硬约束：
 *   - 闸门与删除判定都不在浏览器里：状态来自 Host 投影，删除只是一个 POST，
 *     Host 侧 `lib/host/web-api.js` → `session-store.js` 负责路径收敛与移动。
 *   - 不 import 任何宿主 Client 包。React 走模块表，样式用 `--dsw-alias-*` 自己写。
 */
window.__ModuleLoader__.load({
  id: 'dsh-lifecycle-cache-cleaner',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PACKAGE = 'dsh-lifecycle-cache-cleaner';
    const NS = 'lifecycle-cache-cleaner';
    // 与 Host 侧 lib/host/web-api.js 的 ROUTE_BASE 必须一致。
    const API = '/lifecycle-cache/api';

    /**
     * 会话/工作区列表的刷新入口。
     *
     * 不能直接读 `ctx.sessions`：没在 inject 里声明过的服务，取值本身就抛
     * `cannot get property "sessions" without inject`，包 try 也拦不住。
     * 所以用 `ctx.inject([...], cb)` 拿 scoped ctx，拿不到就保持空函数（功能降级，不影响激活）。
     */
    let refreshSessions = () => {};
    let refreshWorkspaces = () => {};

    const zh = {
      'card.title': '生命周期缓存',
      'card.loading': '读取中…',
      'card.error': '读取失败：{message}',
      'card.engine': '引擎 {state}',
      'card.gate.allowed': '闸门放行',
      'card.gate.denied': '闸门拒绝（{code}）',
      'card.memory': '记忆 {shared}/{workspace}',
      'card.release': '释放引擎',
      'card.releasing': '释放中…',
      'card.refresh': '刷新',
      'card.released': '已释放。',
      'card.notReleased': '未释放（{code}）：{reason}',
      'card.blocked': '不可释放：{reason}',
      'card.summary': '引擎 {state} · 闸门 {gate}',
      'gate.skip_absent': '本机没有探测到本地引擎，按闸门规则不动它。',
      'gate.skip_unknown': '探测失败或适配器没有实现 probeEngine，fail-closed，不清理。',
      'gate.skip_no_lease': '有引擎但没有对应租约，无法证明归属，不清理。',
      'gate.skip_foreign': '引擎归属对不上（foreign），不清理。',
      'gate.confirm_required': '闸门已放行，但缺少 confirm=true，未执行释放。',
      'gate.no_destroy': '适配器没有实现 destroyEngine()，无法释放。',
      'gate.released': '引擎已释放。',
      'gate.release_failed': '释放失败。',
      'gate.request_failed': '请求宿主失败。',
      'gate.internal_error': '宿主处理请求时出错。',
      'gate.auth_unavailable': '宿主认证服务未就绪。',
      'gate.unauthorized': '需要有效的 DSH 会话凭证。',
      'gate.forbidden': '需要 owner 权限。',
      'gate.not_found': '接口不存在（可能是 Host 侧未加载）。',
      'panel.button': '会话',
      'panel.title': '会话',
      'panel.heading': '会话（删除 = 移到回收站）',
      'panel.hint': '删除会把整个会话目录移到回收站，需要时可原样搬回；最近有写入的会话会被拒绝。',
      'panel.loading': '读取会话列表…',
      'panel.empty': '没有找到会话目录。',
      'panel.error': '读取失败：{message}',
      'panel.updated': '最后活动 {time}',
      'panel.size': '{size}',
      'panel.active': '最近 {minutes} 分钟内被写过，暂不允许删除',
      'panel.delete': '删除',
      'panel.confirm': '确认删除',
      'panel.cancel': '取消',
      'panel.deleting': '删除中…',
      'panel.trashed': '已移到回收站。',
      'panel.close': '关闭',
      'panel.refresh': '刷新',
      'panel.unknown': '未知',
      'panel.orphans': '导航页还有 {n} 条失效记录（会话目录已不在，点进去会报 not-found）',
      'panel.repair': '清理失效记录',
      'panel.repaired': '已摘掉 {n} 条失效记录。',
      'profile.button': '个性化',
      'profile.title': '个性化（只由你编辑）',
      'profile.hint': '这些内容由你在界面里写，模型没有任何写入口；保存后会原样进入 system prompt。',
      'profile.userName': '你希望它怎么称呼你',
      'profile.assistantName': '它叫什么名字',
      'profile.style': '回复风格',
      'profile.instructions': '长期指令',
      'profile.persona': '人设',
      'profile.instructionsHint': '每次对话都会生效，例如：先给结论，再给依据。',
      'profile.personaHint': '身份、性格、表达方式，例如：你是夜枭，说话直接。',
      'profile.save': '保存',
      'profile.saving': '保存中…',
      'profile.reload': '重新载入',
      'profile.saved': '已保存。',
      'profile.savedAt': '上次保存 {time}',
      'profile.error': '保存失败：{message}',
      'profile.loadError': '读取失败：{message}',
      'profile.style.default': '默认',
      'profile.style.concise': '简洁',
      'profile.style.detailed': '详细',
      'memory.button': '记忆',
      'memory.title': '记忆（用户可编辑）',
      'memory.hint': '共享记忆所有工作区都能读到；工作区记忆只属于当前工作区。保存后会进入 system prompt。',
      'memory.tab.shared': '共享记忆',
      'memory.tab.workspace': '本工作区',
      'memory.sharedEmpty': '还没有共享记忆。',
      'memory.workspaceEmpty': '这个工作区还没有条目记忆。',
      'memory.addPlaceholder': '写一条要记住的事实，例如：发布前必须跑完整测试套件',
      'memory.add': '添加',
      'memory.saving': '保存中…',
      'memory.saved': '已保存。',
      'memory.error': '操作失败：{message}',
      'memory.delete': '删除',
      'memory.confirmDelete': '确认删除',
      'memory.cancel': '取消',
      'memory.author.user': '你写的',
      'memory.author.model': '模型提议',
      'memory.author.promoted': '自动升级',
      'memory.conflict': '与另一条冲突',
      'memory.updated': '更新于 {time}',
      'memory.budget': '注入预算：共享 {shared}B / 工作区 {workspace}B',
      'memory.docLabel': '本工作区记忆文档（整段 Markdown，随工作区走）',
      'memory.docPlaceholder': '这个工作区的长期约定、环境事实、注意事项……',
      'memory.docSave': '保存文档',
      'memory.docEmpty': '还没有文档。写点东西再保存。',
      'memory.archive': '归档',
      'memory.archiveConfirm': '确认归档',
      'memory.archived': '已归档（移到 memory/.archive，可人工恢复）。',
      'memory.workspace': '工作区：{key}',
      'memory.sharedTitle': '共享记忆（所有工作区共享）',
      'memory.proposed': '模型建议写入（等你确认）',
      'memory.accept': '接受',
      'memory.reject': '拒绝',
      'memory.accepted': '已接受，写进记忆。',
      'memory.rejected': '已拒绝，未写入。',
      'memory.reason': '理由：{reason}',
      'memory.group_entries': '{n} 条',
      'memory.pending': '{n} 条待确认',
      'memory.current': '当前',
    };

    const en = {
      'card.title': 'Lifecycle cache',
      'card.loading': 'Loading…',
      'card.error': 'Read failed: {message}',
      'card.engine': 'Engine {state}',
      'card.gate.allowed': 'Gate open',
      'card.gate.denied': 'Gate closed ({code})',
      'card.memory': 'Memory {shared}/{workspace}',
      'card.release': 'Release engine',
      'card.releasing': 'Releasing…',
      'card.refresh': 'Refresh',
      'card.released': 'Released.',
      'card.notReleased': 'Not released ({code}): {reason}',
      'card.blocked': 'Cannot release: {reason}',
      'card.summary': 'Engine {state} · gate {gate}',
      'gate.skip_absent': 'No local engine was detected, so the gate leaves it alone.',
      'gate.skip_unknown': 'The probe failed or the adapter has no probeEngine, so the gate fails closed.',
      'gate.skip_no_lease': 'An engine exists but no lease proves ownership, so it is not cleaned.',
      'gate.skip_foreign': 'The engine is not owned by this workspace (foreign).',
      'gate.confirm_required': 'The gate allowed it, but confirm=true was missing.',
      'gate.no_destroy': 'The adapter has no destroyEngine(), so nothing can be released.',
      'gate.released': 'The engine was released.',
      'gate.release_failed': 'The release failed.',
      'gate.request_failed': 'The request to the Host failed.',
      'gate.internal_error': 'The Host failed while handling the request.',
      'gate.auth_unavailable': 'The Host authentication service is not ready.',
      'gate.unauthorized': 'A valid DSH session credential is required.',
      'gate.forbidden': 'Owner permission is required.',
      'gate.not_found': 'The endpoint is missing (the Host side may not be loaded).',
      'panel.button': 'Sessions',
      'panel.title': 'Sessions',
      'panel.heading': 'Sessions (delete = move to trash)',
      'panel.hint': 'Deleting moves the whole session folder to the trash so it can be moved back; sessions written recently are refused.',
      'panel.loading': 'Loading sessions…',
      'panel.empty': 'No session folders found.',
      'panel.error': 'Read failed: {message}',
      'panel.updated': 'Last activity {time}',
      'panel.size': '{size}',
      'panel.active': 'Written within the last {minutes} min, not deletable yet',
      'panel.delete': 'Delete',
      'panel.confirm': 'Confirm delete',
      'panel.cancel': 'Cancel',
      'panel.deleting': 'Deleting…',
      'panel.trashed': 'Moved to the trash.',
      'panel.close': 'Close',
      'panel.refresh': 'Refresh',
      'panel.unknown': 'unknown',
      'panel.orphans': '{n} stale entries still listed in the sidebar (folder gone, opening them fails)',
      'panel.repair': 'Drop stale entries',
      'panel.repaired': 'Dropped {n} stale entries.',
      'profile.button': 'Personalize',
      'profile.title': 'Personalization (only you can edit)',
      'profile.hint': 'You write these here; the model has no way to write them. Saving puts them into the system prompt verbatim.',
      'profile.userName': 'How it should address you',
      'profile.assistantName': 'Its name',
      'profile.style': 'Reply style',
      'profile.instructions': 'Standing instructions',
      'profile.persona': 'Persona',
      'profile.instructionsHint': 'Applied to every conversation, e.g. lead with the conclusion, then the reasoning.',
      'profile.personaHint': 'Identity, character, and voice, e.g. you are Nightowl and you speak plainly.',
      'profile.save': 'Save',
      'profile.saving': 'Saving…',
      'profile.reload': 'Reload',
      'profile.saved': 'Saved.',
      'profile.savedAt': 'Last saved {time}',
      'profile.error': 'Save failed: {message}',
      'profile.loadError': 'Read failed: {message}',
      'profile.style.default': 'Default',
      'profile.style.concise': 'Concise',
      'profile.style.detailed': 'Detailed',
      'memory.button': 'Memory',
      'memory.title': 'Memory (you can edit)',
      'memory.hint': 'Shared memory is readable from every workspace; workspace memory belongs to this one. Saving puts it into the system prompt.',
      'memory.tab.shared': 'Shared',
      'memory.tab.workspace': 'This workspace',
      'memory.sharedEmpty': 'No shared memory yet.',
      'memory.workspaceEmpty': 'No workspace entries yet.',
      'memory.addPlaceholder': 'One fact worth remembering, e.g. always run the full test suite before publishing',
      'memory.add': 'Add',
      'memory.saving': 'Saving…',
      'memory.saved': 'Saved.',
      'memory.error': 'Failed: {message}',
      'memory.delete': 'Delete',
      'memory.confirmDelete': 'Confirm delete',
      'memory.cancel': 'Cancel',
      'memory.author.user': 'You',
      'memory.author.model': 'Model proposal',
      'memory.author.promoted': 'Promoted',
      'memory.conflict': 'Conflicts with another entry',
      'memory.updated': 'Updated {time}',
      'memory.budget': 'Prompt budget: shared {shared}B / workspace {workspace}B',
      'memory.docLabel': 'Workspace memory document (whole Markdown, travels with the workspace)',
      'memory.docPlaceholder': 'Long-lived conventions, environment facts, gotchas for this workspace…',
      'memory.docSave': 'Save document',
      'memory.docEmpty': 'No document yet. Write something first.',
      'memory.archive': 'Archive',
      'memory.archiveConfirm': 'Confirm archive',
      'memory.archived': 'Archived to memory/.archive (recoverable by hand).',
      'memory.workspace': 'Workspace: {key}',
      'memory.sharedTitle': 'Shared memory (every workspace)',
      'memory.proposed': 'Proposed by the model (waiting for you)',
      'memory.accept': 'Accept',
      'memory.reject': 'Reject',
      'memory.accepted': 'Accepted and stored.',
      'memory.rejected': 'Rejected, nothing stored.',
      'memory.reason': 'Why: {reason}',
      'memory.group_entries': '{n} entries',
      'memory.pending': '{n} pending',
      'memory.current': 'Current',
    };

    const CSS = [
      '.lc-card{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:12px 14px;',
      'border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;background:transparent}',
      '.lc-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.lc-title{font-weight:600;color:var(--dsw-alias-label-primary,#111)}',
      '.lc-meta{flex:1 1 220px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#666)}',
      '.lc-actions{display:flex;align-items:center;gap:6px;margin-left:auto}',
      '.lc-btn{box-sizing:border-box;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#ddd);',
      'border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#111);font-size:12px;cursor:pointer}',
      '.lc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.lc-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.lc-primary{border-color:var(--dsw-alias-state-error-primary,#c0392b);color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.lc-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#666)}',
      // 侧栏入口
      // 两个入口共处一行：各自 flex:1 平分宽度，避免两个 width:100% 的按钮叠在一起、
      // 点击落到邻居身上（实际踩过：点「个性化」没反应）。
      '.lc-navWrap{display:flex;flex:1 1 0;min-width:0}',
      '.lc-nav{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;',
      'border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#111);',
      'font-size:13px;text-align:left;cursor:pointer}',
      '.lc-nav:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.lc-navKey{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#666)}',
      // 弹层：fixed 定位，脱离侧栏的 overflow
      '.lc-scrim{position:fixed;inset:0;z-index:1100;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));',
      'display:flex;align-items:center;justify-content:center;padding:24px}',
      '.lc-dialog{box-sizing:border-box;display:flex;flex-direction:column;width:min(640px,92vw);',
      'max-height:min(560px,80vh);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-2,#1b1b1f);box-shadow:0 12px 40px rgba(0,0,0,.42);overflow:hidden}',
      '.lc-dialogHead,.lc-dialogFoot{background:inherit}',
      '.lc-dialogHead{display:flex;align-items:center;gap:10px;padding:14px 16px;',
      'border-bottom:1px solid var(--dsw-alias-border-l2,#ddd)}',
      '.lc-dialogBody{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 16px}',
      '.lc-dialogFoot{display:flex;align-items:center;gap:8px;padding:12px 16px;',
      'border-top:1px solid var(--dsw-alias-border-l2,#ddd)}',
      '.lc-row{display:flex;align-items:center;gap:10px;padding:9px 0;',
      'border-bottom:1px solid var(--dsw-alias-border-l2,#eee)}',
      '.lc-row:last-child{border-bottom:none}',
      '.lc-rowMain{flex:1 1 auto;min-width:0}',
      '.lc-rowTitle{font-size:13px;color:var(--dsw-alias-label-primary,#111);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.lc-rowMeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#666)}',
      '.lc-rowActions{display:flex;align-items:center;gap:6px}',
      '.lc-danger{border-color:var(--dsw-alias-state-error-primary,#c0392b);color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.lc-groupTitle{margin:10px 0 2px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;',
      'color:var(--dsw-alias-label-tertiary,#888)}',
      '.lc-status{margin:0;padding:8px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#666)}',
      '.lc-statusOk{color:var(--dsw-alias-state-success-primary,#1e8449)}',
      '.lc-statusError{color:var(--dsw-alias-state-error-primary,#c0392b)}',
      // 个性化表单
      '.lc-form{display:flex;flex-direction:column;gap:12px;padding:4px 0 8px}',
      '.lc-field{display:flex;flex-direction:column;gap:4px}',
      '.lc-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#555)}',
      '.lc-input,.lc-select,.lc-textarea{box-sizing:border-box;width:100%;padding:6px 8px;font:inherit;font-size:13px;',
      'color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-fill-l1,transparent);',
      'border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:7px}',
      '.lc-textarea{min-height:76px;resize:vertical;line-height:20px}',
      '.lc-input:focus,.lc-select:focus,.lc-textarea:focus{outline:none;border-color:var(--dsw-alias-border-selected,#247bbf)}',
      '.lc-formActions{display:flex;align-items:center;gap:8px;padding-top:2px}',
      '.lc-formHint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888)}',
      // 记忆面板
      '.lc-tabs{display:flex;gap:6px;margin:2px 0 10px}',
      '.lc-tab{box-sizing:border-box;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#ccc);',
      'border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#555);font-size:12px;cursor:pointer}',
      '.lc-tabActive{border-color:var(--dsw-alias-border-selected,#247bbf);color:var(--dsw-alias-label-primary,#111)}',
      '.lc-entry{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#eee)}',
      '.lc-entry:last-child{border-bottom:none}',
      '.lc-entryText{flex:1 1 auto;min-width:0;font-size:13px;line-height:19px;white-space:pre-wrap;word-break:break-word;',
      'color:var(--dsw-alias-label-primary,#111)}',
      '.lc-entryMeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888)}',
      '.lc-tag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;font-size:10px;line-height:15px;',
      'border:1px solid var(--dsw-alias-border-l2,#ccc);color:var(--dsw-alias-label-tertiary,#777)}',
      '.lc-add{display:flex;flex-direction:column;gap:6px;padding:8px 0 4px}',
      // 按工作区分组的折叠列表
      '.lc-group{border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;margin:6px 0;overflow:hidden}',
      '.lc-groupHead{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;',
      'border:none;background:transparent;color:var(--dsw-alias-label-primary,#111);font-size:13px;text-align:left;cursor:pointer}',
      '.lc-groupHead:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.lc-caret{width:14px;color:var(--dsw-alias-label-tertiary,#888)}',
      '.lc-groupLabel{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}',
      '.lc-groupMeta{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}',
      '.lc-badge{display:inline-block;padding:0 5px;border-radius:4px;font-size:10px;line-height:15px;',
      'border:1px solid var(--dsw-alias-border-l2,#ccc);color:var(--dsw-alias-label-tertiary,#777)}',
      '.lc-badgeWarn{border-color:var(--dsw-alias-state-warning-primary,#b7791f);color:var(--dsw-alias-state-warning-primary,#b7791f)}',
      '.lc-groupBody{padding:4px 10px 10px;border-top:1px solid var(--dsw-alias-border-l2,#eee)}',
      '.lc-proposal{background:var(--dsw-alias-fill-l1,rgba(0,0,0,.03));border-radius:6px;padding:6px 8px;margin:4px 0}',
      '.lc-orphans{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;margin:6px 0;',
      'border:1px dashed var(--dsw-alias-state-warning-primary,#b7791f);border-radius:8px}',
    ].join('');

    /** 只替换 `{name}`；locale 服务自身通常也会插值，这里兜底。 */
    function interpolate(text, params) {
      if (typeof text !== 'string' || !params) return text;
      return text.replace(/\{(\w+)\}/g, (all, key) => (key in params ? String(params[key]) : all));
    }

    function detectLanguage() {
      try {
        const lang = String(document?.documentElement?.lang ?? navigator?.language ?? 'en').toLowerCase();
        return lang.startsWith('zh') ? zh : en;
      } catch {
        return en;
      }
    }

    /**
     * 文本函数：优先用 slot 注入的 `t`（并由 `locale: NS` 的字典渲染），
     * 没有 `t` 时（例如宿主换了 slot 契约）退到本地字典，保证不出现裸 key。
     */
    function makeText(props) {
      const injected = props && typeof props.t === 'function' ? props.t : null;
      const dictionary = detectLanguage();
      return (key, params) => {
        if (injected) {
          const value = injected(key, params);
          if (typeof value === 'string' && value !== key) return value;
        }
        return interpolate(dictionary[key] ?? en[key] ?? key, params);
      };
    }

    /** 把闸门/释放的 code 翻成人话；未知 code 用宿主给的中文原因兜底。 */
    function codeText(t, code, hostReason) {
      const key = `gate.${code ?? 'unknown'}`;
      const text = t(key);
      if (typeof text === 'string' && text !== key) return text;
      return hostReason || code || 'unknown';
    }

    function messageOf(error) {
      return error && error.message ? error.message : String(error);
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    function formatTime(value) {
      const time = Number(value) || 0;
      if (time <= 0) return '—';
      try {
        return new Date(time).toLocaleString();
      } catch {
        return String(time);
      }
    }

    /** 同源请求；非 2xx 或 `ok:false` 都抛错，交给 UI 显示。 */
    async function request(method, path, body) {
      const init = {
        method,
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(API + path, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const error = new Error((payload && (payload.error || (payload.result && payload.result.reason))) || `HTTP ${response.status}`);
        error.code = (payload && (payload.code || (payload.result && payload.result.code))) || `http_${response.status}`;
        throw error;
      }
      return payload.result;
    }

    // ---------------------------------------------------------------- 状态卡

    function StatusCard(props) {
      const t = makeText(props);
      const [snapshot, setSnapshot] = React.useState({ phase: 'loading' });
      const [busy, setBusy] = React.useState(false);
      const [outcome, setOutcome] = React.useState(null);
      const alive = React.useRef(true);

      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = React.useCallback(async () => {
        try {
          const status = await request('GET', '/status');
          if (alive.current) setSnapshot({ phase: 'ready', status });
        } catch (error) {
          if (alive.current) setSnapshot({ phase: 'error', message: messageOf(error) });
        }
      }, []);

      React.useEffect(() => {
        void load();
      }, [load]);

      const release = React.useCallback(async () => {
        setBusy(true);
        setOutcome(null);
        try {
          const result = await request('POST', '/clean', { confirm: true });
          if (alive.current) setOutcome(result);
          await load();
        } catch (error) {
          if (alive.current) {
            setOutcome({
              released: false,
              code: error.code && String(error.code).startsWith('http_') ? 'internal_error' : error.code,
              reason: messageOf(error),
            });
          }
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [load]);

      // 摘要视图（官方卡的一行）只给不占空间的文本。
      if (props && props.view === 'summary') {
        const status = snapshot.phase === 'ready' ? snapshot.status : null;
        return h(
          'span',
          null,
          status
            ? t('card.summary', {
                state: status.engine?.state ?? 'unknown',
                gate: status.gate?.proceed ? t('card.gate.allowed') : t('card.gate.denied', { code: status.gate?.code ?? '-' }),
              })
            : t('card.loading'),
        );
      }

      const status = snapshot.phase === 'ready' ? snapshot.status : null;
      const gate = status ? status.gate : null;
      const canRelease = Boolean(gate && gate.proceed === true && !busy);
      const blocked = status && !gate.proceed ? codeText(t, gate.code, gate.reason) : null;

      const meta = [];
      if (snapshot.phase === 'loading') {
        meta.push(t('card.loading'));
      } else if (snapshot.phase === 'error') {
        meta.push(t('card.error', { message: snapshot.message }));
      } else if (status) {
        meta.push(t('card.engine', { state: status.engine?.state ?? 'unknown' }));
        meta.push(
          gate.proceed
            ? t('card.gate.allowed')
            : t('card.gate.denied', { code: gate.code ?? '-' }),
        );
        meta.push(
          t('card.memory', {
            shared: status.memory?.shared ?? 0,
            workspace: status.memory?.workspace ?? 0,
          }),
        );
      }

      let outcomeText = null;
      if (outcome) {
        outcomeText = outcome.released
          ? t('card.released')
          : t('card.notReleased', {
              code: outcome.code ?? 'unknown',
              reason: codeText(t, outcome.code, outcome.reason),
            });
      }

      return h(
        'div',
        { className: 'lc-card', 'data-plugin': PACKAGE },
        h('style', null, CSS),
        h(
          'div',
          { className: 'lc-head' },
          h('span', { className: 'lc-title' }, t('card.title')),
          h('span', { className: 'lc-meta', 'data-lc-meta': '1' }, meta.join(' · ')),
          h(
            'span',
            { className: 'lc-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'lc-btn',
                onClick: () => {
                  void load();
                },
                disabled: busy,
                title: t('card.refresh'),
              },
              t('card.refresh'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'lc-btn lc-primary',
                onClick: () => {
                  void release();
                },
                disabled: !canRelease,
                title: blocked ?? t('card.release'),
                'data-lc-action': 'release',
              },
              busy ? t('card.releasing') : t('card.release'),
            ),
          ),
        ),
        blocked ? h('p', { className: 'lc-hint', role: 'status' }, t('card.blocked', { reason: blocked })) : null,
        outcomeText ? h('p', { className: 'lc-hint', role: 'status', 'data-lc-outcome': '1' }, outcomeText) : null,
      );
    }

    // ------------------------------------------------------------ 会话面板

    /**
     * 侧栏入口 + 会话列表弹层。
     *
     * 删除是“移动”而不是删：Host 把目录 rename 到回收站目录，并立刻走一次
     * 租约释放 + 闸门。最近有写入的会话在两侧都会显示为不可删（Host 也会拒）。
     */
    function SessionPanel(props) {
      const t = makeText(props);
      const [open, setOpen] = React.useState(false);
      const [snapshot, setSnapshot] = React.useState({ phase: 'idle', sessions: [], minIdleMs: 0 });
      const [pendingId, setPendingId] = React.useState(null);
      const [busyId, setBusyId] = React.useState(null);
      const [outcome, setOutcome] = React.useState(null);
      const alive = React.useRef(true);

      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = React.useCallback(async () => {
        setSnapshot((prev) => ({ ...prev, phase: 'loading' }));
        try {
          const result = await request('GET', '/sessions');
          if (!alive.current) return;
          setSnapshot({
            phase: 'ready',
            sessions: Array.isArray(result?.sessions) ? result.sessions : [],
            orphans: Array.isArray(result?.orphans) ? result.orphans : [],
            minIdleMs: Number(result?.minIdleMs) || 0,
          });
        } catch (error) {
          if (alive.current) {
            setSnapshot({ phase: 'error', sessions: [], orphans: [], minIdleMs: 0, message: messageOf(error) });
          }
        }
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        void load();
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [open, load]);

      const isActive = (session) => {
        if (!snapshot.minIdleMs) return false;
        const updated = Number(session?.updatedAt) || 0;
        return updated > 0 && Date.now() - updated < snapshot.minIdleMs;
      };

      const remove = React.useCallback(
        async (session) => {
          setBusyId(session.id);
          setOutcome(null);
          try {
            await request('POST', '/sessions/delete', { id: session.id, confirm: true });
            if (alive.current) {
              setOutcome({ ok: true, text: t('panel.trashed') });
              setPendingId(null);
            }
            await load();
            // 导航页列表是客户端缓存：先让宿主补发的 api-session/removed 生效，
            // 再显式重拉一次，双保险（任一路径可用即可）。
            try {
              refreshSessions();
            } catch {
              /* 会话服务缺席时不影响删除结果 */
            }
            try {
              // 工作区列表也要重读，否则分组归属还是旧的（D30 / D31）。
              refreshWorkspaces();
            } catch {
              /* 同上 */
            }
          } catch (error) {
            if (alive.current) setOutcome({ ok: false, text: messageOf(error) });
          } finally {
            if (alive.current) setBusyId(null);
          }
        },
        [load, t],
      );

      /** 清掉「导航页还显示、磁盘上已经没有」的失效记录。 */
      const repair = React.useCallback(async () => {
        setBusyId('__repair__');
        setOutcome(null);
        try {
          const result = await request('POST', '/sessions/repair', {});
          if (alive.current) {
            setOutcome({ ok: true, text: t('panel.repaired', { n: result?.detached?.length ?? 0 }) });
          }
          await load();
          try {
            refreshSessions();
            refreshWorkspaces();
          } catch {
            /* 刷新失败不影响清理结果 */
          }
        } catch (error) {
          if (alive.current) setOutcome({ ok: false, text: messageOf(error) });
        } finally {
          if (alive.current) setBusyId(null);
        }
      }, [load, t]);

      const sessions = snapshot.sessions;
      const groups = [];
      for (const session of sessions) {
        const key = session.workspaceKey ?? '';
        let group = groups.find((entry) => entry.key === key);
        if (!group) {
          group = { key, items: [] };
          groups.push(group);
        }
        group.items.push(session);
      }

      const dialog = !open
        ? null
        : h(
            'div',
            { className: 'lc-scrim', role: 'presentation' },
            h(
              'div',
              {
                className: 'lc-dialog',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': t('panel.heading'),
                'data-lc-sessions': '1',
              },
              h(
                'div',
                { className: 'lc-dialogHead' },
                h('span', { className: 'lc-title' }, t('panel.heading')),
                h(
                  'span',
                  { className: 'lc-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'lc-btn', onClick: () => void load(), disabled: snapshot.phase === 'loading' },
                    t('panel.refresh'),
                  ),
                  h('button', { type: 'button', className: 'lc-btn', onClick: () => setOpen(false) }, t('panel.close')),
                ),
              ),
              h(
                'div',
                { className: 'lc-dialogBody' },
                h('p', { className: 'lc-hint' }, t('panel.hint')),
                outcome
                  ? h(
                      'p',
                      { className: `lc-status ${outcome.ok ? 'lc-statusOk' : 'lc-statusError'}`, role: 'status' },
                      outcome.text,
                    )
                  : null,
                snapshot.phase === 'loading' ? h('p', { className: 'lc-status' }, t('panel.loading')) : null,
                snapshot.phase === 'error'
                  ? h('p', { className: 'lc-status lc-statusError' }, t('panel.error', { message: snapshot.message }))
                  : null,
                // 宿主索引里还记着、目录已经不在的会话：导航页会一直显示它们并报 not-found。
                snapshot.phase === 'ready' && (snapshot.orphans ?? []).length > 0
                  ? h(
                      'div',
                      { className: 'lc-orphans' },
                      h('span', { className: 'lc-formHint' }, t('panel.orphans', { n: snapshot.orphans.length })),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'lc-btn lc-danger',
                          disabled: busyId === '__repair__',
                          onClick: () => void repair(),
                          'data-lc-action': 'repair-sessions',
                        },
                        t('panel.repair'),
                      ),
                    )
                  : null,
                snapshot.phase === 'ready' && sessions.length === 0
                  ? h('p', { className: 'lc-status' }, t('panel.empty'))
                  : null,
                groups.map((group) =>
                  h(
                    'div',
                    { key: group.key },
                    h('div', { className: 'lc-groupTitle' }, group.key || t('panel.unknown')),
                    group.items.map((session) => {
                      const active = isActive(session);
                      const pending = pendingId === session.id;
                      const busy = busyId === session.id;
                      const shortId = `session-${String(session.id).slice(0, 8)}`;
                      // 标题来自会话日志里的 `session/title`；没有标题就退回短 id，
                      // 但列表里始终带上短 id，方便和别处（URL、日志）对得上。
                      const label = session.title || shortId;
                      const activeMinutes = Math.max(1, Math.round((snapshot.minIdleMs || 0) / 60000));
                      return h(
                        'div',
                        { key: session.id, className: 'lc-row' },
                        h(
                          'div',
                          { className: 'lc-rowMain' },
                          h('div', { className: 'lc-rowTitle', title: shortId }, label),
                          h(
                            'div',
                            { className: 'lc-rowMeta' },
                            [
                              shortId,
                              t('panel.updated', { time: formatTime(session.updatedAt) }),
                              t('panel.size', { size: formatBytes(session.bytes) }),
                              active ? t('panel.active', { minutes: activeMinutes }) : null,
                            ]
                              .filter(Boolean)
                              .join(' · '),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'lc-rowActions' },
                          pending
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'lc-btn lc-danger',
                                  disabled: busy,
                                  onClick: () => void remove(session),
                                  'data-lc-action': 'confirm-delete',
                                },
                                busy ? t('panel.deleting') : t('panel.confirm'),
                              )
                            : h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'lc-btn lc-danger',
                                  disabled: active || busy,
                                  title: active ? t('panel.active') : t('panel.delete'),
                                  onClick: () => {
                                    setPendingId(session.id);
                                    setOutcome(null);
                                  },
                                  'data-lc-action': 'delete',
                                },
                                t('panel.delete'),
                              ),
                          pending
                            ? h(
                                'button',
                                { type: 'button', className: 'lc-btn', disabled: busy, onClick: () => setPendingId(null) },
                                t('panel.cancel'),
                              )
                            : null,
                        ),
                      );
                    }),
                  ),
                ),
              ),
            ),
          );

      return h(
        'div',
        { className: 'lc-navWrap' },
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'lc-nav',
            onClick: () => setOpen(true),
            title: t('panel.title'),
            'data-lc-action': 'open-sessions',
          },
          h('span', null, t('panel.button')),
        ),
        dialog,
      );
    }

    // ------------------------------------------------------------ 个性化面板

    const EMPTY_DRAFT = {
      assistantName: '',
      userName: '',
      style: 'default',
      instructions: '',
      persona: '',
    };

    /**
     * 用户自有的助手设定：称呼 / 名字 / 风格 / 长期指令 / 人设。
     *
     * 与「记忆」刻意分开：记忆是模型提议、用户确认；这里模型**没有写入口**，
     * 只有这个表单能写，保存后由 Host 原样注入 system prompt。
     */
    function ProfilePanel(props) {
      // `makeText(props)` 每次渲染都是新函数；把它放进 useCallback 的依赖会让
      // `load` 每次渲染都换新身份，而「打开时 load」的 effect 依赖 `load`——
      // 结果就是无限 GET 循环（表现为按钮一直禁用、点了没反应）。
      const textRef = React.useRef(null);
      textRef.current = makeText(props);
      const t = textRef.current;
      const [open, setOpen] = React.useState(false);
      const [draft, setDraft] = React.useState({ ...EMPTY_DRAFT });
      const [phase, setPhase] = React.useState('idle');
      const [savedAt, setSavedAt] = React.useState(0);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const alive = React.useRef(true);

      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = React.useCallback(async () => {
        setPhase('loading');
        try {
          const profile = await request('GET', '/profile');
          if (!alive.current) return;
          setDraft({
            assistantName: profile?.assistantName ?? '',
            userName: profile?.userName ?? '',
            style: profile?.style ?? 'default',
            instructions: profile?.instructions ?? '',
            persona: profile?.persona ?? '',
          });
          setSavedAt(Number(profile?.updatedAt) || 0);
          setPhase('ready');
          setNotice(null);
        } catch (error) {
          if (alive.current) {
            setPhase('error');
            setNotice({ ok: false, text: textRef.current('profile.loadError', { message: messageOf(error) }) });
          }
        }
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        void load();
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [open, load]);

      const save = React.useCallback(async () => {
        setBusy(true);
        setNotice(null);
        try {
          const saved = await request('PUT', '/profile', draft);
          if (!alive.current) return;
          setSavedAt(Number(saved?.updatedAt) || Date.now());
          setNotice({ ok: true, text: textRef.current('profile.saved') });
          setPhase('ready');
        } catch (error) {
          if (alive.current) setNotice({ ok: false, text: textRef.current('profile.error', { message: messageOf(error) }) });
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [draft]);

      const edit = (key) => (event) => {
        const value = event && event.target ? event.target.value : '';
        setDraft((prev) => ({ ...prev, [key]: value }));
      };

      const field = (key, label, hint, kind) =>
        h(
          'label',
          { className: 'lc-field' },
          h('span', { className: 'lc-label' }, label),
          kind === 'textarea'
            ? h('textarea', {
                className: 'lc-textarea',
                value: draft[key] ?? '',
                placeholder: hint ?? '',
                onChange: edit(key),
                'data-lc-field': key,
              })
            : h('input', {
                className: 'lc-input',
                type: 'text',
                value: draft[key] ?? '',
                placeholder: hint ?? '',
                onChange: edit(key),
                'data-lc-field': key,
              }),
        );

      const dialog = !open
        ? null
        : h(
            'div',
            { className: 'lc-scrim', role: 'presentation' },
            h(
              'div',
              {
                className: 'lc-dialog',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': t('profile.title'),
                'data-lc-profile': '1',
              },
              h(
                'div',
                { className: 'lc-dialogHead' },
                h('span', { className: 'lc-title' }, t('profile.title')),
                h(
                  'span',
                  { className: 'lc-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'lc-btn', onClick: () => void load(), disabled: busy || phase === 'loading' },
                    t('profile.reload'),
                  ),
                  h('button', { type: 'button', className: 'lc-btn', onClick: () => setOpen(false) }, t('panel.close')),
                ),
              ),
              h(
                'div',
                { className: 'lc-dialogBody' },
                h('p', { className: 'lc-hint' }, t('profile.hint')),
                notice
                  ? h(
                      'p',
                      { className: `lc-status ${notice.ok ? 'lc-statusOk' : 'lc-statusError'}`, role: 'status' },
                      notice.text,
                    )
                  : null,
                h(
                  'div',
                  { className: 'lc-form' },
                  field('userName', t('profile.userName')),
                  field('assistantName', t('profile.assistantName')),
                  h(
                    'label',
                    { className: 'lc-field' },
                    h('span', { className: 'lc-label' }, t('profile.style')),
                    h(
                      'select',
                      { className: 'lc-select', value: draft.style, onChange: edit('style'), 'data-lc-field': 'style' },
                      ['default', 'concise', 'detailed'].map((id) =>
                        h('option', { key: id, value: id }, t(`profile.style.${id}`)),
                      ),
                    ),
                  ),
                  field('instructions', t('profile.instructions'), t('profile.instructionsHint'), 'textarea'),
                  field('persona', t('profile.persona'), t('profile.personaHint'), 'textarea'),
                  h(
                    'div',
                    { className: 'lc-formActions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'lc-btn lc-primary',
                        onClick: () => void save(),
                        disabled: busy || phase === 'loading',
                        'data-lc-action': 'save-profile',
                      },
                      busy ? t('profile.saving') : t('profile.save'),
                    ),
                    savedAt
                      ? h('span', { className: 'lc-formHint' }, t('profile.savedAt', { time: formatTime(savedAt) }))
                      : null,
                  ),
                ),
              ),
            ),
          );

      return h(
        'div',
        { className: 'lc-navWrap' },
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'lc-nav',
            onClick: () => setOpen(true),
            title: t('profile.title'),
            'data-lc-action': 'open-profile',
          },
          h('span', null, t('profile.button')),
        ),
        dialog,
      );
    }

    // ------------------------------------------------------------ 记忆面板

    /**
     * 记忆面板 v2：按“共享 + 每个工作区一组”的折叠列表管理。
     *
     * 数据来自 `GET /memory`：工作区列表由宿主的 workspaceRegistry 提供，
     * 新建项目被宿主登记后，这里会自动多出一组——不需要用户手动“创建记忆”。
     *
     * 三条写入路径都在这里收口：
     *   1. 用户加条目（归属 = 所在组）；
     *   2. 用户改整段工作区文档（保存 / 归档）；
     *   3. 模型提议的条目（`lifecycle_memory_propose` 排队）→ 用户接受或拒绝才落库。
     */
    function MemoryPanel(props) {
      const textRef = React.useRef(null);
      textRef.current = makeText(props);
      const t = textRef.current;
      const [open, setOpen] = React.useState(false);
      const [data, setData] = React.useState(null);
      const [phase, setPhase] = React.useState('idle');
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [expanded, setExpanded] = React.useState({ shared: true });
      const [composers, setComposers] = React.useState({});
      const [pendingId, setPendingId] = React.useState(null);
      const alive = React.useRef(true);

      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = React.useCallback(async () => {
        setPhase('loading');
        try {
          const result = await request('GET', '/memory');
          if (!alive.current) return;
          setData(result);
          setPhase('ready');
        } catch (error) {
          if (alive.current) {
            setPhase('error');
            setNotice({ ok: false, text: textRef.current('memory.error', { message: messageOf(error) }) });
          }
        }
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        void load();
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [open, load]);

      const act = React.useCallback(
        async (work, okText) => {
          setBusy(true);
          setNotice(null);
          try {
            const message = await work();
            if (alive.current) setNotice({ ok: true, text: okText ?? message ?? textRef.current('memory.saved') });
            await load();
          } catch (error) {
            if (alive.current) {
              setNotice({ ok: false, text: textRef.current('memory.error', { message: messageOf(error) }) });
            }
          } finally {
            if (alive.current) setBusy(false);
          }
        },
        [load],
      );

      const toggle = (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

      const setComposer = (id, value) => setComposers((prev) => ({ ...prev, [id]: value }));

      const addEntry = (groupId, scope) =>
        act(async () => {
          const text = String(composers[groupId] ?? '').trim();
          if (!text) throw new Error('内容不能为空');
          await request('POST', '/memory/entry', scope === 'shared' ? { scope, text } : { scope, workspaceId: groupId, text });
          if (alive.current) setComposer(groupId, '');
        });

      const removeEntry = (id) =>
        act(async () => {
          await request('POST', '/memory/entry/remove', { id, confirm: true });
          if (alive.current) setPendingId(null);
        });

      const acceptProposal = (item) =>
        act(async () => {
          await request('POST', '/memory/pending/accept', { id: item.id });
        }, t('memory.accepted'));

      const rejectProposal = (item) =>
        act(async () => {
          await request('POST', '/memory/pending/reject', { id: item.id });
        }, t('memory.rejected'));

      const authorLabel = (author) => {
        if (author === 'user') return t('memory.author.user');
        if (author === 'promoted') return t('memory.author.promoted');
        return t('memory.author.model');
      };

      const entryRow = (entry) => {
        const pending = pendingId === entry.id;
        const meta = [
          authorLabel(entry.author),
          t('memory.updated', { time: formatTime(entry.updatedAt) }),
          entry.conflict ? t('memory.conflict') : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return h(
          'div',
          { className: 'lc-entry', key: entry.id },
          h(
            'div',
            { className: 'lc-rowMain' },
            h('div', { className: 'lc-entryText' }, entry.text),
            h('div', { className: 'lc-entryMeta' }, meta),
          ),
          h(
            'div',
            { className: 'lc-rowActions' },
            pending
              ? h(
                  'button',
                  { type: 'button', className: 'lc-btn lc-danger', disabled: busy, onClick: () => void removeEntry(entry.id) },
                  t('memory.confirmDelete'),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'lc-btn lc-danger',
                    disabled: busy,
                    onClick: () => {
                      setPendingId(entry.id);
                      setNotice(null);
                    },
                  },
                  t('memory.delete'),
                ),
            pending
              ? h('button', { type: 'button', className: 'lc-btn', disabled: busy, onClick: () => setPendingId(null) }, t('memory.cancel'))
              : null,
          ),
        );
      };

      const proposalRow = (item) => {
        const meta = [
          item.scope === 'shared' ? t('memory.tab.shared') : t('memory.tab.workspace'),
          item.reason ? t('memory.reason', { reason: item.reason }) : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return h(
          'div',
          { className: 'lc-entry lc-proposal', key: `pending-${item.id}` },
          h(
            'div',
            { className: 'lc-rowMain' },
            h('div', { className: 'lc-entryText' }, item.text),
            h('div', { className: 'lc-entryMeta' }, meta),
          ),
          h(
            'div',
            { className: 'lc-rowActions' },
            h(
              'button',
              { type: 'button', className: 'lc-btn lc-primary', disabled: busy, onClick: () => void acceptProposal(item) },
              t('memory.accept'),
            ),
            h('button', { type: 'button', className: 'lc-btn', disabled: busy, onClick: () => void rejectProposal(item) }, t('memory.reject')),
          ),
        );
      };

      const composer = (groupId, scope) =>
        h(
          'div',
          { className: 'lc-add' },
          h('textarea', {
            className: 'lc-textarea',
            value: composers[groupId] ?? '',
            placeholder: t('memory.addPlaceholder'),
            onChange: (event) => setComposer(groupId, event && event.target ? event.target.value : ''),
            'data-lc-field': `memory-entry-${groupId}`,
            style: { minHeight: '48px' },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'lc-btn',
              disabled: busy || String(composers[groupId] ?? '').trim() === '',
              onClick: () => void addEntry(groupId, scope),
            },
            t('memory.add'),
          ),
        );

      const groupHead = (key, label, counts, isCurrent, tooltip) =>
        h(
          'button',
          {
            type: 'button',
            className: 'lc-groupHead',
            onClick: () => toggle(key),
            'aria-expanded': expanded[key] === true ? 'true' : 'false',
            'data-lc-group': key,
            // 悬停显示完整路径：显示名可能被截断或被同名目录加过后缀。
            title: tooltip ?? label,
          },
          h('span', { className: 'lc-caret' }, expanded[key] ? '▾' : '▸'),
          h('span', { className: 'lc-groupLabel' }, label),
          isCurrent ? h('span', { className: 'lc-badge' }, t('memory.current')) : null,
          counts.pending > 0 ? h('span', { className: 'lc-badge lc-badgeWarn' }, t('memory.pending', { n: counts.pending })) : null,
          h('span', { className: 'lc-groupMeta' }, t('memory.group_entries', { n: counts.entries })),
        );

      const sharedPending = data?.shared?.pending ?? [];
      const sharedEntries = data?.shared?.entries ?? [];

      const sharedBlock = h(
        'div',
        { className: 'lc-group', key: 'shared' },
        groupHead('shared', t('memory.sharedTitle'), { entries: sharedEntries.length, pending: sharedPending.length }, false),
        expanded.shared
          ? h(
              'div',
              { className: 'lc-groupBody' },
              composer('shared', 'shared'),
              sharedPending.length > 0
                ? h('div', null, h('div', { className: 'lc-groupTitle' }, t('memory.proposed')), sharedPending.map(proposalRow))
                : null,
              sharedEntries.length === 0 ? h('p', { className: 'lc-status' }, t('memory.sharedEmpty')) : sharedEntries.map(entryRow),
            )
          : null,
      );

      const workspaceBlocks = (data?.workspaces ?? []).map((group) => {
        const isCurrent = String(group.id) === String(data?.workspaceId ?? '');
        const open = expanded[group.id] === true;
        return h(
          'div',
          { className: 'lc-group', key: group.id },
          groupHead(group.id, group.label || group.id, { entries: group.entries.length, pending: group.pending.length }, isCurrent, group.title ? `${group.label} — ${group.id}` : group.id),
          open
            ? h(
                'div',
                { className: 'lc-groupBody' },
                // 这里刻意**没有**“整段 Markdown 文档”编辑器：那份文档不参与
                // prompt 注入，写进去也读不到，和下面的条目是同一件事的两份拷贝。
                // 工作区记忆只有条目一条路（D28）。
                composer(group.id, 'workspace'),
                group.pending.length > 0
                  ? h('div', null, h('div', { className: 'lc-groupTitle' }, t('memory.proposed')), group.pending.map(proposalRow))
                  : null,
                group.entries.length === 0
                  ? h('p', { className: 'lc-status' }, t('memory.workspaceEmpty'))
                  : group.entries.map(entryRow),
              )
            : null,
        );
      });

      const dialog = !open
        ? null
        : h(
            'div',
            { className: 'lc-scrim', role: 'presentation' },
            h(
              'div',
              {
                className: 'lc-dialog',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': t('memory.title'),
                'data-lc-memory': '1',
              },
              h(
                'div',
                { className: 'lc-dialogHead' },
                h('span', { className: 'lc-title' }, t('memory.title')),
                data && data.pendingCount > 0
                  ? h('span', { className: 'lc-badge lc-badgeWarn' }, t('memory.pending', { n: data.pendingCount }))
                  : null,
                h(
                  'span',
                  { className: 'lc-actions' },
                  h('button', { type: 'button', className: 'lc-btn', onClick: () => void load(), disabled: busy || phase === 'loading' }, t('panel.refresh')),
                  h('button', { type: 'button', className: 'lc-btn', onClick: () => setOpen(false) }, t('panel.close')),
                ),
              ),
              h(
                'div',
                { className: 'lc-dialogBody' },
                h('p', { className: 'lc-hint' }, t('memory.hint')),
                data
                  ? h('p', { className: 'lc-formHint' }, t('memory.budget', { shared: data.budget?.sharedBytes ?? 0, workspace: data.budget?.workspaceBytes ?? 0 }))
                  : null,
                notice ? h('p', { className: `lc-status ${notice.ok ? 'lc-statusOk' : 'lc-statusError'}`, role: 'status' }, notice.text) : null,
                phase === 'loading' ? h('p', { className: 'lc-status' }, t('panel.loading')) : null,
                phase === 'ready' ? h('div', null, sharedBlock, workspaceBlocks) : null,
              ),
            ),
          );

      return h(
        'div',
        { className: 'lc-navWrap' },
        h('style', null, CSS),
        h(
          'button',
          { type: 'button', className: 'lc-nav', onClick: () => setOpen(true), title: t('memory.title'), 'data-lc-action': 'open-memory' },
          h('span', null, t('memory.button')),
        ),
        dialog,
      );
    }

    // ------------------------------------------------------------ 插件接线

    function apply(ctx) {
      if (ctx && ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'lifecycle-cache: dictionaries');
      }
      if (!ctx) return;

      // 会话/工作区刷新是可选能力：服务不在就降级成空函数，不能让插件激活失败。
      if (typeof ctx.inject === 'function') {
        ctx.inject(['sessions'], (scoped) => {
          refreshSessions = () => {
            try {
              void scoped.sessions?.refresh?.();
            } catch {
              /* 刷新失败不影响删除结果 */
            }
          };
        });
        ctx.inject(['workspaces'], (scoped) => {
          refreshWorkspaces = () => {
            try {
              void scoped.workspaces?.refresh?.();
            } catch {
              /* 同上 */
            }
          };
        });
      }

      if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;

      // 插件页的“本包配置”区（key = 包名）。这个 slot 只以 `view: 'page'` 渲染。
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            id: 'lifecycle-cache-config',
            key: PACKAGE,
            order: 10,
            locale: NS,
          },
          StatusCard,
        ),
      );

      // 侧栏页脚：两个入口。位置与设置项同区，宽度由宿主给（props.wide）。
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'lifecycle-cache-sessions',
            order: 40,
            locale: NS,
          },
          SessionPanel,
        ),
      );

      // 个性化：用户自己写称呼 / 名字 / 风格 / 指令 / 人设，模型没有写入口。
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'lifecycle-cache-profile',
            order: 41,
            locale: NS,
          },
          ProfilePanel,
        ),
      );

      // 记忆：共享 / 本工作区两层。用户的写入路径与模型的 propose 是两条独立入口。
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'lifecycle-cache-memory',
            order: 42,
            locale: NS,
          },
          MemoryPanel,
        ),
      );
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
