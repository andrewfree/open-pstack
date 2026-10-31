import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeEvidence, type ClaudeEvidenceOptions } from './claude-evidence.ts';

const roots: string[] = [];
const sessionId = 'native-candidate-session';
const hookContext = '<EXTREMELY_IMPORTANT>\nYou have pstack.\n</EXTREMELY_IMPORTANT>\n';
const hookCommand = '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start';
const body = '# Candidate skill\n\nVerify the actual result.\n';
const source = `---\nname: principle-prove-it-works\ndescription: Fixture\n---\n\n${body}`;
type Event = Record<string, any>;
const event = (fields: Event): Event => ({ session_id: sessionId, ...fields });
const use = (id: string, name: string, input: Event): Event => event({ type: 'assistant', parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: string, metadata: Event, isError?: boolean): Event => event({ type: 'user', parent_tool_use_id: null,
  tool_use_result: metadata, message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }] } });
const injection = (path: string, text = body): Event => event({ type: 'user', parent_tool_use_id: null, isSynthetic: true,
  message: { content: [{ type: 'text', text: `Base directory for this skill: ${path}\n\n${text}` }] } });
const serialize = (events: Event[]): string => events.map(event => JSON.stringify(event)).join('\n') + '\n';
const nativeAgent = (subagentType = 'general-purpose'): Event[] => [
  use('agent-call', 'Agent', { subagent_type: subagentType, model: 'haiku', prompt: 'Reply PONG', run_in_background: false }),
  event({ type: 'user', parent_tool_use_id: 'agent-call', agent_id: 'native-agent-id', message: { role: 'user', content: 'Reply PONG' } }),
  result('agent-call', 'A framed subagent hand-back.', { status: 'completed', agentType: subagentType, agentId: 'native-agent-id', resolvedModel: 'claude-haiku-5-5', content: [{ type: 'text', text: 'PONG' }] }),
];
const backgroundAgent = (subagentType = 'general-purpose'): Event[] => [
  use('agent-call', 'Agent', { subagent_type: subagentType, model: 'haiku', prompt: 'Reply PONG', run_in_background: true }),
  event({ type: 'system', subtype: 'task_started', task_id: 'native-agent-id', run_id: 'native-run-id', tool_use_id: 'agent-call',
    task_type: 'local_agent', subagent_type: subagentType, is_backgrounded: true }),
  result('agent-call', 'Async agent launched. This text is not completion proof.', { isAsync: true, status: 'async_launched', agentId: 'native-agent-id', resolvedModel: 'claude-haiku-5-5' }),
  event({ type: 'system', subtype: 'task_updated', task_id: 'native-agent-id', run_id: 'native-run-id', patch: { status: 'completed' } }),
  event({ type: 'system', subtype: 'task_notification', task_id: 'native-agent-id', run_id: 'native-run-id', tool_use_id: 'agent-call', status: 'completed', summary: 'PONG' }),
];
const agentSource = '---\nname: pstack-haiku-max\nmodel: haiku\neffort: max\nbackground: true\n---\n\nRun the assigned task.\n';

