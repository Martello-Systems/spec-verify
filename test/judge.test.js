import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMockJudge,
  createAnthropicJudge,
  buildJudgePrompt,
  VERDICTS,
  DEFAULT_MODEL,
} from '../src/judge.js';

test('createMockJudge accepts a bare verdict string', async () => {
  const j = createMockJudge(() => 'PASS');
  const out = await j.judge({ criterion: { text: 'x' }, evidence: [] });
  assert.equal(out.verdict, 'PASS');
});

test('createMockJudge normalizes unknown verdicts to UNVERIFIABLE', async () => {
  const j = createMockJudge(() => ({ verdict: 'maybe', reason: 'r' }));
  const out = await j.judge({ criterion: { text: 'x' } });
  assert.equal(out.verdict, 'UNVERIFIABLE');
});

test('buildJudgePrompt embeds criterion and evidence', () => {
  const { system, user } = buildJudgePrompt({
    criterion: { text: 'Exposes /health' },
    evidence: [{ kind: 'route-exists', summary: 'route not found', details: { path: '/health' } }],
    codeContext: 'some code',
  });
  assert.match(system, /acceptance reviewer/i);
  assert.match(user, /Exposes \/health/);
  assert.match(user, /route not found/);
  assert.match(user, /some code/);
});

test('buildJudgePrompt handles empty evidence', () => {
  const { user } = buildJudgePrompt({ criterion: { text: 'x' }, evidence: [] });
  assert.match(user, /no deterministic evidence/);
});

test('VERDICTS and DEFAULT_MODEL are exported', () => {
  assert.deepEqual(VERDICTS, ['PASS', 'FAIL', 'UNVERIFIABLE']);
  assert.equal(DEFAULT_MODEL, 'claude-haiku-4-5-20251001');
});

test('createAnthropicJudge works with an injected mock client', async () => {
  // Inject a fake client so we exercise the real judge code path (prompt build,
  // response parsing) without a network call or API key.
  const fakeClient = {
    messages: {
      async create(req) {
        assert.equal(req.model, DEFAULT_MODEL);
        assert.ok(req.output_config.format.schema.properties.verdict);
        return { content: [{ type: 'text', text: '{"verdict":"PASS","reason":"looks good"}' }] };
      },
    },
  };
  const j = createAnthropicJudge({ client: fakeClient });
  const out = await j.judge({ criterion: { text: 'x' }, evidence: [], codeContext: '' });
  assert.equal(out.verdict, 'PASS');
  assert.equal(out.reason, 'looks good');
});

test('createAnthropicJudge tolerates non-JSON model output', async () => {
  const fakeClient = {
    messages: {
      async create() {
        return { content: [{ type: 'text', text: 'I cannot answer that.' }] };
      },
    },
  };
  const j = createAnthropicJudge({ client: fakeClient });
  const out = await j.judge({ criterion: { text: 'x' } });
  assert.equal(out.verdict, 'UNVERIFIABLE');
});

// Live smoke test: only runs when ANTHROPIC_API_KEY is present. Skipped
// gracefully otherwise so completion never depends on a live key.
test('live judge smoke test (requires ANTHROPIC_API_KEY)', { skip: !process.env.ANTHROPIC_API_KEY }, async () => {
  const j = createAnthropicJudge();
  const out = await j.judge({
    criterion: { text: 'The README documents how to install the project.' },
    evidence: [{ kind: 'file-exists', summary: 'found README.md with install instructions', details: {} }],
    codeContext: '# Project\n\n## Install\n\n    npm install\n',
  });
  assert.ok(VERDICTS.includes(out.verdict), `verdict should be one of ${VERDICTS}`);
  assert.equal(typeof out.reason, 'string');
});
