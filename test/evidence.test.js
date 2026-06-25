import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  globToRegExp,
  matchGlob,
  expandBraces,
  listFiles,
  checkFileExists,
  checkGrep,
  checkNpmScript,
  checkExportExists,
  checkRouteExists,
  gatherFromDirective,
  runCommand,
} from '../src/evidence.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPLETE = path.join(here, 'fixtures', 'build-complete');
const INCOMPLETE = path.join(here, 'fixtures', 'build-incomplete');
const API_GOOD = path.join(here, 'fixtures', 'build-api-good');
const routeCase = (name) => path.join(here, 'fixtures', 'route-cases', name);
const ROUTE_EXPRESS = routeCase('express-route');
const ROUTE_FASTIFY = routeCase('fastify-route');
const ROUTE_STRING_ONLY = routeCase('string-only');
const ROUTE_COMMENT_LINE = routeCase('comment-line');
const ROUTE_COMMENT_BLOCK = routeCase('comment-block');
const ROUTE_TRAILING_COMMENT = routeCase('trailing-comment');
const ROUTE_CONFIG_NAV = routeCase('config-nav');
const ROUTE_CONFIG_TEST = routeCase('config-test');
const ROUTE_FASTIFY_CALL = routeCase('fastify-call');
const ROUTE_CHAIN = routeCase('route-chain');
const GREP_CASES = path.join(here, 'fixtures', 'grep-cases');

/* ----- glob ----- */

test('globToRegExp: * does not cross slashes', () => {
  assert.equal(globToRegExp('src/*.js').test('src/a.js'), true);
  assert.equal(globToRegExp('src/*.js').test('src/sub/a.js'), false);
});

test('globToRegExp: ** crosses slashes', () => {
  const re = globToRegExp('src/**/*.js');
  assert.equal(re.test('src/a.js'), true);
  assert.equal(re.test('src/sub/deep/a.js'), true);
});

test('globToRegExp: bare ** matches everything', () => {
  assert.equal(globToRegExp('**').test('a/b/c.txt'), true);
  assert.equal(globToRegExp('**').test('x'), true);
});

test('matchGlob filters a file list', () => {
  const files = ['README.md', 'src/a.js', 'src/b.ts', 'test/c.js'];
  assert.deepEqual(matchGlob(files, 'src/*.js'), ['src/a.js']);
});

test('expandBraces splits a single alternation', () => {
  assert.deepEqual(expandBraces('**/*.{js,ts}'), ['**/*.js', '**/*.ts']);
  assert.deepEqual(expandBraces('**/*.js'), ['**/*.js']);
});

/* ----- listFiles ----- */

test('listFiles returns relative posix paths and ignores node_modules', async () => {
  const files = await listFiles(COMPLETE);
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('server.js'));
  assert.ok(files.every((f) => !f.includes('node_modules')));
});

/* ----- file-exists ----- */

test('checkFileExists: PASS on exact path', async () => {
  const e = await checkFileExists(COMPLETE, { path: 'README.md' });
  assert.equal(e.determinate, true);
  assert.equal(e.verdict, 'PASS');
});

test('checkFileExists: FAIL on missing path', async () => {
  const e = await checkFileExists(COMPLETE, { path: 'LICENSE' });
  assert.equal(e.verdict, 'FAIL');
});

test('checkFileExists: glob match', async () => {
  const e = await checkFileExists(COMPLETE, { glob: '*.js' });
  assert.equal(e.verdict, 'PASS');
  assert.ok(e.details.matchCount >= 1);
});

/* ----- grep ----- */

test('checkGrep: PASS when pattern present', async () => {
  const e = await checkGrep(COMPLETE, { pattern: 'widget', flags: 'i' });
  assert.equal(e.verdict, 'PASS');
  assert.ok(e.details.hitCount >= 1);
});

test('checkGrep: FAIL when pattern absent', async () => {
  const e = await checkGrep(COMPLETE, { pattern: 'zzz_nonexistent_token_zzz' });
  assert.equal(e.verdict, 'FAIL');
});

test('checkGrep: invalid regex is non-determinate', async () => {
  const e = await checkGrep(COMPLETE, { pattern: '(' });
  assert.equal(e.determinate, false);
});

/* ----- grep `min` counts OCCURRENCES, not files (regression) ----- */

// Before the fix, `min` counted the number of *files* containing a match, so a
// single file with two occurrences (one file) failed `min:2` and two files with
// one occurrence each passed it. `min` must count total occurrences.

test('checkGrep: min counts occurrences — two hits in ONE file satisfy min=2', async () => {
  // OLD behavior: hits.length === 1 file < 2 -> FAIL. NEW: 2 occurrences -> PASS.
  const e = await checkGrep(GREP_CASES, { pattern: 'foo', min: 2, glob: 'double.js' });
  assert.equal(e.verdict, 'PASS', 'two occurrences in one file should satisfy min=2');
  assert.equal(e.details.occurrences, 2);
  assert.equal(e.details.hitCount, 1, 'still just one file');
});

