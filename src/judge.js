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
      const { system, user } = buildJudgePrompt(input);

      let client;
      try {
        client = await getClient();
      } catch (e) {
        // Surface a clear, actionable message rather than a raw SDK stack.
        return {
          verdict: 'UNVERIFIABLE',
          reason: `could not initialize the Anthropic client (${cleanErr(e)}); ` +
            'is ANTHROPIC_API_KEY set?',
        };
      }

      let response;
      try {
        response = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
          // Forced tool use is how structured output is obtained on
          // @anthropic-ai/sdk@^0.40. We require the model to call record_verdict
          // and read the verdict straight out of the tool_use block's input.
          tools: [
            {
              name: 'record_verdict',
              description:
                'Record the acceptance verdict for the criterion under review.',
              input_schema: {
                type: 'object',
                properties: {
                  verdict: { type: 'string', enum: VERDICTS },
                  reason: { type: 'string' },
                },
                required: ['verdict', 'reason'],
              },
            },
          ],
          tool_choice: { type: 'tool', name: 'record_verdict' },
        });
      } catch (e) {
        // Network error, auth error, rate limit, etc. Never crash the gate:
        // degrade to UNVERIFIABLE with a readable reason.
        return {
          verdict: 'UNVERIFIABLE',
          reason: `LLM judge request failed: ${cleanErr(e)}`,
        };
      }

      return parseJudgeResponse(response);
    },
  };
}

/**
 * Turn a raw Anthropic Messages response into a normalized {verdict, reason}.
 * Handles, without ever throwing:
 *   - a forced `record_verdict` tool_use block (the primary path)
 *   - well-formed verdict JSON in a text block (secondary, lenient fallback)
 *   - a safety refusal (stop_reason === 'refusal')
 *   - an empty / missing content array
 *   - malformed or partial JSON (extracts a fenced/embedded JSON object if any)
 *
 * Exported so the parsing seam can be tested with recorded responses and no key.
 */
export function parseJudgeResponse(response) {
  if (response && response.stop_reason === 'refusal') {
    return {
      verdict: 'UNVERIFIABLE',
      reason: 'LLM judge declined to answer (safety refusal)',
    };
  }

  // Primary path: forced tool use. Read the verdict straight out of the
  // record_verdict tool_use block's structured input.
  const toolInput = toolVerdictOf(response);
  if (toolInput) {
    return normalizeVerdict(toolInput);
  }

  // Secondary path: a model (or a recorded fixture) may put the verdict JSON in
  // a text block instead. Recover it leniently before giving up.
  const text = textOf(response);
  if (!text) {
    return { verdict: 'UNVERIFIABLE', reason: 'LLM judge returned an empty response' };
  }

  const parsed = parseLenientJson(text);
  if (parsed === undefined) {
    return {
      verdict: 'UNVERIFIABLE',
      reason: `LLM judge returned non-JSON output: ${snippet(text)}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      verdict: 'UNVERIFIABLE',
      reason: `LLM judge returned unexpected JSON: ${snippet(text)}`,
    };
  }
  return normalizeVerdict(parsed);
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
    'Use UNVERIFIABLE when you cannot tell from the provided material. Never guess.';

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

/**
 * Parse JSON leniently. Returns the parsed value, or `undefined` if no JSON
 * object could be recovered. Handles three real-world model behaviors:
 *   1. clean JSON
 *   2. JSON wrapped in a ```json fenced block or surrounded by prose
 *   3. partial / malformed JSON (returns undefined; caller degrades gracefully)
 */
function parseLenientJson(text) {
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to recovery */
  }
  // Strip a ```json ... ``` fence if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  // Last resort: grab the first balanced-looking {...} object and try it.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

function cleanErr(e) {
  const msg = (e && (e.message || e.toString())) || 'unknown error';
  return String(msg).split('\n')[0].slice(0, 200);
}

function snippet(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
}

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

/**
 * Extract the structured input of the forced `record_verdict` tool call, or
 * null if the response carries no such block.
 */
function toolVerdictOf(response) {
  if (!response || !Array.isArray(response.content)) return null;
  const block = response.content.find(
    (b) => b && b.type === 'tool_use' && b.name === 'record_verdict' && b.input,
  );
  return block ? block.input : null;
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
