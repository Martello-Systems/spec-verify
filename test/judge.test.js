import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMockJudge,
  createAnthropicJudge,
  buildJudgePrompt,
  parseJudgeResponse,
  VERDICTS,
  DEFAULT_MODEL,
} from '../src/judge.js';

/** Build a fake Anthropic client whose messages.create returns `response`. */
function fakeClient(response, onReq) {
  return {
    messages: {
      async create(req) {
        if (onReq) onReq(req);
        return typeof response === 'function' ? response(req) : response;
      },
    },
  };
}

/** Shape a recorded Anthropic Messages response with a single text block. */
function recorded(text, extra = {}) {
  return { content: [{ type: 'text', text }], ...extra };
}

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

/* ---- prompt assembly (no key, no network) ---- */

test('buildJudgePrompt enumerates every evidence item with its kind', () => {
  const { user } = buildJudgePrompt({
    criterion: { text: 'Has a /health route and passing tests' },
    evidence: [
      { kind: 'route-exists', summary: 'route not found', details: { path: '/health' } },
      { kind: 'npm-script', summary: 'npm run test exited 0', details: { exitCode: 0 } },
    ],
    codeContext: '',
  });
  assert.match(user, /\[route-exists\] route not found/);
  assert.match(user, /\[npm-script\] npm run test exited 0/);
});

test('buildJudgePrompt truncates very long code context', () => {
  const huge = 'x'.repeat(20000);
  const { user } = buildJudgePrompt({ criterion: { text: 'c' }, evidence: [], codeContext: huge });
  // The 'x' run must be capped well below its original length.
  const run = user.match(/x+/)[0];
  assert.ok(run.length <= 6000, `code context should be truncated, got ${run.length}`);
});

test('buildJudgePrompt instructs JSON-only output and the three verdicts', () => {
  const { system } = buildJudgePrompt({ criterion: { text: 'c' } });
  assert.match(system, /JSON/);
  for (const v of VERDICTS) assert.match(system, new RegExp(v));
});

/* ---- response parsing: fixtured Anthropic responses, no key ---- */

test('parseJudgeResponse: well-formed verdict JSON', () => {
  const out = parseJudgeResponse(recorded('{"verdict":"FAIL","reason":"missing route"}'));
  assert.equal(out.verdict, 'FAIL');
  assert.equal(out.reason, 'missing route');
});

test('parseJudgeResponse: JSON wrapped in a markdown fence', () => {
  const out = parseJudgeResponse(
    recorded('Here is my answer:\n```json\n{"verdict":"PASS","reason":"ok"}\n```'),
  );
  assert.equal(out.verdict, 'PASS');
  assert.equal(out.reason, 'ok');
});

test('parseJudgeResponse: JSON embedded in surrounding prose', () => {
  const out = parseJudgeResponse(
    recorded('I think {"verdict":"PASS","reason":"clear"} is right.'),
  );
  assert.equal(out.verdict, 'PASS');
});

test('parseJudgeResponse: malformed JSON degrades to UNVERIFIABLE with a reason', () => {
  const out = parseJudgeResponse(recorded('{"verdict": "PA'));
  assert.equal(out.verdict, 'UNVERIFIABLE');
  assert.match(out.reason, /non-JSON|unexpected/i);
});

test('parseJudgeResponse: partial JSON object recovers the verdict if balanced', () => {
  // A complete object embedded after a partial fragment — recovery grabs {..}.
  const out = parseJudgeResponse(recorded('oops {"verdict":"FAIL","reason":"r"}'));
  assert.equal(out.verdict, 'FAIL');
});

test('parseJudgeResponse: non-object JSON (a bare array) is UNVERIFIABLE', () => {
  const out = parseJudgeResponse(recorded('["PASS"]'));
  assert.equal(out.verdict, 'UNVERIFIABLE');
});

test('parseJudgeResponse: a plain-text refusal is UNVERIFIABLE, never a crash', () => {
  const out = parseJudgeResponse(recorded('I cannot answer that.'));
  assert.equal(out.verdict, 'UNVERIFIABLE');
});

