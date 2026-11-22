/**
 * DSH 插件入口（Host 侧）。
 *
 * 宿主规范（`dsh-doc/references/host-plugin.md`）：
 * bundle 的 `package.json` 声明 `dsh.bundle.patch`，patch 里 insert 本包名，
 * 宿主据此加载本模块，期望导出 `apply(ctx, config)` 或一个 service class。
 *
 * 当前边界（DECISIONS.md 的 T10）：
 * `adapters/dsh.js` 的宿主 API 尚未接入，`probeEngine()` 未实现，
 * 清理闸门因此恒定返回 `skip_unknown`。
 * 也就是说：装上本插件**不会清理任何东西**，只完成"可安装"这一步。
 * 在 `apply` 里注册钩子之前，必须先确认宿主真实的会话/压缩/引擎挂载点，
 * 不靠猜测填写。
 */
export function apply(_ctx, _config) {
  console.info(
    '[lifecycle-cache-cleaner] 插件已加载。引擎探测尚未接入宿主 API（T10），' +
      '所有清理路径将返回 skip_unknown，不执行任何释放动作。',
  );
}

/** 库接口保持不变：入口从 `cleaner.js` 迁到本文件后仍可从这里导入。 */
export { LifecycleCacheCleaner, DEFAULTS } from './cleaner.js';
export * from './lib/core/index.js';