test('checkGrep: min counts occurrences — a single occurrence fails min=2', async () => {
  const e = await checkGrep(GREP_CASES, { pattern: 'foo', min: 2, glob: 'single.js' });
  assert.equal(e.verdict, 'FAIL', 'one occurrence must not satisfy min=2');
  assert.equal(e.details.occurrences, 1);
});

test('checkGrep: existing "at least twice" fixture passes for the right reason', async () => {
  // The api-spec uses grep pattern="discount" min="2". In a single schema file
  // "discount" appears multiple times; occurrence-counting must see >= 2 even
  // though it is only ONE file (which file-counting would have failed).
  const e = await checkGrep(API_GOOD, { pattern: 'discount', flags: 'i', min: 2, glob: 'schema.js' });
  assert.equal(e.verdict, 'PASS');
  assert.equal(e.details.hitCount, 1, 'all matches are in a single file');
  assert.ok(e.details.occurrences >= 2, `expected >= 2 occurrences, got ${e.details.occurrences}`);
});

test('checkGrep: empty-matchable patterns do not inflate the occurrence count', async () => {
  // zerowidth.txt is "aaaaa\n", which contains no `b`. With the forced global
  // flag, `b*` matches the empty string at every position; counting those
  // zero-width matches would report ~7 occurrences and make any `min` trivially
  // pass. The guard counts only non-empty matches, so a pattern with no real
  // match is 0 (before the guard this was the file length + 1).
  const none = await checkGrep(GREP_CASES, { pattern: 'b*', glob: 'zerowidth.txt', min: 1 });
  assert.equal(none.details.occurrences, 0, 'zero-width matches must not be counted');
  assert.equal(none.verdict, 'FAIL', 'no real occurrences -> FAIL even at min=1');
  // A pattern that genuinely matches a non-empty run is still counted (once here).
  const real = await checkGrep(GREP_CASES, { pattern: 'a+', glob: 'zerowidth.txt' });
  assert.equal(real.details.occurrences, 1);
});

/* ----- export-exists ----- */

test('checkExportExists: finds an exported function', async () => {
  const e = await checkExportExists(COMPLETE, { name: 'createWidget' });
  assert.equal(e.verdict, 'PASS');
});

test('checkExportExists: FAIL for missing export', async () => {
  const e = await checkExportExists(COMPLETE, { name: 'destroyWidget' });
  assert.equal(e.verdict, 'FAIL');
});

/* ----- route-exists ----- */

test('checkRouteExists: PASS when route present (complete build)', async () => {
  const e = await checkRouteExists(COMPLETE, { path: '/health' });
  assert.equal(e.verdict, 'PASS');
});

test('checkRouteExists: FAIL when route absent (incomplete build)', async () => {
  const e = await checkRouteExists(INCOMPLETE, { path: '/health' });
  assert.equal(e.verdict, 'FAIL');
});

/* ----- route-exists must require a real routing construct (regression) ----- */

// Before the fix, route-exists matched ANY quoted string equal to the path, so
// a path appearing only in a comment, a log line, or a doc constant produced a
// false PASS. The cardinal sin for a "don't trust the agent's word" tool.

test('checkRouteExists: a path only in a comment/string is FAIL (no false green)', async () => {
  // OLD behavior: the bare quoted literal '/widgets' matched -> false PASS.
  // NEW behavior: no routing construct present -> FAIL.
  const e = await checkRouteExists(ROUTE_STRING_ONLY, { path: '/widgets' });
  assert.equal(e.verdict, 'FAIL', 'a quoted string in a comment/log is not a route');
});

test('checkRouteExists: a real Express route still PASSes', async () => {
  const e = await checkRouteExists(ROUTE_EXPRESS, { path: '/widgets' });
  assert.equal(e.verdict, 'PASS');
});

test('checkRouteExists: a real Express route with an explicit method PASSes', async () => {
  const e = await checkRouteExists(ROUTE_EXPRESS, { path: '/widgets', method: 'get' });
  assert.equal(e.verdict, 'PASS');
});

test('checkRouteExists: a Fastify-style url: config object PASSes', async () => {
  const e = await checkRouteExists(ROUTE_FASTIFY, { path: '/widgets' });
  assert.equal(e.verdict, 'PASS');
});

test('checkRouteExists: raw http req.url comparison PASSes (complete build)', async () => {
  // build-complete declares its route as `req.url === '/health'`, not a router
  // method call. That is still a genuine routing construct and must PASS.
  const e = await checkRouteExists(COMPLETE, { path: '/health' });
  assert.equal(e.verdict, 'PASS');
});

/* --- route-exists must ignore routes that live only inside comments --- */

