import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  verify,
  summarize,
  keywordsFor,
  assertSrcDir,
  SpecVerifyInputError,
} from '../src/verify.js';
import { createMockJudge } from '../src/judge.js';
import { formatTable, formatMarkdown, formatJson } from '../src/report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SPEC = path.join(here, 'fixtures', 'spec.md');
const COMPLETE = path.join(here, 'fixtures', 'build-complete');
const INCOMPLETE = path.join(here, 'fixtures', 'build-incomplete');
const API_SPEC = path.join(here, 'fixtures', 'api-spec.md');
const API_GOOD = path.join(here, 'fixtures', 'build-api-good');
const API_MISSING = path.join(here, 'fixtures', 'build-api-missing');

// A mock judge that always PASSes the subjective criterion. This isolates the
// test to the deterministic evidence layer: any FAIL must come from a real
// deterministic check, not from the judge.
const passJudge = createMockJudge(() => ({ verdict: 'PASS', reason: 'mock pass' }));

test('CORE: complete build → all criteria PASS, exit 0', async () => {
  const spec = await readFile(SPEC, 'utf8');
  const { results, summary } = await verify({ spec, srcDir: COMPLETE, judge: passJudge });

  assert.equal(summary.fail, 0, 'no criterion should fail on the complete build');
  assert.equal(summary.passed, true);
  assert.equal(summary.exitCode, 0);
  assert.ok(results.every((r) => r.verdict === 'PASS'), 'every verdict should be PASS');
  assert.equal(summary.total, 6);
});

test('CORE: incomplete build → the /health route criterion FAILs, exit 1', async () => {
  const spec = await readFile(SPEC, 'utf8');
  const { results, summary } = await verify({ spec, srcDir: INCOMPLETE, judge: passJudge });

  assert.equal(summary.passed, false);
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.fail, 1, 'exactly one criterion should fail');

  const failed = results.filter((r) => r.verdict === 'FAIL');
  assert.equal(failed.length, 1);
  assert.match(failed[0].criterion, /health/, 'the failing criterion is the /health route');
  assert.equal(failed[0].decidedBy, 'deterministic');
});

/* ----- second fixture pair: prose phrasing + different omission ----- */

test('DETECTION: good API build → all criteria PASS, exit 0', async () => {
  const spec = await readFile(API_SPEC, 'utf8');
  const { results, summary } = await verify({ spec, srcDir: API_GOOD, judge: passJudge });
  assert.equal(summary.fail, 0, 'no criterion should fail on the good build');
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.total, 6);
  // Five deterministic criteria all decided without the judge.
  const deterministic = results.filter((r) => r.decidedBy === 'deterministic');
  assert.equal(deterministic.length, 5);
  assert.ok(deterministic.every((r) => r.verdict === 'PASS'));
});

test('DETECTION: build missing a route + an export → both flagged, exit 1', async () => {
  const spec = await readFile(API_SPEC, 'utf8');
  // A judge that always PASSes; any FAIL must come from deterministic checks,
  // proving spec-verify catches the silently-skipped criteria on its own.
  const { results, summary } = await verify({ spec, srcDir: API_MISSING, judge: passJudge });
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.fail, 2, 'exactly the route and export omissions fail');

  const failed = results.filter((r) => r.verdict === 'FAIL');
  assert.ok(failed.every((r) => r.decidedBy === 'deterministic'));
  assert.ok(failed.some((r) => /POST \/orders/.test(r.criterion)), 'missing route flagged');
  assert.ok(failed.some((r) => /calculateTotal/.test(r.criterion)), 'missing export flagged');
});

test('DETECTION: prose criteria (no checkboxes) are still parsed and checked', async () => {
  const spec = await readFile(API_SPEC, 'utf8');
  const { results } = await verify({ spec, srcDir: API_GOOD, judge: passJudge });
  // The README/auth criterion is phrased as plain prose with a must-bullet.
  const readme = results.find((r) => /README/.test(r.criterion));
  assert.ok(readme, 'the prose README criterion should be extracted');
  assert.equal(readme.decidedBy, 'deterministic');
  assert.equal(readme.verdict, 'PASS');
});

/* ----- input validation ----- */

test('verify: empty spec throws a clear input error', async () => {
  await assert.rejects(
    () => verify({ spec: '   ', srcDir: COMPLETE, judge: passJudge }),
    (e) => e instanceof SpecVerifyInputError && e.code === 'SPEC_EMPTY',
  );
});

test('verify: non-string spec throws a clear input error', async () => {
  await assert.rejects(
    () => verify({ spec: null, srcDir: COMPLETE, judge: passJudge }),
    (e) => e instanceof SpecVerifyInputError && e.code === 'SPEC_EMPTY',
  );
});

test('verify: a garbage spec with no criteria throws NO_CRITERIA', async () => {
  await assert.rejects(
    () => verify({ spec: 'just some prose, nothing to check here.', srcDir: COMPLETE, judge: passJudge }),
    (e) => e instanceof SpecVerifyInputError && e.code === 'NO_CRITERIA',
  );
});

