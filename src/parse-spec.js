/**
 * Spec parser.
 *
 * Turns a markdown spec/requirements document into a list of discrete
 * acceptance criteria. The deterministic parser recognises two explicit
 * formats:
 *
 *   1. Checklist items:        `- [ ] text`  /  `- [x] text`  (also `* [ ]`, `+ [ ]`)
 *   2. "Must / shall" bullets: `- text containing must|shall|should|will`
 *
 * Each criterion may carry an inline machine-checkable directive in a trailing
 * HTML comment, which the evidence layer consumes deterministically, e.g.
 *
 *   - [ ] A README exists <!-- check: file-exists path="README.md" -->
 *   - [ ] Exposes a /health route <!-- check: grep pattern="/health" glob="src/**" -->
 *   - [ ] Tests pass <!-- check: npm-script name="test" -->
 *
 * The LLM-assisted extractor is exposed behind the same interface
 * (`extractCriteria`) so it can be swapped for the deterministic one or a mock.
 */

const CHECK_DIRECTIVE_RE = /<!--\s*check:\s*([\s\S]*?)\s*-->/i;
const MODAL_RE = /\b(must|shall|should|will|required to|needs? to|has to)\b/i;

/**
 * Parse the inline `<!-- check: ... -->` directive attached to a criterion.
 * Returns a normalized directive object, or null if there is none / it's malformed.
 *
 * Grammar: `check: <kind> key="value" key2="value2"`
 */
export function parseCheckDirective(line) {
  const m = line.match(CHECK_DIRECTIVE_RE);
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return null;

  const kindMatch = body.match(/^([a-z][a-z0-9-]*)/i);
  if (!kindMatch) return null;
  const kind = kindMatch[1].toLowerCase();

  const args = {};
  const argRe = /([a-zA-Z_][\w-]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let a;
  while ((a = argRe.exec(body)) !== null) {
    args[a[1]] = a[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return { kind, args };
}

/** Strip the trailing check directive from a criterion's display text. */
function stripDirective(line) {
  return line.replace(CHECK_DIRECTIVE_RE, '').trim();
}

/**
 * Remove leading list markers / checkbox syntax and return the plain text.
 * Returns null if the line is not a recognised criterion-bearing line.
 */
function extractBulletText(rawLine) {
  // Checklist: - [ ] / - [x] / * [ ] / + [X]
  const checklist = rawLine.match(/^\s*[-*+]\s*\[([ xX])\]\s+(.*\S)\s*$/);
  if (checklist) {
    return { text: checklist[2], checked: checklist[1].toLowerCase() === 'x', kind: 'checklist' };
  }
  // Plain bullet
  const bullet = rawLine.match(/^\s*[-*+]\s+(.*\S)\s*$/);
  if (bullet) {
    return { text: bullet[1], checked: false, kind: 'bullet' };
  }
  // Numbered list: 1. text / 1) text
  const numbered = rawLine.match(/^\s*\d+[.)]\s+(.*\S)\s*$/);
  if (numbered) {
    return { text: numbered[1], checked: false, kind: 'numbered' };
  }
  return null;
}

/**
 * Deterministic spec parser.
 *
 * @param {string} markdown - the raw spec document
 * @param {object} [opts]
 * @param {boolean} [opts.requireModal=false] - if true, plain bullets/numbered
 *        items must contain a modal verb (must/shall/...) to count as a criterion.
 *        Checklist items always count regardless. Default false: bullets inside
 *        an "Acceptance Criteria" section all count.
 * @returns {Array<{id:string,text:string,directive:object|null,source:object}>}
 */
export function parseSpec(markdown, opts = {}) {
  const { requireModal = false } = opts;
  const lines = String(markdown).split(/\r?\n/);
  const criteria = [];

  let inAcceptanceSection = false;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Track fenced code blocks: never parse criteria out of code.
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Track section headings to know when we're under "Acceptance Criteria".
    const heading = raw.match(/^#{1,6}\s+(.*\S)\s*$/);
    if (heading) {
      inAcceptanceSection = /acceptance|criteria|requirements|must|deliverable/i.test(heading[1]);
      continue;
    }

    const bullet = extractBulletText(raw);
    if (!bullet) continue;

    const directive = parseCheckDirective(raw);
    const text = stripDirective(raw) ? stripDirectiveText(bullet.text) : bullet.text;

    // Decide whether this bullet is an acceptance criterion.
    const isChecklist = bullet.kind === 'checklist';
    let include = false;
    if (isChecklist) {
      include = true; // checklist items are always explicit criteria
    } else if (directive) {
      include = true; // an explicit machine-check directive makes it a criterion
    } else if (inAcceptanceSection) {
      include = requireModal ? MODAL_RE.test(text) : true;
    } else if (MODAL_RE.test(text)) {
      include = true; // a "must"/"shall" bullet anywhere is a criterion
    }

    if (!include) continue;

    criteria.push({
      id: `C${criteria.length + 1}`,
      text: text.trim(),
      directive,
      source: { line: i + 1, kind: bullet.kind, checked: bullet.checked },
    });
  }

  return criteria;
}

function stripDirectiveText(text) {
  return text.replace(CHECK_DIRECTIVE_RE, '').trim();
}

/**
 * Unified extraction interface. By default deterministic; pass an `extractor`
 * function (e.g. an LLM-backed one) to override. The extractor receives the raw
 * markdown and must return the same criterion shape.
 *
 * @param {string} markdown
 * @param {object} [opts]
 * @param {(md:string,opts:object)=>Array} [opts.extractor]
 * @returns {Array}
 */
export function extractCriteria(markdown, opts = {}) {
  const extractor = opts.extractor || parseSpec;
  return extractor(markdown, opts);
}
