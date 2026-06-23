/**
 * Output formatting: results table, markdown report, and JSON.
 */

const ICON = { PASS: 'PASS', FAIL: 'FAIL', UNVERIFIABLE: 'UNVERIFIABLE' };

/** A compact, CI-log-friendly table. */
export function formatTable({ results, summary }) {
  const rows = results.map((r) => {
    const text = r.criterion.length > 60 ? r.criterion.slice(0, 57) + '…' : r.criterion;
    return [r.id, pad(ICON[r.verdict] || r.verdict, 12), text];
  });
  const lines = [];
  lines.push(`${pad('ID', 5)} ${pad('VERDICT', 12)} CRITERION`);
  lines.push('-'.repeat(60));
  for (const [id, verdict, text] of rows) {
    lines.push(`${pad(id, 5)} ${verdict} ${text}`);
  }
  lines.push('-'.repeat(60));
  lines.push(
    `Total ${summary.total} | PASS ${summary.pass} | FAIL ${summary.fail} | UNVERIFIABLE ${summary.unverifiable}`,
  );
  lines.push(summary.passed ? 'RESULT: PASSED' : 'RESULT: FAILED');
  return lines.join('\n');
}

/** A full markdown report suitable for committing or posting to a PR. */
export function formatMarkdown({ results, summary }, { title = 'spec-verify report' } = {}) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    `**Result: ${summary.passed ? 'PASSED' : 'FAILED'}** — ` +
      `${summary.pass} passed, ${summary.fail} failed, ${summary.unverifiable} unverifiable ` +
      `of ${summary.total} criteria.`,
  );
  lines.push('');
  lines.push('| ID | Verdict | Criterion | Decided by | Reason |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of results) {
    lines.push(
      `| ${r.id} | ${r.verdict} | ${escapeCell(r.criterion)} | ${r.decidedBy} | ${escapeCell(r.reason)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Plain serialisable object for --json. */
export function formatJson({ results, summary }) {
  return {
    summary,
    results: results.map((r) => ({
      id: r.id,
      criterion: r.criterion,
      verdict: r.verdict,
      reason: r.reason,
      decidedBy: r.decidedBy,
      source: r.source,
      evidence: r.evidence.map((e) => ({
        kind: e.kind,
        determinate: e.determinate,
        verdict: e.verdict,
        summary: e.summary,
      })),
    })),
  };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function escapeCell(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
