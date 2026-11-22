/**
 * dsh-lifecycle-cache-cleaner —— Client 半边。
 *
 * 只做一件小事：在插件页（Plugins → 本插件）画一行状态 + 一个「释放引擎」按钮。
 *
 * 两条硬约束：
 *   1. 不在浏览器里重算闸门。状态来自 `/lifecycle-cache/api/status`，就是
 *      Host `runtime.status()` 的原样投影；按钮也只是把 `confirm: true` 交给
 *      `runtime.clean()`，判定仍然只有 `lib/core/release-gate.js` 一份。
 *   2. 不 import 任何宿主 Client 包。React 走模块表，样式用 `--dsw-alias-*`
 *      主题变量自己写，slot 通过 `ctx.slots` 注入。
 *
 * 不提供删除会话入口：删除是宿主/会话管理器的事，本包只观察。
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
        const error = new Error((payload && payload.error) || `HTTP ${response.status}`);
        error.code = (payload && payload.code) || `http_${response.status}`;
        throw error;
      }
      return payload.result;
    }

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

    function apply(ctx) {
      if (ctx && ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'lifecycle-cache: dictionaries');
      }
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;
      // 注册在插件页的“本包配置”区（`plugins.bundle.config`，key 是包名）。
      // 这个 slot 只以 `view: 'page'` 渲染，正好是状态行 + 按钮需要的位置。
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
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
