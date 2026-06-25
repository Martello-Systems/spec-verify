/**
 * Deterministic evidence gatherers.
 *
 * Each gatherer inspects the target source tree and returns an Evidence object:
 *
 *   {
 *     kind: string,          // which gatherer produced this
 *     determinate: boolean,  // true => the verdict is decided without the LLM
 *     verdict: 'PASS'|'FAIL'|null,  // only meaningful when determinate
 *     summary: string,       // short human-readable description
 *     details: object,       // structured data (matched files, counts, exit code...)
 *   }
 *
 * The orchestrator runs these FIRST. Only when no gatherer can produce a
 * determinate verdict does it fall back to the LLM judge.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

/* --------------------------------------------------------------------------
 * Tiny glob implementation (no external dependency).
 * Supports: **, *, ?, and literal path segments. Matches against POSIX-style
 * relative paths. Good enough for spec-verify's file-matching needs.
 * ------------------------------------------------------------------------ */

/** Convert a glob pattern into a RegExp anchored to the full relative path. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** => match across path separators.
        i++;
        if (glob[i + 1] === '/') {
          // `**/` consumes the slash and matches an optional directory prefix,
          // so `**/foo` matches both `foo` and `a/b/foo`.
          i++;
          re += '(?:.*/)?';
        } else {
          // bare `**` (e.g. the whole pattern, or a trailing segment) matches
          // anything including slashes, and an empty string.
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '.turbo',
]);

/**
 * Recursively list files under `root`, returning POSIX-style relative paths.
 * Directories in DEFAULT_IGNORE are skipped.
 */
export async function listFiles(root, { ignore = DEFAULT_IGNORE } = {}) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ignore.has(ent.name)) continue;
        await walk(path.join(dir, ent.name));
      } else if (ent.isFile()) {
        const rel = path.relative(root, path.join(dir, ent.name));
        out.push(rel.split(path.sep).join('/'));
      }
    }
  }
  await walk(root);
  out.sort();
  return out;
}

/** Match a list of relative paths against a glob. */
export function matchGlob(files, glob) {
  const re = globToRegExp(glob);
  return files.filter((f) => re.test(f));
}

/* --------------------------------------------------------------------------
 * Gatherers
 * ------------------------------------------------------------------------ */

/**
 * file-exists: does at least one file match the given path/glob?
 * args: { path?: string, glob?: string }
 */
export async function checkFileExists(srcDir, args, ctx = {}) {
  const pattern = args.path || args.glob;
  if (!pattern) {
    return ev('file-exists', false, null, 'no path/glob provided', {});
  }
  const files = ctx.files || (await listFiles(srcDir));
  // A bare path with no glob chars is treated as an exact relative path.
  const isGlob = /[*?]/.test(pattern);
  const matches = isGlob
    ? matchGlob(files, pattern)
    : files.filter((f) => f === normalizeRel(pattern));
  const ok = matches.length > 0;
  return ev(
    'file-exists',
    true,
    ok ? 'PASS' : 'FAIL',
    ok
      ? `found ${matches.length} file(s) matching "${pattern}"`
      : `no file matching "${pattern}"`,
    { pattern, matches: matches.slice(0, 25), matchCount: matches.length },
  );
}

/**
 * grep: does any matching file contain a line matching the regex?
 * args: { pattern: string, glob?: string, flags?: string, min?: number }
 */
export async function checkGrep(srcDir, args, ctx = {}) {
  if (!args.pattern) {
    return ev('grep', false, null, 'no pattern provided', {});
  }
  const flags = args.flags || '';
  let re;
  try {
    // Force the global flag so String#match returns *every* occurrence, not
    // just the first. `min` counts total occurrences, so we must see them all.
    re = new RegExp(args.pattern, flags.includes('g') ? flags : flags + 'g');
  } catch (e) {
    return ev('grep', false, null, `invalid regex: ${e.message}`, { pattern: args.pattern });
  }
  const glob = args.glob || '**';
  const min = args.min != null ? Number(args.min) : 1;
  const files = ctx.files || (await listFiles(srcDir));
  const candidates = matchGlob(files, glob);

  const hits = [];
  let occurrences = 0;
  for (const rel of candidates) {
    let content;
    try {
      content = await readFile(path.join(srcDir, rel), 'utf8');
    } catch {
      continue;
    }
    // Skip obvious binaries.
    if (content.includes('\0')) continue;
    // Count occurrences in this file. With the global flag, String#match
    // returns an array of all matches (or null); its length is the count.
    const matches = content.match(re);
    if (matches && matches.length) {
      occurrences += matches.length;
      hits.push(rel);
    }
  }
  // `min` is a threshold on total occurrences across the matched files, not on
  // the number of files that happen to contain a match. A single file with two
  // hits satisfies min=2; two files with one hit each do too.
  const ok = occurrences >= min;
  return ev(
    'grep',
    true,
    ok ? 'PASS' : 'FAIL',
    ok
      ? `pattern matched ${occurrences} time(s) across ${hits.length} file(s)`
      : `pattern matched ${occurrences} time(s) across ${hits.length} file(s), need >= ${min}`,
    {
      pattern: args.pattern,
      glob,
      min,
      hits: hits.slice(0, 25),
      hitCount: hits.length,
      occurrences,
    },
  );
}

/**
 * npm-script: run a named npm script in the target dir and pass iff exit 0.
 * args: { name: string, timeoutMs?: number }
 *
 * Detects the script first; if the script is absent, returns UNVERIFIABLE
 * (determinate=false) so the orchestrator can decide how to treat it.
 */
export async function checkNpmScript(srcDir, args, ctx = {}) {
  const name = args.name || 'test';
  const pkg = await readPackageJson(srcDir, ctx);
  if (!pkg) {
    return ev('npm-script', false, null, `no package.json in ${srcDir}`, { name });
  }
  if (!pkg.scripts || !pkg.scripts[name]) {
    return ev('npm-script', false, null, `npm script "${name}" not defined`, {
      name,
      available: pkg.scripts ? Object.keys(pkg.scripts) : [],
    });
  }
  if (ctx.runScripts === false) {
    // Caller opted out of executing scripts (e.g. tests of the gatherer logic).
    return ev('npm-script', false, null, `script "${name}" present but not run (runScripts=false)`, {
      name,
      command: pkg.scripts[name],
    });
  }
  const timeoutMs = args.timeoutMs != null ? Number(args.timeoutMs) : 120000;
  const result = await runCommand('npm', ['run', '--silent', name], {
    cwd: srcDir,
    timeoutMs,
  });
  const ok = result.code === 0 && !result.timedOut;
  return ev(
    'npm-script',
    true,
    ok ? 'PASS' : 'FAIL',
    ok
      ? `npm run ${name} exited 0`
      : result.timedOut
        ? `npm run ${name} timed out after ${timeoutMs}ms`
        : `npm run ${name} exited ${result.code}`,
    {
      name,
      command: pkg.scripts[name],
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
    },
  );
}

/**
 * export-exists: does any matching JS/TS file export a named symbol?
 * args: { name: string, glob?: string }
 * Heuristic, source-text based (no parsing): matches common ESM/CJS export forms.
 */
export async function checkExportExists(srcDir, args, ctx = {}) {
  if (!args.name) {
    return ev('export-exists', false, null, 'no name provided', {});
  }
  const n = escapeRe(args.name);
  const patterns = [
    `export\\s+(?:async\\s+)?function\\s+${n}\\b`,
    `export\\s+(?:const|let|var|class)\\s+${n}\\b`,
    `export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`,
    `export\\s+default\\s+(?:async\\s+)?(?:function|class)\\s+${n}\\b`,
    `exports\\.${n}\\s*=`,
    `module\\.exports\\.${n}\\s*=`,
    `module\\.exports\\s*=\\s*\\{[^}]*\\b${n}\\b`,
  ];
  const combined = patterns.join('|');
  const glob = args.glob || '**/*.{js,jsx,ts,tsx,mjs,cjs}';
  // Our mini-glob doesn't support brace expansion; expand manually.
  const globs = expandBraces(glob);
  const sub = await orGrep(srcDir, combined, globs, ctx);
  return ev(
    'export-exists',
    true,
    sub.ok ? 'PASS' : 'FAIL',
    sub.ok ? `export "${args.name}" found in ${sub.hits.length} file(s)` : `export "${args.name}" not found`,
    { name: args.name, globs, hits: sub.hits.slice(0, 25), hitCount: sub.hits.length },
  );
}

/**
 * route-exists: does any file declare a route at the given path?
 * args: { path: string, method?: string, glob?: string }
 *
 * Matches Express/Fastify/Koa-style declarations and config-driven route
 * objects. Crucially it requires the path to co-occur with an actual *routing
 * construct* — a method call, a route-config key, or a request-URL comparison.
 * A path that merely appears as a quoted string in a comment, a log line, or a
 * test constant is NOT a route and must not produce a (false) PASS.
 */
export async function checkRouteExists(srcDir, args, ctx = {}) {
  const routePath = args.path;
  if (!routePath) {
    return ev('route-exists', false, null, 'no path provided', {});
  }
  const p = escapeRe(routePath);
  const method = args.method
    ? escapeRe(args.method.toLowerCase())
    : '(?:get|post|put|patch|delete|options|head|all|use)';
  // The path rendered as a quoted string literal (single, double, or template).
  const q = `['"\`]${p}['"\`]`;
  const patterns = [
    // 1. Router method call: app.get('/path', ...) / router.post("/path", ...)
    `\\.\\s*${method}\\s*\\(\\s*${q}`,
    // 2. Route-config object key: { method:'GET', url:'/path' } / { path:'/path' }
    //    / { route:'/path' } (Fastify object form, config-driven routers).
    `(?:url|path|route|pathname)\\s*:\\s*${q}`,
    // 3. Raw http(s) request dispatch: req.url === '/path' (or the reverse).
    `(?:req(?:uest)?\\.url|\\.pathname)\\s*===?\\s*${q}`,
    `${q}\\s*===?\\s*(?:req(?:uest)?\\.url|\\.pathname)`,
  ];
  const combined = patterns.join('|');
  const globs = expandBraces(args.glob || '**/*.{js,jsx,ts,tsx,mjs,cjs}');
  const sub = await orGrep(srcDir, combined, globs, ctx);
  return ev(
    'route-exists',
    true,
    sub.ok ? 'PASS' : 'FAIL',
    sub.ok ? `route "${routePath}" referenced in ${sub.hits.length} file(s)` : `route "${routePath}" not found`,
    { path: routePath, method: args.method || 'any', hits: sub.hits.slice(0, 25), hitCount: sub.hits.length },
  );
}

