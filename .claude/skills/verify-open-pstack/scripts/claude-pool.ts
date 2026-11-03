import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface ClaudePoolRoute {
  providerInstanceId: string;
  route: 'shared-pool';
  origin: string;
  launcher: string;
  cliBinary: string;
}

const names = new Set(['CLIPROXY_CLAUDE_ROUTE', 'CLIPROXY_ACCOUNT_PREFIX', 'CLIPROXY_BASE_URL',
  'CLIPROXY_CLAUDE_BINARY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'DO_NOT_TRACK']);
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (): never => { throw new Error('Claude pool requires matching shared-pool configuration and a provisioned T3-managed redacted client key; no credential values may be supplied to the verifier'); };

export function assertPoolCaseEnvironment(env: Record<string, string>): void {
  if (Object.keys(env).some(name => name.startsWith('CLIPROXY_') || name.startsWith('ANTHROPIC_') || name === 'CLAUDE_CODE_OAUTH_TOKEN')) {
    throw new Error('Claude pool routing and authentication environment must come from T3, not the case');
  }
}

function environment(value: unknown): { origin: string; cliBinary: string } {
  if (!Array.isArray(value) || value.length !== names.size) return invalid();
  const seen = new Set<string>(), values = new Map<string, string>();
  for (const row of value) {
    if (!object(row) || typeof row.name !== 'string' || !names.has(row.name) || seen.has(row.name)) return invalid();
    seen.add(row.name);
    if (row.name === 'ANTHROPIC_API_KEY') {
      if (row.sensitive !== true || row.valueRedacted !== true || row.value !== '') return invalid();
    } else {
      if (row.sensitive !== false || row.valueRedacted === true || typeof row.value !== 'string') return invalid();
      values.set(row.name, row.value);
    }
  }
  if (values.get('CLIPROXY_CLAUDE_ROUTE') !== 'shared-pool' || values.get('CLIPROXY_ACCOUNT_PREFIX') !== ''
    || values.get('ANTHROPIC_AUTH_TOKEN') !== '' || values.get('CLAUDE_CODE_OAUTH_TOKEN') !== '' || values.get('DO_NOT_TRACK') !== '1') return invalid();
  const origin = values.get('CLIPROXY_BASE_URL'), cliBinary = values.get('CLIPROXY_CLAUDE_BINARY');
  if (!origin || !cliBinary || !isAbsolute(cliBinary)) return invalid();
  let url: URL;
  try { url = new URL(origin); } catch { return invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin !== origin) return invalid();
  return { origin, cliBinary };
}

export async function resolveClaudePool({ providerInstanceId, source, verification, cliBinary }: {
  providerInstanceId: string; source: unknown; verification: unknown; cliBinary: string;
}): Promise<ClaudePoolRoute> {
  if (!object(source) || source.driver !== 'claudeAgent' || source.enabled !== true || !object(source.config)
    || typeof source.config.binaryPath !== 'string' || !isAbsolute(source.config.binaryPath) || source.config.launchArgs
    || !object(verification) || verification.driver !== 'claudeAgent' || verification.enabled !== true) return invalid();
  const pool = environment(source.environment), instance = environment(verification.environment);
  if (pool.origin !== instance.origin) return invalid();
  const [direct, sourceBinary, verificationBinary, launcher] = await Promise.all([
    realpath(cliBinary), realpath(pool.cliBinary), realpath(instance.cliBinary), realpath(source.config.binaryPath),
  ]).catch(invalid);
  if (direct !== sourceBinary || direct !== verificationBinary) return invalid();
  return { providerInstanceId, route: 'shared-pool', origin: pool.origin, launcher, cliBinary: direct };
}
