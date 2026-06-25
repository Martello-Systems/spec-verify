/**
 * Orchestration: spec + codebase -> per-criterion verdicts.
 *
 * Flow per criterion:
 *   1. If it has a machine-check directive, run the matching deterministic
 *      gatherer. A determinate gatherer decides the verdict outright.
 *   2. Otherwise, gather best-effort heuristic evidence (keyword grep) and
 *      hand the criterion + evidence to the LLM judge.
 *   3. The judge returns PASS / FAIL / UNVERIFIABLE.
 *
 * Exit-code policy is computed by `summarize`: 0 if no FAILs, 1 if any FAIL.
 */

import { extractCriteria } from './parse-spec.js';
import {
  listFiles,
  gatherFromDirective,
  checkGrep,
} from './evidence.js';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Error raised when spec-verify is called with invalid inputs (missing/empty
 * spec, missing source directory, garbage spec with no criteria). Carries a
 * stable `code` so callers / the CLI can produce a clear message instead of a
 * raw stack trace.
 */
export class SpecVerifyInputError extends Error {
  constructor(message, code = 'INPUT_ERROR') {
    super(message);
    this.name = 'SpecVerifyInputError';
    this.code = code;
  }
}

/**
 * Validate that `srcDir` exists and is a directory. Throws a SpecVerifyInputError
 * with an actionable message otherwise. Returns nothing.
 */
export async function assertSrcDir(srcDir) {
  if (!srcDir || typeof srcDir !== 'string') {
    throw new SpecVerifyInputError('no source directory provided', 'SRC_MISSING');
  }
  let st;
  try {
    st = await stat(srcDir);
  } catch {
    throw new SpecVerifyInputError(
      `source path "${srcDir}" does not exist`,
      'SRC_NOT_FOUND',
    );
  }
  if (!st.isDirectory()) {
    throw new SpecVerifyInputError(
      `source path "${srcDir}" is not a directory`,
      'SRC_NOT_DIR',
    );
  }
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'be', 'to', 'of', 'in',
  'on', 'for', 'with', 'that', 'this', 'it', 'as', 'at', 'by', 'must', 'shall',
  'should', 'will', 'can', 'has', 'have', 'support', 'supports', 'all', 'each',
  'when', 'from', 'into', 'user', 'users', 'page', 'app', 'system',
]);

/**
 * Verify a spec against a source directory.
 *
 * @param {object} params
 * @param {string} params.spec              - raw markdown spec text
 * @param {string} params.srcDir            - path to the codebase to inspect
 * @param {{judge:Function}} params.judge   - LLM judge (mock or real)
 * @param {object} [params.parseOpts]       - options forwarded to the parser
 * @param {object} [params.ctx]             - evidence ctx overrides (runScripts, files...)
 * @returns {Promise<{criteria:object[], results:object[], summary:object}>}
 */
export async function verify({ spec, srcDir, judge, parseOpts = {}, ctx = {} }) {
  if (spec == null || typeof spec !== 'string' || spec.trim() === '') {
    throw new SpecVerifyInputError('spec is empty or not a string', 'SPEC_EMPTY');
  }
  // Skip the filesystem check when the caller supplies an explicit file list
  // (used by tests of the pure orchestration logic).
  if (!ctx.files) {
    await assertSrcDir(srcDir);
  }

  const criteria = extractCriteria(spec, parseOpts);
  if (criteria.length === 0) {
    throw new SpecVerifyInputError(
      'no acceptance criteria found in the spec: expected a checklist ' +
        '(`- [ ] ...`), a must/shall bullet, or items under an "Acceptance ' +
        'Criteria" heading',
      'NO_CRITERIA',
    );
  }
  const files = ctx.files || (await listFiles(srcDir));
  const sharedCtx = { ...ctx, files };

  const results = [];
  for (const criterion of criteria) {
    results.push(await verifyOne({ criterion, srcDir, judge, ctx: sharedCtx }));
  }

  return { criteria, results, summary: summarize(results) };
}

/** Verify a single criterion. Exported for granular testing. */
export async function verifyOne({ criterion, srcDir, judge, ctx = {} }) {
  const evidence = [];

  // 1. Deterministic directive, if present.
  if (criterion.directive) {
    const result = await gatherFromDirective(srcDir, criterion.directive, ctx);
    if (result) {
      evidence.push(result);
      if (result.determinate && result.verdict) {
        return makeResult(criterion, result.verdict, result.summary, evidence, 'deterministic');
      }
    }
  }

  // 2. Heuristic evidence to inform the judge (keyword presence).
  const keywords = keywordsFor(criterion.text);
  if (keywords.length) {
    const pattern = keywords.map(escapeRe).join('|');
    const kwEvidence = await checkGrep(
      srcDir,
      { pattern, flags: 'i', glob: '**' },
      ctx,
    );
    // Treat as informational only (not determinate) regardless of pass/fail.
    evidence.push({ ...kwEvidence, determinate: false, verdict: null, kind: 'keyword-grep' });
  }

  // 3. LLM judge fallback.
  if (!judge || typeof judge.judge !== 'function') {
    return makeResult(
      criterion,
      'UNVERIFIABLE',
      'no judge available and no deterministic directive',
      evidence,
      'no-judge',
    );
  }

  const codeContext = await buildCodeContext(srcDir, evidence, ctx);
  const decision = await judge.judge({ criterion, evidence, codeContext });
  return makeResult(criterion, decision.verdict, decision.reason, evidence, 'judge');
}

/** Reduce per-criterion results to a summary + exit code. */
export function summarize(results) {
  const counts = { PASS: 0, FAIL: 0, UNVERIFIABLE: 0 };
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const total = results.length;
  const failed = counts.FAIL > 0;
  return {
    total,
    pass: counts.PASS,
    fail: counts.FAIL,
    unverifiable: counts.UNVERIFIABLE,
    passed: !failed,
    exitCode: failed ? 1 : 0,
  };
}

/* ---------------------------------------------------------------- helpers */

function makeResult(criterion, verdict, reason, evidence, decidedBy) {
  return {
    id: criterion.id,
    criterion: criterion.text,
    verdict,
    reason: reason || '',
    decidedBy,
    evidence,
    source: criterion.source,
  };
}

/** Extract salient keywords from a criterion's text for heuristic grep. */
export function keywordsFor(text) {
  const words = String(text)
    .toLowerCase()
    .replace(/[`*_]/g, ' ')
    .match(/[a-z0-9][a-z0-9./-]{2,}/g) || [];
  const seen = new Set();
  const out = [];
  for (const w of words) {
    const clean = w.replace(/^[./-]+|[./-]+$/g, '');
    if (clean.length < 3) continue;
    if (STOPWORDS.has(clean)) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 8) break;
  }
  return out;
}

/** Read a small amount of the most-relevant file content for the judge. */
async function buildCodeContext(srcDir, evidence, ctx, maxChars = 4000) {
  // Collect candidate files surfaced by evidence (grep hits / matches).
  const candidates = [];
  for (const e of evidence) {
    if (e.details?.hits) candidates.push(...e.details.hits);
    if (e.details?.matches) candidates.push(...e.details.matches);
  }
  const unique = [...new Set(candidates)].slice(0, 3);
  let out = '';
  for (const rel of unique) {
    try {
      const content = await readFile(path.join(srcDir, rel), 'utf8');
      const excerpt = content.slice(0, 1200);
      out += `\n--- ${rel} ---\n${excerpt}\n`;
      if (out.length >= maxChars) break;
    } catch {
      /* ignore */
    }
  }
  return out.slice(0, maxChars);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
