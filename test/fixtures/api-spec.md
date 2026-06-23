# Orders API — Requirements

This document phrases its acceptance criteria in plain prose (no checklist
checkboxes) to exercise phrasing-variation robustness. Each line still carries a
deterministic check directive.

## Requirements

- The package must define a build script <!-- check: npm-script name="build" -->
- Orders must be creatable via a `POST /orders` endpoint <!-- check: route-exists path="/orders" method="post" -->
- A `calculateTotal` helper has to be exported for reuse <!-- check: export-exists name="calculateTotal" -->
- The schema file should reference the term "discount" at least twice <!-- check: grep pattern="discount" flags="i" min="2" -->
- The README must explain authentication <!-- check: file-exists path="README.md" -->
- The API ought to feel ergonomic and consistent for downstream consumers
