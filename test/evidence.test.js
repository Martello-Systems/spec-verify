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
