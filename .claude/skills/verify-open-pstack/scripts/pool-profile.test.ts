import { expect, test } from 'bun:test';
import { validatePoolBinding } from './pool-profile.ts';

export const syntheticPoolEnvironment = () => [
  { name: 'CLIPROXY_CLAUDE_ROUTE', value: 'shared-pool', sensitive: false },
  { name: 'CLIPROXY_ACCOUNT_PREFIX', value: '', sensitive: false },
  { name: 'CLIPROXY_BASE_URL', value: 'https://pool.example.invalid', sensitive: false },
  { name: 'CLIPROXY_CLAUDE_BINARY', value: '/fixture/real-claude', sensitive: false },
  { name: 'ANTHROPIC_API_KEY', value: '', sensitive: true, secret: { provider: 'fixture', reference: 'op://fixture/pool/key' } },
  { name: 'ANTHROPIC_AUTH_TOKEN', value: '', sensitive: false },
  { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: '', sensitive: false },
  { name: 'DO_NOT_TRACK', value: '1', sensitive: false },
];
test('pool profiles bind identical unresolved references and routing metadata regardless of entry order', () => {
  const daily = syntheticPoolEnvironment();
  expect(validatePoolBinding(daily, [...daily].reverse())).toBe('/fixture/real-claude');
});
for (const [name, edit] of [
  ['redacted local secret without an explicit reference', (v: ReturnType<typeof syntheticPoolEnvironment>) => { delete v[4]!.secret; }],
  ['plaintext API key', (v: ReturnType<typeof syntheticPoolEnvironment>) => { v[4]!.value = 'synthetic-value-never-a-real-key'; }],
  ['different secret reference', (v: ReturnType<typeof syntheticPoolEnvironment>) => { v[4]!.secret!.reference = 'op://fixture/other/key'; }],
  ['different host', (v: ReturnType<typeof syntheticPoolEnvironment>) => { v[2]!.value = 'https://fallback.example.invalid'; }],
  ['named account', (v: ReturnType<typeof syntheticPoolEnvironment>) => { v[1]!.value = 'named'; }],
  ['unknown environment', (v: ReturnType<typeof syntheticPoolEnvironment>) => { v.push({ name: 'EXTRA', value: 'x', sensitive: false }); }],
  ['OAuth material', (v: ReturnType<typeof syntheticPoolEnvironment>) => { v[6]!.value = 'synthetic-token'; }],
  ['direct route', (v: ReturnType<typeof syntheticPoolEnvironment>) => { v[0]!.value = 'direct'; }],
  ['duplicate entry', (v: ReturnType<typeof syntheticPoolEnvironment>) => { v.push(v[0]!); }],
  ['relative real binary', (v: ReturnType<typeof syntheticPoolEnvironment>) => { v[3]!.value = 'claude'; }],
  ['credential-bearing origin', (v: ReturnType<typeof syntheticPoolEnvironment>) => { v[2]!.value = 'https://fixture:synthetic@pool.example.invalid'; }],
] as const) test(`pool binding refuses ${name} without exposing values`, () => {
  const daily = syntheticPoolEnvironment(), verification = syntheticPoolEnvironment(); edit(verification);
  expect(() => validatePoolBinding(daily, verification)).toThrow('pool-verification-unprepared');
  try { validatePoolBinding(daily, verification); } catch (error) { expect(String(error)).not.toContain('op://'); expect(String(error)).not.toContain('synthetic-token'); }
});