test('verify: a missing source directory throws SRC_NOT_FOUND', async () => {
  const spec = await readFile(SPEC, 'utf8');
  await assert.rejects(
    () => verify({ spec, srcDir: path.join(here, 'does-not-exist'), judge: passJudge }),
    (e) => e instanceof SpecVerifyInputError && e.code === 'SRC_NOT_FOUND',
  );
});

test('assertSrcDir: rejects a file path with SRC_NOT_DIR', async () => {
  await assert.rejects(
    () => assertSrcDir(SPEC),
    (e) => e instanceof SpecVerifyInputError && e.code === 'SRC_NOT_DIR',
  );
});

test('verify: explicit ctx.files bypasses the filesystem check', async () => {
  const spec = await readFile(SPEC, 'utf8');
  // srcDir does not exist, but ctx.files is supplied, so it must not throw on src.
  const { summary } = await verify({
    spec,
    srcDir: '/nonexistent',
    judge: passJudge,
    ctx: { files: ['README.md'], packageJson: { scripts: { test: 'true' } }, runScripts: false },
  });
  assert.ok(summary.total >= 1);
});

test('deterministic directive overrides the judge', async () => {
  const spec = await readFile(SPEC, 'utf8');
  // Even a judge that always FAILs cannot flip a deterministic PASS.
  const failJudge = createMockJudge(() => ({ verdict: 'FAIL', reason: 'mock fail' }));
  const { results } = await verify({ spec, srcDir: COMPLETE, judge: failJudge });

  const readmeResult = results.find((r) => /README/.test(r.criterion));
  assert.equal(readmeResult.verdict, 'PASS');
  assert.equal(readmeResult.decidedBy, 'deterministic');
});

test('subjective criterion is routed to the judge', async () => {
  const spec = await readFile(SPEC, 'utf8');
  const seen = [];
  const spyJudge = createMockJudge((input) => {
    seen.push(input.criterion.text);
    return { verdict: 'UNVERIFIABLE', reason: 'spy' };
  });
  await verify({ spec, srcDir: COMPLETE, judge: spyJudge });
  assert.ok(
    seen.some((t) => /friendly|spirit/i.test(t)),
    'the non-directive subjective criterion should reach the judge',
  );
});

test('no judge → undecided criteria become UNVERIFIABLE, still exit 0', async () => {
  const spec = await readFile(SPEC, 'utf8');
  const { results, summary } = await verify({ spec, srcDir: COMPLETE, judge: null });
  const subjective = results.find((r) => /friendly|spirit/i.test(r.criterion));
  assert.equal(subjective.verdict, 'UNVERIFIABLE');
  // unverifiable does not fail the gate
  assert.equal(summary.exitCode, 0);
});

test('summarize computes counts and exit code', () => {
  const s = summarize([
    { verdict: 'PASS' },
    { verdict: 'FAIL' },
    { verdict: 'UNVERIFIABLE' },
    { verdict: 'PASS' },
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.pass, 2);
  assert.equal(s.fail, 1);
  assert.equal(s.unverifiable, 1);
  assert.equal(s.passed, false);
  assert.equal(s.exitCode, 1);
});

test('summarize: only-unverifiable passes the gate', () => {
  const s = summarize([{ verdict: 'UNVERIFIABLE' }, { verdict: 'PASS' }]);
  assert.equal(s.exitCode, 0);
  assert.equal(s.passed, true);
});

test('keywordsFor drops stopwords and short tokens', () => {
  const kws = keywordsFor('The service must expose a /health endpoint');
  assert.ok(kws.includes('service'));
  assert.ok(kws.includes('endpoint'));
  assert.ok(!kws.includes('the'));
  assert.ok(!kws.includes('must'));
});

/* ----- report formatting ----- */

test('formatTable renders a RESULT line', async () => {
  const spec = await readFile(SPEC, 'utf8');
  const outcome = await verify({ spec, srcDir: INCOMPLETE, judge: passJudge });
  const txt = formatTable(outcome);
  assert.match(txt, /RESULT: FAILED/);
  assert.match(txt, /FAIL/);
});

test('formatMarkdown renders a table with verdicts', async () => {
  const spec = await readFile(SPEC, 'utf8');
  const outcome = await verify({ spec, srcDir: COMPLETE, judge: passJudge });
  const md = formatMarkdown(outcome);
  assert.match(md, /Result: PASSED/);
  assert.match(md, /\| ID \| Verdict \|/);
});

test('formatJson is serialisable and carries the summary', async () => {
  const spec = await readFile(SPEC, 'utf8');
  const outcome = await verify({ spec, srcDir: INCOMPLETE, judge: passJudge });
  const json = formatJson(outcome);
  const round = JSON.parse(JSON.stringify(json));
  assert.equal(round.summary.exitCode, 1);
  assert.ok(Array.isArray(round.results));
  assert.ok(round.results.every((r) => typeof r.verdict === 'string'));
});