async function fixture(): Promise<{ expected: ClaudeEvidenceOptions; events: Event[]; directory: string; project: string }> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'pstack-claude-evidence-'))); roots.push(workspace);
  const pluginRoot = join(workspace, 'plugins/pstack'), directory = join(pluginRoot, 'skills/principle-prove-it-works');
  const project = join(workspace, '.claude/skills/verify-open-pstack');
  for (const path of [directory, project]) { await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), source); }
  await mkdir(join(pluginRoot, 'hooks'));
  await writeFile(join(pluginRoot, 'hooks/hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup|clear|compact', hooks: [{ type: 'command', command: hookCommand, async: false }] }] } }));
  await writeFile(join(pluginRoot, 'hooks/session-start-context.md'), hookContext);
  await mkdir(join(pluginRoot, 'agents')); await writeFile(join(pluginRoot, 'agents/pstack-haiku-max.md'), agentSource);
  return { expected: { pluginRoot, workspace, started: 1, sessionId }, directory, project, events: [
    event({ type: 'system', subtype: 'hook_started', hook_id: 'startup-hook', hook_name: 'SessionStart:startup', hook_event: 'SessionStart' }),
    event({ type: 'system', subtype: 'hook_response', hook_id: 'startup-hook', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', output: hookContext, stdout: hookContext, stderr: '', exit_code: 0, outcome: 'success' }),
    event({ type: 'system', subtype: 'init', claude_code_version: '2.1.299', agents: ['general-purpose', 'pstack:pstack-haiku-max'], mcp_servers: [{ name: 't3-code', source: 'dynamic', status: 'connected' }], cwd: '/operator/inherited-workspace', analytics_disabled: true, plugins: [
      { name: 'pstack', path: pluginRoot, source: 'pstack@inline' },
      { name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' },
    ] }),
    use('skill', 'Skill', { skill: 'pstack:principle-prove-it-works' }),
    result('skill', 'Launching skill: pstack:principle-prove-it-works', { success: true, commandName: 'pstack:principle-prove-it-works' }),
    injection(directory),
    use('shell', 'Bash', { command: 'pwd' }),
    result('shell', '/operator/inherited-workspace', { stdout: '/operator/inherited-workspace', stderr: '', interrupted: false }, false),
    event({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed' }),
    event({ type: 'command_lifecycle', state: 'completed' }),
  ] };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('Claude native candidate evidence', () => {
  test('binds background candidate Agent launch to its native completion notification', async () => {
    const { expected, events } = await fixture(); events.splice(8, 0, ...backgroundAgent('pstack:pstack-haiku-max'));
    const observed = (await parseClaudeEvidence(serialize(events), expected)).session.nativeAgents![0]!;
    expect(observed).toMatchObject({ subagentType: 'pstack:pstack-haiku-max', model: 'claude-haiku-5-5', completed: true, output: 'PONG', declaredEffort: 'max' });
    expect(observed.definitionPath).toBe(join(expected.pluginRoot, 'agents/pstack-haiku-max.md'));
    expect(observed.definitionHash).toMatch(/^[a-f0-9]{64}$/); expect(observed).not.toHaveProperty('effort');
  });
  test.each(['missing', 'failed', 'assistant-report', 'user-notification'])('does not complete background Agent from %s notification', async kind => {
    const { expected, events } = await fixture(), agent = backgroundAgent();
    if (kind === 'failed') agent[4]!.status = 'failed';
    else {
      agent.pop();
      if (kind === 'assistant-report') agent.push(event({ type: 'assistant', message: { content: [{ type: 'text', text: 'Background agent completed: PONG' }] } }));
      if (kind === 'user-notification') agent.push(event({ type: 'user', message: { content: [{ type: 'text', text: '<task-notification><status>completed</status><summary>PONG</summary></task-notification>' }] } }));
    }
    events.splice(8, 0, ...agent);
    expect((await parseClaudeEvidence(serialize(events), expected)).session.nativeAgents![0]!.completed).toBe(false);
  });
  test.each(['missing-start', 'wrong-start-type', 'wrong-start-tool', 'wrong-start-task', 'wrong-run', 'wrong-tool', 'wrong-task', 'missing-tool', 'duplicate', 'early', 'late', 'missing-model', 'error-launch', 'missing-summary'])('rejects %s background Agent evidence', async kind => {
    const { expected, events } = await fixture(), agent = backgroundAgent();
    if (kind === 'missing-start') agent.splice(1, 1);
    if (kind === 'wrong-start-type') agent[1]!.subagent_type = 'another-agent';
    if (kind === 'wrong-start-tool') agent[1]!.tool_use_id = 'another-tool';
    if (kind === 'wrong-start-task') agent[1]!.task_id = 'another-task';
    if (kind === 'wrong-run') agent[4]!.run_id = 'another-run';
    if (kind === 'wrong-tool') agent[4]!.tool_use_id = 'another-tool';
    if (kind === 'wrong-task') agent[4]!.task_id = 'another-task';
    if (kind === 'missing-tool') delete agent[4]!.tool_use_id;
    if (kind === 'duplicate') agent.push({ ...agent[4] });
    if (kind === 'early') agent.splice(2, 0, agent.pop()!);
    if (kind === 'late') events.splice(9, 0, agent.pop()!);
    if (kind === 'missing-model') delete agent[2]!.tool_use_result.resolvedModel;
    if (kind === 'error-launch') agent[2]!.message.content[0].is_error = true;
    if (kind === 'missing-summary') delete agent[4]!.summary;
    events.splice(8, 0, ...agent);
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow();
  });
  test.each(['before', 'after'])('rejects an Agent id reused by a shell tool %s the Agent invocation', async order => {
    const { expected, events } = await fixture(), agent = nativeAgent(), shell = use('agent-call', 'Bash', { command: 'pwd' });
    if (order === 'before') agent.unshift(shell); else agent.push(shell);
    events.splice(8, 0, ...agent);
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('Conflicting Claude tool invocation');
  });
  test('attributes Agent completion and model only through the matching native result', async () => {
    const { expected, events } = await fixture(); events.splice(8, 0, ...nativeAgent());
    const proof = await parseClaudeEvidence(serialize(events), expected);
    expect(proof.session.nativeAgents).toEqual([{ subagentType: 'general-purpose', model: 'claude-haiku-5-5', completed: true, output: 'PONG' }]);
  });
  test('binds candidate agent declared effort and source separately from observed model', async () => {
    const { expected, events } = await fixture(), agent = nativeAgent('pstack:pstack-haiku-max');
    agent[0]!.message.content[0].input.effort = 'high'; events.splice(8, 0, ...agent);
    const proof = await parseClaudeEvidence(serialize(events), expected), observed = proof.session.nativeAgents![0]!;
    expect(observed).toMatchObject({ subagentType: 'pstack:pstack-haiku-max', model: 'claude-haiku-5-5', completed: true, output: 'PONG', declaredEffort: 'max', definitionPath: join(expected.pluginRoot, 'agents/pstack-haiku-max.md') });
    expect(observed.definitionHash).toMatch(/^[a-f0-9]{64}$/); expect(observed).not.toHaveProperty('effort');
  });
  test.each(['missing-result', 'missing-model', 'wrong-type', 'unknown-inventory', 'wrong-id', 'conflicting-model', 'summary-only'])('rejects %s native Agent evidence', async kind => {
    const { expected, events } = await fixture(), agent = nativeAgent();
    if (kind === 'missing-result') agent.pop();
    if (kind === 'missing-model') delete agent[2]!.tool_use_result.resolvedModel;
    if (kind === 'wrong-type') agent[2]!.tool_use_result.agentType = 'pstack:pstack-haiku-max';
    if (kind === 'unknown-inventory') events[2]!.agents = [];
    if (kind === 'wrong-id') agent[1]!.agent_id = 'different-agent';
    if (kind === 'conflicting-model') agent.splice(2, 0, event({ type: 'assistant', parent_tool_use_id: 'agent-call', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'PONG' }] } }));
    if (kind === 'summary-only') delete agent[2]!.tool_use_result.content;
    events.splice(8, 0, ...agent);
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow();
  });
  test.each(['failed-status', 'error-result'])('retains %s Agent evidence without claiming completion', async kind => {
    const { expected, events } = await fixture(), agent = nativeAgent();
    if (kind === 'failed-status') agent[2]!.tool_use_result.status = 'failed';
    else agent[2]!.message.content[0].is_error = true;
    events.splice(8, 0, ...agent);
    expect((await parseClaudeEvidence(serialize(events), expected)).session.nativeAgents![0]!.completed).toBe(false);
  });
  test('permits a child model different from its parent when native Agent result agrees', async () => {
    const { expected, events } = await fixture(), agent = nativeAgent(); expected.model = 'claude-opus-5-5'; events[2]!.model = expected.model;
    agent.splice(2, 0, event({ type: 'assistant', parent_tool_use_id: 'agent-call', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'PONG' }] } }));
    events.splice(8, 0, ...agent);
    expect((await parseClaudeEvidence(serialize(events), expected)).session.nativeAgents![0]!.model).toBe('claude-haiku-5-5');
  });
  test.each(['wrong-name', 'invalid-effort', 'duplicate-effort', 'foreign-source'])('rejects %s candidate agent source', async kind => {
    const { expected, events } = await fixture(), path = join(expected.pluginRoot, 'agents/pstack-haiku-max.md');
    if (kind === 'wrong-name') await writeFile(path, agentSource.replace('name: pstack-haiku-max', 'name: other'));
    if (kind === 'invalid-effort') await writeFile(path, agentSource.replace('effort: max', 'effort: unknown'));
    if (kind === 'duplicate-effort') await writeFile(path, agentSource.replace('effort: max', 'effort: max\neffort: low'));
    if (kind === 'foreign-source') { const foreign = join(expected.workspace, 'daily-agent.md'); await writeFile(foreign, agentSource); await rm(path); await symlink(foreign, path); }
    events.splice(8, 0, ...nativeAgent('pstack:pstack-haiku-max'));
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow();
  });
  test.each([undefined, {}])('accepts absent or empty native memory paths: %j', async memoryPaths => {
    const { expected, events } = await fixture(); events[2]!.memory_paths = memoryPaths;
    expect((await parseClaudeEvidence(serialize(events), expected)).sessionId).toBe(sessionId);
  });
  test.each([{ auto: '/operator/.claude/projects/-operator/memory/' }, { auto: '' }, { project: '/memory' }, null, [], 'disabled'].map(memoryPaths => ({ memoryPaths })))('rejects enabled or invalid native memory paths: %j', async ({ memoryPaths }) => {
    const { expected, events } = await fixture(); events[2]!.memory_paths = memoryPaths;
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow();
  });
  test.each(['gh pr merge 1', 'claude -p hello', 'outcome-ledger waive --session parent'])('rejects forbidden nested Bash attempts: %s', async command => {
    const { expected, events } = await fixture();
    events.splice(8, 0, { ...use('nested-shell', 'Bash', { command }), parent_tool_use_id: 'agent' });
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('Forbidden command');
  });
  test.each([null, 'agent'])('rejects Claude MCP attempts at parent_tool_use_id=%s', async parentToolUseId => {
    const { expected, events } = await fixture();
    events.splice(8, 0, { ...use('mcp', 'mcp__t3-code__delegate_task', { task: 'Reply PONG' }), parent_tool_use_id: parentToolUseId });
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('Forbidden MCP tool');
  });
  test.each(['Write', 'Edit'])('rejects protected %s attempts inside native agents', async name => {
    const { expected, events } = await fixture(), file = join(expected.workspace, 'operator/config/settings.json');
    expected.writePolicy = { home: join(expected.workspace, 'operator'), files: [file], directories: [] };
    events.splice(8, 0, { ...use('write', name, { file_path: file, content: 'changed' }), parent_tool_use_id: 'agent' });
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('Forbidden write');
  });
  test('requires explicit protection context for a native write', async () => {
    const { expected, events } = await fixture(); events.splice(8, 0, use('write', 'Write', { file_path: join(expected.workspace, 'result.md'), content: 'result' }));
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('write policy');
  });
  test('allows workspace writes and harmless reads of protected settings', async () => {
    const { expected, events } = await fixture(), file = join(expected.workspace, 'operator/.claude/settings.json');
    expected.writePolicy = { home: join(expected.workspace, 'operator'), files: [file], directories: [] };
    events.splice(8, 0, use('read', 'Read', { file_path: file }), use('write', 'Write', { file_path: join(expected.workspace, 'result.md'), content: 'result' }));
    events[6]!.message.content[0].input.command = `cat ${file}`;
    expect((await parseClaudeEvidence(serialize(events), expected)).session.commands).toEqual([`cat ${file}`]);
  });
  test.each(['failed', 'background'])('retains %s Bash attempts without claiming successful command execution', async kind => {
    const { expected, events } = await fixture(); events[6]!.message.content[0].input.run_in_background = kind === 'background';
    if (kind === 'background') events[7]!.tool_use_result.backgroundTaskId = 'background-task';
    else events[7]!.message.content[0].is_error = true;
    const proof = await parseClaudeEvidence(serialize(events), expected);
    expect(proof.session.commandAttempts).toEqual(['pwd']); expect(proof.session.commands).toEqual([]);
  });
  test('checks nested harmless calls without counting them as root commands or inventing agent proof', async () => {
    const { expected, events } = await fixture();
    events.splice(8, 0, { ...use('nested-shell', 'Bash', { command: 'pwd' }), parent_tool_use_id: 'agent' });
    const proof = await parseClaudeEvidence(serialize(events), expected);
    expect(proof.session.commandAttempts).toEqual(['pwd']); expect(proof.session.nativeAgents).toBeUndefined();
  });
  test('accepts the observed native ARGUMENTS suffix when it exactly matches the Skill call', async () => {
    const { expected, events, directory } = await fixture();
    events[3]!.message.content[0].input.args = 'Probe argument marker';
    events[5] = injection(directory, `${body}\n\nARGUMENTS: Probe argument marker`);
    expect((await parseClaudeEvidence(serialize(events), expected)).session.skills).toEqual(['pstack:principle-prove-it-works']);
  });
  test.each(['mismatch', 'missing', 'unrecorded', 'empty'])('rejects %s ARGUMENTS expansion', async kind => {
    const { expected, events, directory } = await fixture();
    if (kind !== 'unrecorded') events[3]!.message.content[0].input.args = kind === 'empty' ? '' : 'Probe argument marker';
    events[5] = injection(directory, kind === 'missing' ? body : `${body}\n\nARGUMENTS: Different marker`);
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('body differs');
  });
  test('rejects conflicting Skill arguments on repeated complete native invocation ids', async () => {
    const { expected, events } = await fixture();
    events.splice(4, 0, use('skill', 'Skill', { skill: 'pstack:principle-prove-it-works', args: 'Changed arguments' }));
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('Conflicting Claude tool invocation');
  });
  test('attests the single candidate startup hook and reports the native CLI version', async () => {
    const { expected, events } = await fixture(), proof = await parseClaudeEvidence(serialize(events), expected);
    expect(proof.cliVersion).toBe('2.1.299');
    expect(proof.hooks).toHaveLength(1);
    expect(proof.hooks[0]).toMatchObject({ hookId: 'startup-hook', declaredCommand: hookCommand, contextPath: join(expected.pluginRoot, 'hooks/session-start-context.md') });
    expect(proof.hooks[0]!.contextHash).toMatch(/^[a-f0-9]{64}$/);
  });
  test('accepts the hook declaration and context the candidate plugin ships', async () => {
    const { expected, events } = await fixture(), shipped = join(import.meta.dir, '../../../../plugins/pstack/hooks');
    const context = await readFile(join(shipped, 'session-start-context.md'), 'utf8');
    await writeFile(join(expected.pluginRoot, 'hooks/hooks.json'), await readFile(join(shipped, 'hooks.json')));
    await writeFile(join(expected.pluginRoot, 'hooks/session-start-context.md'), context);
    for (const e of events.filter(e => e.subtype === 'hook_response')) { e.output = context; e.stdout = context; }
    expect((await parseClaudeEvidence(serialize(events), expected)).hooks).toHaveLength(1);
  });
  test.each(['missing', 'extra', 'wrong-source', 'disconnected', 'wrong-name'])('rejects %s MCP inventory', async kind => {
    const { expected, events } = await fixture(), init = events[2]!;
    if (kind === 'missing') delete init.mcp_servers;
    if (kind === 'extra') init.mcp_servers.push({ name: 'daily-mcp', source: 'user', status: 'connected' });
    if (kind === 'wrong-source') init.mcp_servers[0].source = 'user';
    if (kind === 'disconnected') init.mcp_servers[0].status = 'failed';
    if (kind === 'wrong-name') init.mcp_servers[0].name = 'claude.ai';
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('MCP inventory');
  });
  test.each(['missing-start', 'missing-response', 'extra-hook', 'progress', 'wrong-type'])('rejects %s native hook inventory', async kind => {
    const { expected, events } = await fixture();
    if (kind === 'missing-start') events.splice(0, 1);
    if (kind === 'missing-response') events.splice(1, 1);
    if (kind === 'extra-hook') events.splice(2, 0, { ...events[0], hook_id: 'daily-hook' }, { ...events[1], hook_id: 'daily-hook', stdout: '', output: '' });
    if (kind === 'progress') events.splice(2, 0, event({ type: 'system', subtype: 'hook_progress', hook_id: 'startup-hook' }));
    if (kind === 'wrong-type') events[0]!.type = 'hook_started';
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('hook inventory');
  });
  test.each(['wrong-id', 'stop-hook', 'exit', 'outcome', 'stderr', 'output', 'stdout', 'late'])('rejects %s candidate hook evidence', async kind => {
    const { expected, events } = await fixture(), response = events[1]!;
    if (kind === 'wrong-id') response.hook_id = 'unrelated-hook';
    if (kind === 'stop-hook') response.hook_event = 'Stop';
    if (kind === 'exit') response.exit_code = 1;
    if (kind === 'outcome') response.outcome = 'error';
    if (kind === 'stderr') response.stderr = 'hook failed';
    if (kind === 'output') response.output = 'outcome-ledger is active';
    if (kind === 'stdout') response.stdout += 'unrelated instructions';
    if (kind === 'late') { events.splice(1, 1); events.splice(3, 0, response); }
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('hook');
  });
  test.each(['missing', 'extra-event', 'extra-command', 'async', 'command'])('rejects %s candidate hook declaration', async kind => {
    const { expected, events } = await fixture(), path = join(expected.pluginRoot, 'hooks/hooks.json');
    const declaration: Event = { hooks: { SessionStart: [{ matcher: 'startup|clear|compact', hooks: [{ type: 'command', command: hookCommand, async: false }] }] } };
    if (kind === 'missing') { await rm(path); }
    else {
      if (kind === 'extra-event') declaration.hooks.Stop = [];
      if (kind === 'extra-command') declaration.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'daily-hook' });
      if (kind === 'async') declaration.hooks.SessionStart[0].hooks[0].async = true;
      if (kind === 'command') declaration.hooks.SessionStart[0].hooks[0].command = 'outcome-ledger start';
      await writeFile(path, JSON.stringify(declaration));
    }
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow();
  });
  test('rejects hook context escaping the candidate tree', async () => {
    const { expected, events } = await fixture(), foreign = join(expected.workspace, 'daily-context.md');
    await writeFile(foreign, hookContext); await rm(join(expected.pluginRoot, 'hooks/session-start-context.md'));
    await symlink(foreign, join(expected.pluginRoot, 'hooks/session-start-context.md'));
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('escaped candidate');
  });
  test.each(['Stop hook feedback: blocked the stop', 'outcome-ledger is active'])('rejects synthetic daily hook feedback: %s', async text => {
    const { expected, events } = await fixture();
    events.splice(5, 0, event({ type: 'user', isSynthetic: true, message: { content: [{ type: 'text', text }] } }));
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('daily hook feedback');
  });
  test('does not confuse ordinary task prose with a daily hook execution', async () => {
    const { expected, events } = await fixture();
    events.splice(5, 0, event({ type: 'user', message: { content: [{ type: 'text', text: 'Do not run outcome-ledger.' }] } }));
    expect((await parseClaudeEvidence(serialize(events), expected)).session.skills).toHaveLength(1);
  });
  test.each(['outcome-ledger waive --session other', '/usr/local/bin/gh pr merge 1', 'git -C /candidate push origin HEAD', '/candidate/verify.sh run --pr 1', 'claude --model opus -p hello', 'claude --print=hello', 'claude plugin install other', '/plugin install other', 'printf bad > ~/.claude/settings.json'])('rejects forbidden candidate command: %s', async command => {
    const { expected, events } = await fixture(); events[6]!.message.content[0].input.command = command;
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('Forbidden command');
  });
  test('allows the candidate doctor command', async () => {
    const { expected, events } = await fixture(), command = '/candidate/verify.sh doctor --candidate';
    events[6]!.message.content[0].input.command = command;
    expect((await parseClaudeEvidence(serialize(events), expected)).session.commands).toEqual([command]);
  });
  test('rejects missing native CLI version evidence', async () => {
    const { expected, events } = await fixture(); delete events[2]!.claude_code_version;
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('CLI version');
  });
  test('accepts the expected concrete model in init and assistant messages, allowing omitted model metadata', async () => {
    const { expected, events } = await fixture(), model = 'claude-haiku-5-5';
    events[2]!.model = model; events[3]!.message.model = model;
    events.splice(4, 0, event({ type: 'stream_event', event: { type: 'message_start', message: { model: 'partial-untrusted-model' } } }));
    expect((await parseClaudeEvidence(serialize(events), { ...expected, model })).session.skills).toEqual(['pstack:principle-prove-it-works']);
  });
  test.each(['init', 'assistant', 'missing-init'])('rejects %s model mismatch against the configured concrete model', async location => {
    const { expected, events } = await fixture(), model = 'claude-haiku-5-5';
    events[2]!.model = model; events[3]!.message.model = model;
    if (location === 'init') events[2]!.model = 'claude-opus-5-5';
    if (location === 'assistant') events[3]!.message.model = 'claude-opus-5-5';
    if (location === 'missing-init') delete events[2]!.model;
    await expect(parseClaudeEvidence(serialize(events), { ...expected, model })).rejects.toThrow('model mismatch');
  });
  test('attests native plugin, exact skill body, and completed Bash result while retaining raw evidence', async () => {
    const { expected, events, directory } = await fixture(), text = serialize(events);
    const proof = await parseClaudeEvidence(text, expected);
    expect(proof.session).toEqual({ harness: 'claude', exitCode: 0, started: 1, skills: ['pstack:principle-prove-it-works'], commands: ['pwd'], commandAttempts: ['pwd'] });
    expect(proof.sessionId).toBe(sessionId); expect(proof.cwd).toBe('/operator/inherited-workspace');
    expect(proof.raw).toBe(text); expect(proof.pluginRoot).toBe(expected.pluginRoot);
    expect(proof.skills[0]).toMatchObject({ name: 'pstack:principle-prove-it-works', path: join(directory, 'SKILL.md'), toolUseId: 'skill' });
    expect(proof.skills[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  test('attests the candidate project skill through its source even with an inherited app cwd', async () => {
    const { expected, events, project } = await fixture();
    events[3] = use('skill', 'Skill', { skill: 'verify-open-pstack' });
    events[4] = result('skill', 'Launching skill: verify-open-pstack', { success: true, commandName: 'verify-open-pstack' });
    events[5] = injection(project);
    expect((await parseClaudeEvidence(serialize(events), expected)).session.skills).toEqual(['verify-open-pstack']);
  });
  test('accepts a synthetic source before the successful tool result and canonical path aliases', async () => {
    const { expected, events } = await fixture();
    [events[4], events[5]] = [events[5]!, events[4]!];
    const alias = join(expected.workspace, 'plugin-alias'); await symlink(expected.pluginRoot, alias);
    events[2]!.plugins[0].path = alias;
    expect((await parseClaudeEvidence(serialize(events), expected)).session.skills).toHaveLength(1);
  });
  test('ignores streaming partial tool blocks and deduplicates repeated complete invocations', async () => {
    const { expected, events } = await fixture();
    events.splice(4, 0, event({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'partial', name: 'Skill', input: { skill: 'pstack:wrong' } } } }), events[3]!);
    expect((await parseClaudeEvidence(serialize(events), expected)).session.skills).toEqual(['pstack:principle-prove-it-works']);
  });
  test.each(['false', 'missing'])('rejects analytics %s', async value => {
    const { expected, events } = await fixture();
    if (value === 'false') events[2]!.analytics_disabled = false; else delete events[2]!.analytics_disabled;
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('analytics must be disabled');
  });
  test.each(['missing', 'duplicate'])('rejects %s native init', async value => {
    const { expected, events } = await fixture();
    if (value === 'missing') events.splice(2, 1); else events.splice(2, 0, events[2]!);
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('exactly one native init');
  });
  test.each(['missing', 'failed', 'interrupted', 'duplicate'])('rejects %s native terminal result', async value => {
    const { expected, events } = await fixture();
    if (value === 'missing') events.splice(8, 1);
    if (value === 'failed') events[8]!.is_error = true;
    if (value === 'interrupted') events[8]!.terminal_reason = 'interrupted';
    if (value === 'duplicate') events.push(events[8]!);
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('successful terminal result');
  });
  test.each(['different', 'missing'])('rejects %s identity on any event, including streaming chunks', async value => {
    const { expected, events } = await fixture();
    const chunk = event({ type: 'stream_event' });
    if (value === 'different') chunk.session_id = 'another-session'; else delete chunk.session_id;
    events.splice(4, 0, chunk);
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('session identity');
  });
  test('rejects a native session different from the app-owned task', async () => {
    const { expected, events } = await fixture();
    await expect(parseClaudeEvidence(serialize(events), { ...expected, sessionId: 'other' })).rejects.toThrow('identity mismatch');
  });
  test.each(['foreign', 'duplicate', 'non-inline', 'false-builtin'])('rejects %s plugins', async value => {
    const { expected, events } = await fixture();
    const plugins = events[2]!.plugins;
    if (value === 'foreign') plugins.push({ name: 'daily', path: '/daily/cache', source: 'daily@marketplace' });
    if (value === 'duplicate') plugins.push(plugins[0]);
    if (value === 'non-inline') plugins[0].source = 'pstack@daily';
    if (value === 'false-builtin') plugins.push({ name: 'daily', path: 'builtin', source: 'daily@marketplace' });
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('only the inline candidate');
  });
  test('rejects another checkout or daily plugin path', async () => {
    const { expected, events } = await fixture();
    const daily = join(expected.workspace, 'daily-cache'); await mkdir(daily);
    events[2]!.plugins[0].path = daily;
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('plugin path differs');
  });
  test.each(['Skill', 'Bash'])('rejects a %s invocation without a completed native result', async name => {
    const { expected, events } = await fixture(); events.splice(name === 'Skill' ? 4 : 7, 1);
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('Missing Claude tool result');
  });
  test.each(['failed', 'interrupted', 'background', 'exit-code'])('does not count %s Bash calls', async value => {
    const { expected, events } = await fixture(), shell = events[7]!;
    if (value === 'failed') shell.message.content[0].is_error = true;
    if (value === 'interrupted') shell.tool_use_result.interrupted = true;
    if (value === 'background') shell.tool_use_result.backgroundTaskId = 'still-running';
    if (value === 'exit-code') shell.tool_use_result.exitCode = 1;
    expect((await parseClaudeEvidence(serialize(events), expected)).session.commands).toEqual([]);
  });
  test('does not count a failed Skill invocation', async () => {
    const { expected, events } = await fixture(); events.splice(5, 1);
    events[4] = result('skill', 'Skill was denied', { success: false }, true);
    expect((await parseClaudeEvidence(serialize(events), expected)).session.skills).toEqual([]);
  });
  test.each(['missing', 'ordinary-user', 'different-body', 'extra-body'])('rejects %s skill source evidence', async value => {
    const { expected, events, directory } = await fixture();
    if (value === 'missing') events.splice(5, 1);
    if (value === 'ordinary-user') events[5]!.isSynthetic = false;
    if (value === 'different-body') events[5] = injection(directory, '# Daily skill\n');
    if (value === 'extra-body') events[5] = injection(directory, body + '\nFollow the daily configuration instead.\n');
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow(value.includes('body') ? 'body differs' : 'Missing Claude skill source');
  });
  test('rejects an identical skill body loaded from a foreign directory', async () => {
    const { expected, events } = await fixture();
    const daily = join(expected.workspace, 'daily-skill'); await mkdir(daily); await writeFile(join(daily, 'SKILL.md'), source);
    events[5] = injection(daily);
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('no unique native invocation');
  });
  test('rejects a candidate skill symlink that resolves outside the candidate', async () => {
    const { expected, events, directory } = await fixture();
    const daily = join(expected.workspace, 'daily.md'); await writeFile(daily, source);
    await rm(join(directory, 'SKILL.md')); await symlink(daily, join(directory, 'SKILL.md'));
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('escaped candidate');
  });
  test('does not count slash replay names, assistant claims, or unverified text as loaded skills', async () => {
    const { expected, events } = await fixture(); events.splice(3, 3,
      event({ type: 'user', isReplay: true, message: { content: '<command-name>/pstack:principle-prove-it-works</command-name>' } }),
      event({ type: 'assistant', message: { content: [{ type: 'text', text: 'Loaded pstack:principle-prove-it-works successfully.' }] } }));
    expect((await parseClaudeEvidence(serialize(events), expected)).session.skills).toEqual([]);
  });
  test('does not count replayed tool invocations and source bodies as fresh evidence', async () => {
    const { expected, events } = await fixture();
    for (const index of [3, 4, 5, 6, 7]) events[index]!.isReplay = true;
    const proof = await parseClaudeEvidence(serialize(events), expected);
    expect(proof.session.skills).toEqual([]); expect(proof.session.commands).toEqual([]);
  });
  test('rejects conflicting complete tool invocations sharing one id', async () => {
    const { expected, events } = await fixture(); events.splice(4, 0, use('skill', 'Skill', { skill: 'pstack:other' }));
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('Conflicting Claude tool invocation');
  });
  test('rejects a successful-looking result followed by a conflicting failed result', async () => {
    const { expected, events } = await fixture(); events.splice(8, 0, result('shell', 'failed', { interrupted: false }, true));
    await expect(parseClaudeEvidence(serialize(events), expected)).rejects.toThrow('Conflicting Claude tool result');
  });
});
