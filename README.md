# spec-verify

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE) [![Built by Martello Systems](https://img.shields.io/badge/built%20by-Martello%20Systems-0b0b14)](https://martellosystems.com)

**Did the agent actually build the spec?**

`spec-verify` takes the original spec/requirements document an AI agent was given
and the finished codebase it produced, and emits a per-criterion
**PASS / FAIL / UNVERIFIABLE** verdict for every acceptance criterion. It's a
CI-friendly acceptance gate for AI-built software: wire it into a pipeline and it
exits non-zero the moment a required criterion isn't actually met.

The trick is to **gather deterministic evidence first** — file existence, content
grep, route/export presence, "does the test suite actually pass" — and only fall
back to an LLM judge for the genuinely subjective remainder. Deterministic checks
are fast, free, and not subject to a model's optimism; the LLM only adjudicates
what a regex can't.

## Why

LLM agents are confident. They will tell you the feature is "done" and the tests
"pass." `spec-verify` doesn't take their word for it — it re-derives the verdict
from the artifacts on disk. A criterion only PASSes when the evidence shows it.

## Install

```bash
npm install
# or, as a dependency:
npm install spec-verify
```

Requires Node 18+.

## Usage

Annotate your spec's acceptance criteria with inline machine-check directives
(optional but recommended), then run `check`:

```bash
spec-verify check --spec SPEC.md --src ./build
```

- Exit code **0** if every criterion passes (or is only unverifiable).
- Exit code **1** if any criterion fails.
- Exit code **2** on a usage/IO error.

### Options

| Flag | Description |
| --- | --- |
| `-s, --spec <file>` | Path to the markdown spec (required) |
| `-d, --src <dir>` | Path to the finished codebase (required) |
| `--json` | Emit machine-readable JSON instead of the table |
| `--report <file>` | Also write a full markdown report to `<file>` |
| `--model <id>` | LLM judge model (default `claude-haiku-4-5-20251001`) |
| `--smart` | Use the smarter judge model (`claude-sonnet-4-6`) |
| `--no-run-scripts` | Don't execute npm scripts referenced by directives |
| `--no-judge` | Skip the LLM judge; undecided criteria become UNVERIFIABLE |
| `--require-modal` | Only treat bullets containing must/shall/should as criteria |

### The LLM judge (bring your own key)

The judge uses the [Anthropic SDK](https://www.npmjs.com/package/@anthropic-ai/sdk)
and reads `ANTHROPIC_API_KEY` from the environment — **no key is ever hardcoded**.
If the key is absent, criteria that need the judge are reported as `UNVERIFIABLE`
(which does not fail the gate) and a warning is printed. Default model is the cheap
`claude-haiku-4-5-20251001`; pass `--smart` for `claude-sonnet-4-6`.

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # never commit this
spec-verify check --spec SPEC.md --src ./build --smart
```

## Writing checkable criteria

Use a GitHub-style checklist under an "Acceptance Criteria" heading. Attach an
inline `<!-- check: ... -->` directive to make a criterion deterministically
verifiable:

```markdown
## Acceptance Criteria

- [ ] A README documents how to run the service <!-- check: file-exists path="README.md" -->
- [ ] The service exposes a health endpoint at /health <!-- check: route-exists path="/health" -->
- [ ] A `createWidget` function is exported <!-- check: export-exists name="createWidget" -->
- [ ] The codebase references "widget" <!-- check: grep pattern="widget" flags="i" -->
- [ ] The test suite passes <!-- check: npm-script name="test" -->
- [ ] The UI feels polished and on-brand   <!-- no directive → judged by the LLM -->
```

Criteria without a directive are still parsed; they get best-effort keyword
evidence and are handed to the LLM judge.

### Supported directives

| Directive | Args | Determines verdict by |
| --- | --- | --- |
| `file-exists` | `path` or `glob` | A matching file exists |
| `grep` | `pattern`, `glob?`, `flags?`, `min?` | The regex matches in ≥ `min` files (default 1) |
| `export-exists` | `name`, `glob?` | A JS/TS module exports the named symbol |
| `route-exists` | `path`, `method?`, `glob?` | A route declaration references the path |
| `npm-script` | `name`, `timeoutMs?` | `npm run <name>` exits 0 (the suite actually runs) |

Aliases: `file`/`contains`/`script`/`test`/`export`/`route` map to the above.

## Example output

```
ID    VERDICT      CRITERION
------------------------------------------------------------
C1    PASS         A README documents how to run the service
C2    FAIL         The service exposes a health endpoint at /he…
C3    PASS         A createWidget function is exported from the…
C4    PASS         The codebase references the word "widget" so…
C5    PASS         The project ships a passing test suite
C6    UNVERIFIABLE The service should be friendly and well docu…
------------------------------------------------------------
Total 6 | PASS 4 | FAIL 1 | UNVERIFIABLE 1
RESULT: FAILED
```

With `--json`:

```json
{
  "summary": { "total": 6, "pass": 4, "fail": 1, "unverifiable": 1, "passed": false, "exitCode": 1 },
  "results": [
    { "id": "C2", "verdict": "FAIL", "reason": "route \"/health\" not found", "decidedBy": "deterministic", "...": "..." }
  ]
}
```

## Programmatic API

```js
import fs from 'node:fs';
import { verify, createAnthropicJudge, formatTable } from 'spec-verify';

const { results, summary } = await verify({
  spec: fs.readFileSync('SPEC.md', 'utf8'),
  srcDir: './build',
  judge: createAnthropicJudge(),   // reads ANTHROPIC_API_KEY
});

console.log(formatTable({ results, summary }));
process.exit(summary.exitCode);
```

Swap the judge for a mock in tests with `createMockJudge(fn)`.

## CI example (GitHub Actions)

```yaml
- run: npx spec-verify check --spec SPEC.md --src .
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Limitations

- **Source-text heuristics, not an AST.** `export-exists` / `route-exists` match
  common ESM/CJS and Express/Fastify/Next forms via regex, not a full parser. An
  exotic re-export or a route built from a computed string can be missed. Prefer
  a `grep` directive for anything unusual.
- **The LLM judge is a fallback, not the moat.** Deterministic directives decide
  the verdict whenever they can; the judge only adjudicates criteria with no
  directive. Lean on directives for anything you want CI to enforce hard.
- **`npm-script` runs the script** in the target dir — only enable it on builds
  you trust, or pass `--no-run-scripts`.
- **Binary files are skipped** (NUL-byte heuristic), so grep/export/route checks
  apply to text sources only.

## Demo

> _Demo recording placeholder — a short asciinema/GIF of `spec-verify check`
> catching a silently-skipped criterion in CI will live here._

## Development

```bash
npm install
npm test     # node:test — deterministic detection + a fixtured LLM-judge seam
npm run lint # ESLint (flat config, plain ESM)
```

The LLM judge has a clean seam: `buildJudgePrompt` (prompt assembly) and
`parseJudgeResponse` (response parsing) are pure and unit-tested against
recorded Anthropic responses — well-formed, malformed, partial, refusal, and
empty — with **no API key and no network**. A single live smoke test runs only
when `ANTHROPIC_API_KEY` is set, and skips cleanly otherwise. Detection is
proven against two spec/build fixture pairs: a good build where every criterion
passes, and a build that silently skips a criterion, which must be flagged.

## License

MIT © 2026 Martello Systems. See [LICENSE](./LICENSE).

---

## Built by Martello Systems

`spec-verify` is part of the open-source toolkit from **[Martello Systems](https://martellosystems.com)** — we ship AI-built software, spec to delivery in days. If this saved you time, come [see what we do](https://martellosystems.com).

Licensed under the [Apache License 2.0](LICENSE).
