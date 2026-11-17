export {
  LeaseRegistry,
  validateEngineRef,
  planLegacyMigration,
} from './engine-lease.js';

export {
  EngineProbe,
  PROBE_STATE,
  classify,
  readOnlyTransport,
} from './engine-probe.js';

export { decide, VERDICT, OWNERSHIP_REASON } from './ownership.js';

export { WorkspaceRegistry } from './workspace-registry.js';
export { WorkspaceMemoryStore, safeWorkspaceKey } from './workspace-memory.js';
export { findOrphanWorkspaces } from './orphan-scan.js';

export {
  cleanAndVerify,
  makeSampler,
  CLEAN_LEVELS,
  CLEAN_STATUS,
  SAMPLER_KIND,
} from './vram-cleaner.js';
