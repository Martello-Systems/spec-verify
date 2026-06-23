import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, parseCheckDirective } from '../src/parse-spec.js';

test('parseCheckDirective parses kind and quoted args', () => {
  const d = parseCheckDirective('- [ ] x <!-- check: grep pattern="foo" glob="src/**" -->');
  assert.equal(d.kind, 'grep');
  assert.equal(d.args.pattern, 'foo');
  assert.equal(d.args.glob, 'src/**');
});

test('parseCheckDirective returns null when absent', () => {
  assert.equal(parseCheckDirective('- [ ] no directive here'), null);
});

test('parseCheckDirective handles escaped quotes in values', () => {
  const d = parseCheckDirective('- [ ] x <!-- check: grep pattern="a\\"b" -->');
  assert.equal(d.args.pattern, 'a"b');
});

test('parseSpec extracts checklist items with directives', () => {
  const md = [
    '# Spec',
    '## Acceptance Criteria',
    '- [ ] A README exists <!-- check: file-exists path="README.md" -->',
    '- [x] Already done item',
  ].join('\n');
  const c = parseSpec(md);
  assert.equal(c.length, 2);
  assert.equal(c[0].id, 'C1');
  assert.equal(c[0].text, 'A README exists');
  assert.equal(c[0].directive.kind, 'file-exists');
  assert.equal(c[1].source.checked, true);
});

test('parseSpec includes must/shall bullets outside acceptance section', () => {
  const md = ['# Notes', '- The service must respond to /health', '- Just a note'].join('\n');
  const c = parseSpec(md);
  assert.equal(c.length, 1);
  assert.match(c[0].text, /must respond/);
});

test('parseSpec includes plain bullets inside an acceptance section', () => {
  const md = ['## Requirements', '- Has a login page', '- Has a dashboard'].join('\n');
  const c = parseSpec(md);
  assert.equal(c.length, 2);
});

test('parseSpec requireModal filters plain bullets', () => {
  const md = ['## Requirements', '- Has a login page', '- The app must support logout'].join('\n');
  const c = parseSpec(md, { requireModal: true });
  assert.equal(c.length, 1);
  assert.match(c[0].text, /must support logout/);
});

test('parseSpec ignores bullets inside fenced code blocks', () => {
  const md = [
    '## Acceptance Criteria',
    '- [ ] real criterion',
    '```',
    '- [ ] this is code, not a criterion',
    '```',
  ].join('\n');
  const c = parseSpec(md);
  assert.equal(c.length, 1);
  assert.equal(c[0].text, 'real criterion');
});

test('parseSpec strips the directive from display text', () => {
  const md = '## Criteria\n- [ ] Exposes /health <!-- check: route-exists path="/health" -->';
  const c = parseSpec(md);
  assert.equal(c[0].text, 'Exposes /health');
});

test('parseSpec assigns sequential ids', () => {
  const md = '## Criteria\n- [ ] one\n- [ ] two\n- [ ] three';
  const c = parseSpec(md);
  assert.deepEqual(c.map((x) => x.id), ['C1', 'C2', 'C3']);
});