/**
 * Dispatch a parsed directive to the right gatherer.
 * Returns null if the directive kind is unknown.
 */
export async function gatherFromDirective(srcDir, directive, ctx = {}) {
  if (!directive) return null;
  const { kind, args = {} } = directive;
  switch (kind) {
    case 'file-exists':
    case 'file':
      return checkFileExists(srcDir, args, ctx);
    case 'grep':
    case 'contains':
      return checkGrep(srcDir, args, ctx);
    case 'npm-script':
    case 'script':
    case 'test':
      return checkNpmScript(srcDir, args, ctx);
    case 'export':
    case 'export-exists':
      return checkExportExists(srcDir, args, ctx);
    case 'route':
    case 'route-exists':
      return checkRouteExists(srcDir, args, ctx);
    default:
      return null;
  }
}

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

function ev(kind, determinate, verdict, summary, details) {
  return { kind, determinate, verdict, summary, details };
}

function normalizeRel(p) {
  return p.replace(/^\.\//, '').split(path.sep).join('/');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tail(s, max = 600) {
  if (!s) return '';
  return s.length > max ? s.slice(-max) : s;
}

/** Expand a single-level brace alternation like `**\/*.{js,ts}` into multiple globs. */
export function expandBraces(glob) {
  const m = glob.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (!m) return [glob];
  const [, pre, body, post] = m;
  return body.split(',').map((opt) => pre + opt.trim() + post);
}

/** Run a regex across the union of several globs; report which files matched. */
async function orGrep(srcDir, pattern, globs, ctx) {
  const files = ctx.files || (await listFiles(srcDir));
  let re;
  try {
    re = new RegExp(pattern, 'm');
  } catch {
    return { ok: false, hits: [] };
  }
  const candidates = new Set();
  for (const g of globs) for (const f of matchGlob(files, g)) candidates.add(f);
  const hits = [];
  for (const rel of candidates) {
    let content;
    try {
      content = await readFile(path.join(srcDir, rel), 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\0')) continue;
    if (re.test(content)) hits.push(rel);
  }
  hits.sort();
  return { ok: hits.length > 0, hits };
}

async function readPackageJson(srcDir, ctx) {
  if (ctx.packageJson !== undefined) return ctx.packageJson;
  try {
    const raw = await readFile(path.join(srcDir, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Commands that are `.cmd`/`.bat` batch shims on Windows (rather than real
 * `.exe`s). These must be launched through a shell on win32: `spawn('npm', ...)`
 * with shell:false fails there with ENOENT (or EINVAL on patched Node, which
 * refuses to run `.cmd` files without a shell). Real executables like `node`
 * are deliberately NOT in this set — running them through the shell would let
 * cmd.exe mangle arguments that contain spaces or metacharacters.
 */
const WINDOWS_SHELL_COMMANDS = new Set(['npm', 'npx', 'yarn', 'pnpm', 'corepack']);

/**
 * Run a child process, capturing stdout/stderr with a timeout.
 * Resolves with { code, stdout, stderr, timedOut }.
 */
export function runCommand(cmd, cmdArgs, { cwd, timeoutMs = 120000, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // Only the batch-shim CLIs need the shell on Windows; cmd.exe then
      // resolves the executable via PATHEXT. Everything else (and all of POSIX)
      // runs shell:false so arguments are passed through verbatim.
      const useShell =
        process.platform === 'win32' && WINDOWS_SHELL_COMMANDS.has(cmd);
      child = spawn(cmd, cmdArgs, {
        cwd,
        env: { ...process.env, ...env },
        shell: useShell,
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e && e.message), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e && e.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export { stat };
