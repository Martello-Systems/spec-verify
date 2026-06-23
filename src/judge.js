/**
 * LLM judge interface.
 *
 * The judge is the subjective fallback: it's only consulted for criteria that
 * the deterministic evidence layer could not decide. The interface is:
 *
 *   judge({ criterion, evidence, codeContext }) -> { verdict, reason }
 *
 *   verdict: 'PASS' | 'FAIL' | 'UNVERIFIABLE'
 *
 * Two implementations are provided:
 *   - createMockJudge(fn): a deterministic stand-in for tests.
 *   - createAnthropicJudge(opts): the real implementation using @anthropic-ai/sdk.
 *
 * NEVER hardcode an API key. The real judge reads ANTHROPIC_API_KEY from the
 * environment (the SDK does this automatically).
 */

export const VERDICTS = Object.freeze(['PASS', 'FAIL', 'UNVERIFIABLE']);

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const SMART_MODEL = 'claude-sonnet-4-6';

/**
 * Build a mock judge from a decision function.
 *
 * @param {(input:{criterion:object,evidence:object[],codeContext:string})=>{verdict:string,reason:string}|string} fn
 *        Returns either a {verdict, reason} object or a bare verdict string.
 * @returns {{judge: Function}}
 */
export function createMockJudge(fn) {
  return {
    async judge(input) {
      const out = fn ? fn(input) : { verdict: 'UNVERIFIABLE', reason: 'mock default' };
      if (typeof out === 'string') {
        return normalizeVerdict({ verdict: out, reason: 'mock' });
      }
      return normalizeVerdict(out);
    },
  };
}

/**
 * Real Anthropic-backed judge.
 *
 * @param {object} [opts]
 * @param {string} [opts.model]        - model id (default claude-haiku-4-5-20251001)
 * @param {string} [opts.apiKey]       - override; defaults to ANTHROPIC_API_KEY env
 * @param {object} [opts.client]       - inject a pre-built Anthropic client (for tests)
 * @param {number} [opts.maxTokens]
 * @returns {{judge: Function, model: string}}
 */
export function createAnthropicJudge(opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const maxTokens = opts.maxTokens || 1024;
  let clientPromise = null;

  async function getClient() {
    if (opts.client) return opts.client;
    if (!clientPromise) {
      clientPromise = (async () => {
        const mod = await import('@anthropic-ai/sdk');
        const Anthropic = mod.default || mod.Anthropic;
        // The SDK reads ANTHROPIC_API_KEY from the environment by default.
        return new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
      })();
    }
    return clientPromise;
  }

  return {
    model,
    async judge(input) {
      const client = await getClient();
      const { system, user } = buildJudgePrompt(input);

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                verdict: { type: 'string', enum: VERDICTS },
                reason: { type: 'string' },
              },
              required: ['verdict', 'reason'],
              additionalProperties: false,
            },
          },
        },
      });

      const text = textOf(response);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          verdict: 'UNVERIFIABLE',
          reason: `judge returned non-JSON output: ${text.slice(0, 200)}`,
        };
      }
      return normalizeVerdict(parsed);
    },
  };
}

/**
 * Construct the prompt sent to the LLM judge for a single criterion.
 * Exported so tests can assert on prompt shape without making a network call.
 */
export function buildJudgePrompt({ criterion, evidence = [], codeContext = '' }) {
  const system =
    'You are a strict software acceptance reviewer. Given one acceptance ' +
    'criterion, the deterministic evidence already gathered from the codebase, ' +
    'and excerpts of code context, decide whether the criterion is met. ' +
    'Respond ONLY with JSON: {"verdict": "PASS"|"FAIL"|"UNVERIFIABLE", "reason": "..."}. ' +
    'Use PASS only when the evidence clearly shows the criterion is satisfied. ' +
    'Use FAIL when the evidence clearly shows it is not. ' +
    'Use UNVERIFIABLE when you cannot tell from the provided material — never guess.';

  const evidenceLines = evidence.length
    ? evidence
        .map(
          (e) =>
            `- [${e.kind}] ${e.summary}` +
            (e.details ? ` (${JSON.stringify(truncateDetails(e.details))})` : ''),
        )
        .join('\n')
    : '(no deterministic evidence was gathered)';

  const user =
    `Acceptance criterion:\n${criterion.text}\n\n` +
    `Deterministic evidence:\n${evidenceLines}\n\n` +
    (codeContext
      ? `Relevant code context:\n${codeContext.slice(0, 6000)}\n\n`
      : '') +
    'Return your verdict as JSON now.';

  return { system, user };
}

/* ---------------------------------------------------------------- helpers */

function normalizeVerdict(out) {
  let v = String(out && out.verdict ? out.verdict : 'UNVERIFIABLE').toUpperCase();
  if (!VERDICTS.includes(v)) v = 'UNVERIFIABLE';
  return { verdict: v, reason: (out && out.reason) || '' };
}

function textOf(response) {
  if (!response || !Array.isArray(response.content)) return '';
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function truncateDetails(details) {
  const clone = {};
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === 'string' && v.length > 200) clone[k] = v.slice(0, 200) + '…';
    else if (Array.isArray(v) && v.length > 10) clone[k] = v.slice(0, 10);
    else clone[k] = v;
  }
  return clone;
}
