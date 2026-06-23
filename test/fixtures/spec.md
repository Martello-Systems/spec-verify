# Widget Service — Acceptance Criteria

The deliverable is a small Node service. The following criteria must all hold.

## Acceptance Criteria

- [ ] A README documents how to run the service <!-- check: file-exists path="README.md" -->
- [ ] The service exposes a health endpoint at /health <!-- check: route-exists path="/health" -->
- [ ] A `createWidget` function is exported from the source <!-- check: export-exists name="createWidget" -->
- [ ] The codebase references the word "widget" somewhere <!-- check: grep pattern="widget" flags="i" -->
- [ ] The project ships a passing test suite <!-- check: npm-script name="test" -->
- [ ] The service should be friendly and well documented in spirit
