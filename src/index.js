/**
 * spec-verify public API.
 *
 * Programmatic usage:
 *
 *   import { verify, createAnthropicJudge } from 'spec-verify';
 *   const { results, summary } = await verify({
 *     spec: fs.readFileSync('SPEC.md', 'utf8'),
 *     srcDir: './build',
 *     judge: createAnthropicJudge(),   // reads ANTHROPIC_API_KEY from env
 *   });
 */

export { parseSpec, extractCriteria, parseCheckDirective } from './parse-spec.js';
export {
  listFiles,
  matchGlob,
  globToRegExp,
  expandBraces,
  checkFileExists,
  checkGrep,
  checkNpmScript,
  checkExportExists,
  checkRouteExists,
  gatherFromDirective,
  runCommand,
} from './evidence.js';
export {
  createMockJudge,
  createAnthropicJudge,
  buildJudgePrompt,
  VERDICTS,
  DEFAULT_MODEL,
  SMART_MODEL,
} from './judge.js';
export { verify, verifyOne, summarize, keywordsFor } from './verify.js';
export { formatTable, formatMarkdown, formatJson } from './report.js';
