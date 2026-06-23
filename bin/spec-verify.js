#!/usr/bin/env node
/**
 * spec-verify CLI.
 *
 *   spec-verify check --spec SPEC.md --src ./build
 *   spec-verify check --spec SPEC.md --src ./build --json
 *   spec-verify check --spec SPEC.md --src ./build --report report.md
 *
 * Exit code 0 if all criteria pass (or are only unverifiable), 1 if any fail,
 * 2 on a usage/IO error.
 */

import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
  verify,
  createMockJudge,
  createAnthropicJudge,
  SpecVerifyInputError,
  DEFAULT_MODEL,
  SMART_MODEL,
  formatTable,
  formatMarkdown,
  formatJson,
} from '../src/index.js';

const program = new Command();

program
  .name('spec-verify')
  .description('Did the agent actually build the spec? Per-criterion PASS/FAIL/UNVERIFIABLE acceptance gate.')
  .version('0.1.0');

program
  .command('check')
  .description('Check a finished codebase against an acceptance spec.')
  .requiredOption('-s, --spec <file>', 'path to the markdown spec / requirements doc')
  .requiredOption('-d, --src <dir>', 'path to the finished codebase to inspect')
  .option('--json', 'emit machine-readable JSON instead of the table', false)
  .option('--report <file>', 'also write a full markdown report to <file>')
  .option('--model <id>', `LLM judge model (default ${DEFAULT_MODEL})`, DEFAULT_MODEL)
  .option('--smart', `use the smarter judge model (${SMART_MODEL})`, false)
  .option('--no-run-scripts', 'do not execute npm scripts referenced by directives')
  .option('--no-judge', 'skip the LLM judge entirely; undecided criteria become UNVERIFIABLE')
  .option('--require-modal', 'only treat bullets containing must/shall/should as criteria')
  .action(async (opts) => {
    let specText;
    try {
      specText = await readFile(opts.spec, 'utf8');
    } catch (e) {
      fail(`could not read spec file "${opts.spec}": ${e.message}`);
    }

    const judge = buildJudge(opts);

    let outcome;
    try {
      outcome = await verify({
        spec: specText,
        srcDir: opts.src,
        judge,
        parseOpts: { requireModal: !!opts.requireModal },
        ctx: { runScripts: opts.runScripts !== false },
      });
    } catch (e) {
      // Input problems get a clean one-line message; only genuine bugs print a stack.
      if (e instanceof SpecVerifyInputError) {
        fail(e.message);
      }
      fail(`verification error: ${e.stack || e.message}`);
    }

    if (opts.report) {
      try {
        await writeFile(opts.report, formatMarkdown(outcome), 'utf8');
      } catch (e) {
        process.stderr.write(`warning: could not write report to "${opts.report}": ${e.message}\n`);
      }
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify(formatJson(outcome), null, 2) + '\n');
    } else {
      process.stdout.write(formatTable(outcome) + '\n');
    }

    process.exit(outcome.summary.exitCode);
  });

function buildJudge(opts) {
  if (opts.judge === false) {
    // --no-judge: anything undecided becomes UNVERIFIABLE.
    return createMockJudge(() => ({
      verdict: 'UNVERIFIABLE',
      reason: 'judge disabled (--no-judge)',
    }));
  }
  if (process.env.SPEC_VERIFY_MOCK_JUDGE) {
    // Test/CI hook: force PASS so the pipeline can be exercised without a key.
    return createMockJudge(() => ({ verdict: 'PASS', reason: 'mock judge (env)' }));
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      'warning: ANTHROPIC_API_KEY is not set; criteria needing the LLM judge will be UNVERIFIABLE.\n' +
        'Set the key, or run with --no-judge to silence this.\n',
    );
    return createMockJudge(() => ({
      verdict: 'UNVERIFIABLE',
      reason: 'ANTHROPIC_API_KEY not set',
    }));
  }
  return createAnthropicJudge({ model: opts.smart ? SMART_MODEL : opts.model });
}

function fail(msg) {
  process.stderr.write(`spec-verify: ${msg}\n`);
  process.exit(2);
}

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`spec-verify: ${e.stack || e.message}\n`);
  process.exit(2);
});
