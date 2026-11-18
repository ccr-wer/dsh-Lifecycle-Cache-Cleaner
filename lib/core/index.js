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

export { decide, VERDICT, OWNERSHIP_REASON, canonicalPath, makeCanonicalizer } from './ownership.js';

export { WorkspaceRegistry } from './workspace-registry.js';
export { WorkspaceMemoryStore, safeWorkspaceKey } from './workspace-memory.js';
export { findOrphanWorkspaces } from './orphan-scan.js';

export { GATE_CODE, probeAdapter, evaluateGate } from './release-gate.js';

export {
  cleanAndVerify,
  makeSampler,
  pickSamplerKind,
  CLEAN_LEVELS,
  CLEAN_STATUS,
  SAMPLER_KIND,
} from './vram-cleaner.js';

export { renameWithRetry, writeFileAtomic, RETRYABLE_RENAME } from './atomic.js';