test('checkRouteExists: a route only in a // line comment is FAIL', async () => {
  // OLD behavior: raw-text regex matched `app.get('/widgets'` inside the
  // comment -> false PASS. NEW: comments are stripped first -> FAIL.
  const e = await checkRouteExists(ROUTE_COMMENT_LINE, { path: '/widgets' });
  assert.equal(e.verdict, 'FAIL', 'a commented-out route is not a route');
});

test('checkRouteExists: a route only in a block comment is FAIL', async () => {
  const e = await checkRouteExists(ROUTE_COMMENT_BLOCK, { path: '/widgets', method: 'post' });
  assert.equal(e.verdict, 'FAIL', 'a route inside a block comment is not a route');
});

test('checkRouteExists: real code with a trailing comment still PASSes', async () => {
  // The real `app.get('/widgets', ...)` survives comment stripping; only the
  // trailing `// note` is removed.
  const e = await checkRouteExists(ROUTE_TRAILING_COMMENT, { path: '/widgets' });
  assert.equal(e.verdict, 'PASS');
});

/* --- config/test objects need a method: key to count as a route --- */

test('checkRouteExists: a nav object (path key, no method) is FAIL', async () => {
  // OLD behavior: the lone `path: '/widgets'` key matched -> false PASS.
  const e = await checkRouteExists(ROUTE_CONFIG_NAV, { path: '/widgets' });
  assert.equal(e.verdict, 'FAIL', 'a nav menu entry is not a route');
});

test('checkRouteExists: a test constant (route key, no method) is FAIL', async () => {
  const e = await checkRouteExists(ROUTE_CONFIG_TEST, { path: '/widgets' });
  assert.equal(e.verdict, 'FAIL', 'a test expectation constant is not a route');
});

test('checkRouteExists: a config object with method + url PASSes', async () => {
  const e = await checkRouteExists(ROUTE_FASTIFY, { path: '/widgets' });
  assert.equal(e.verdict, 'PASS');
});

test('checkRouteExists: fastify.route({ method, path }) PASSes', async () => {
  const e = await checkRouteExists(ROUTE_FASTIFY_CALL, { path: '/widgets' });
  assert.equal(e.verdict, 'PASS');
});

/* --- Express .route('/x') chain (path on .route, not a method call) --- */

test('checkRouteExists: app.route("/x").get(...) chain PASSes', async () => {
  // OLD behavior: the path was on `.route(`, not in the method alternation,
  // so the tightened matcher wrongly FAILed. A dedicated .route() pattern fixes it.
  const e = await checkRouteExists(ROUTE_CHAIN, { path: '/widgets' });
  assert.equal(e.verdict, 'PASS');
});

/* ----- npm-script detection (no execution) ----- */

test('checkNpmScript: detects defined script without running it', async () => {
  const e = await checkNpmScript(COMPLETE, { name: 'test' }, { runScripts: false });
  assert.equal(e.determinate, false);
  assert.match(e.summary, /present but not run/);
});

test('checkNpmScript: missing script is non-determinate', async () => {
  const e = await checkNpmScript(COMPLETE, { name: 'lint' }, { runScripts: false });
  assert.equal(e.determinate, false);
  assert.match(e.summary, /not defined/);
});

test('checkNpmScript: runs a passing script and returns PASS', async () => {
  const e = await checkNpmScript(COMPLETE, { name: 'test' });
  assert.equal(e.determinate, true);
  assert.equal(e.verdict, 'PASS');
  assert.equal(e.details.exitCode, 0);
});

/* ----- dispatch ----- */

test('gatherFromDirective dispatches by kind', async () => {
  const e = await gatherFromDirective(COMPLETE, {
    kind: 'file-exists',
    args: { path: 'README.md' },
  });
  assert.equal(e.kind, 'file-exists');
  assert.equal(e.verdict, 'PASS');
});

test('gatherFromDirective returns null for unknown kind', async () => {
  const e = await gatherFromDirective(COMPLETE, { kind: 'frobnicate', args: {} });
  assert.equal(e, null);
});

/* ----- runCommand ----- */

test('runCommand captures exit code', async () => {
  const r = await runCommand('node', ['-e', 'process.exit(3)'], { cwd: COMPLETE });
  assert.equal(r.code, 3);
  assert.equal(r.timedOut, false);
});

test('runCommand times out long processes', async () => {
  const r = await runCommand('node', ['-e', 'setTimeout(()=>{}, 5000)'], {
    cwd: COMPLETE,
    timeoutMs: 200,
  });
  assert.equal(r.timedOut, true);
});

// Regression guard for the Windows `spawn npm ENOENT`/`EINVAL` bug: npm is a
// `.cmd` shim there and must be launched through the shell. This runs npm on
// whatever platform CI is using, so it covers both win32 and POSIX.
test('runCommand resolves the npm shim cross-platform', async () => {
  const r = await runCommand('npm', ['--version'], { cwd: COMPLETE, timeoutMs: 30000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.code, 0, `npm --version should exit 0, got ${r.code}: ${r.stderr}`);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});
