import { isAbsolute } from 'node:path';

export interface PoolPolicy { primary: string; direct: string; fallback: string }
interface SecretReference { provider: string; reference: string }
type PoolVariable = { name: string; value: string } | { name: 'ANTHROPIC_API_KEY'; secret: SecretReference };
const PUBLIC_NAMES = new Set(['CLIPROXY_CLAUDE_ROUTE', 'CLIPROXY_ACCOUNT_PREFIX', 'CLIPROXY_BASE_URL', 'CLIPROXY_CLAUDE_BINARY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'DO_NOT_TRACK']);
const BLOCKER = 'pool-verification-unprepared: provision a dedicated T3 Claude Agent verification instance with the same explicit secret reference and public pool environment as the selected daily pool; T3-local redacted per-instance secrets cannot prove a shared credential binding. Never read or copy credentials';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(BLOCKER);
  return value as Record<string, unknown>;
}
function profile(value: unknown): PoolVariable[] {
  if (!Array.isArray(value)) throw new Error(BLOCKER);
  const variables = value.map((raw): PoolVariable => {
    const entry = object(raw);
    if (entry.name === 'ANTHROPIC_API_KEY') {
      const secret = object(entry.secret);
      if (entry.value !== '' || entry.sensitive !== true || typeof secret.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(secret.provider)
        || typeof secret.reference !== 'string' || !secret.reference.trim() || secret.reference.length > 1024 || /[\r\n]/.test(secret.reference)) throw new Error(BLOCKER);
      return { name: 'ANTHROPIC_API_KEY', secret: { provider: secret.provider, reference: secret.reference } };
    }
    if (typeof entry.name !== 'string' || !PUBLIC_NAMES.has(entry.name) || entry.sensitive !== false || entry.secret !== undefined || entry.valueRedacted === true || typeof entry.value !== 'string') throw new Error(BLOCKER);
    return { name: entry.name, value: entry.value };
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(variables.map(v => v.name)).size !== variables.length || variables.length !== PUBLIC_NAMES.size + 1) throw new Error(BLOCKER);
  const valueOf = (name: string) => { const v = variables.find(v => v.name === name); return v && 'value' in v ? v.value : undefined; };
  if (valueOf('CLIPROXY_CLAUDE_ROUTE') !== 'shared-pool' || valueOf('CLIPROXY_ACCOUNT_PREFIX') !== '' || valueOf('DO_NOT_TRACK') !== '1'
    || valueOf('ANTHROPIC_AUTH_TOKEN') !== '' || valueOf('CLAUDE_CODE_OAUTH_TOKEN') !== '' || !isAbsolute(valueOf('CLIPROXY_CLAUDE_BINARY') ?? '')) throw new Error(BLOCKER);
  let origin: URL;
  try { origin = new URL(valueOf('CLIPROXY_BASE_URL')!); } catch { throw new Error(BLOCKER); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error(BLOCKER);
  return variables;
}

/** Compare only routing metadata and unresolved references. T3 alone resolves and injects the secret. */
export function validatePoolBinding(daily: unknown, verification: unknown): string {
  const left = profile(daily);
  if (JSON.stringify(left) !== JSON.stringify(profile(verification))) throw new Error(BLOCKER);
  const binary = left.find(v => v.name === 'CLIPROXY_CLAUDE_BINARY');
  if (!binary || !('value' in binary)) throw new Error(BLOCKER);
  return binary.value;
}