test('parseJudgeResponse: a safety refusal (stop_reason) is UNVERIFIABLE', () => {
  const out = parseJudgeResponse({ stop_reason: 'refusal', content: [] });
  assert.equal(out.verdict, 'UNVERIFIABLE');
  assert.match(out.reason, /refus/i);
});

test('parseJudgeResponse: empty content array is UNVERIFIABLE', () => {
  const out = parseJudgeResponse({ content: [] });
  assert.equal(out.verdict, 'UNVERIFIABLE');
  assert.match(out.reason, /empty/i);
});

test('parseJudgeResponse: missing/garbage response is UNVERIFIABLE, no throw', () => {
  assert.equal(parseJudgeResponse(undefined).verdict, 'UNVERIFIABLE');
  assert.equal(parseJudgeResponse(null).verdict, 'UNVERIFIABLE');
  assert.equal(parseJudgeResponse({}).verdict, 'UNVERIFIABLE');
});

test('parseJudgeResponse: unknown verdict value normalizes to UNVERIFIABLE', () => {
  const out = parseJudgeResponse(recorded('{"verdict":"probably","reason":"r"}'));
  assert.equal(out.verdict, 'UNVERIFIABLE');
});

/* ---- createAnthropicJudge over fixtured responses (no key) ---- */

test('createAnthropicJudge: prompt assembly reaches the client correctly', async () => {
  let seen;
  const j = createAnthropicJudge({
    client: fakeClient(recorded('{"verdict":"PASS","reason":"ok"}'), (req) => {
      seen = req;
    }),
  });
  await j.judge({
    criterion: { text: 'Exposes /health' },
    evidence: [{ kind: 'route-exists', summary: 'found', details: {} }],
    codeContext: 'app.get("/health")',
  });
  assert.equal(seen.model, DEFAULT_MODEL);
  assert.match(seen.system, /acceptance reviewer/i);
  assert.match(seen.messages[0].content, /Exposes \/health/);
  assert.match(seen.messages[0].content, /\[route-exists\] found/);
  assert.deepEqual(seen.output_config.format.schema.required, ['verdict', 'reason']);
});

test('createAnthropicJudge: malformed JSON from the model is UNVERIFIABLE', async () => {
  const j = createAnthropicJudge({ client: fakeClient(recorded('{"verdict": "PA')) });
  const out = await j.judge({ criterion: { text: 'x' } });
  assert.equal(out.verdict, 'UNVERIFIABLE');
});

test('createAnthropicJudge: a refusal response is UNVERIFIABLE', async () => {
  const j = createAnthropicJudge({ client: fakeClient({ stop_reason: 'refusal', content: [] }) });
  const out = await j.judge({ criterion: { text: 'x' } });
  assert.equal(out.verdict, 'UNVERIFIABLE');
});

test('createAnthropicJudge: an SDK error degrades to UNVERIFIABLE, never throws', async () => {
  const throwingClient = {
    messages: {
      async create() {
        const e = new Error('401 authentication_error: invalid x-api-key');
        throw e;
      },
    },
  };
  const j = createAnthropicJudge({ client: throwingClient });
  const out = await j.judge({ criterion: { text: 'x' } });
  assert.equal(out.verdict, 'UNVERIFIABLE');
  assert.match(out.reason, /request failed/i);
  // The reason is a clean single line, not a raw multi-line stack.
  assert.ok(!out.reason.includes('\n'), 'reason should be a single clean line');
});

test('createAnthropicJudge: a smart model id is honored', async () => {
  let seen;
  const j = createAnthropicJudge({
    model: 'claude-sonnet-4-6',
    client: fakeClient(recorded('{"verdict":"PASS","reason":"r"}'), (req) => (seen = req)),
  });
  await j.judge({ criterion: { text: 'x' } });
  assert.equal(seen.model, 'claude-sonnet-4-6');
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
