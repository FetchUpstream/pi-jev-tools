# Third-party notices

Portions of this package are derived from or adapted from **Dan Disler
(IndyDevDan)**'s [Ten Levels of Jev](https://github.com/disler/ten-levels-of-jev),
MIT licensed, inspected at commit `777adaf47d37ae0553220d35b2f15b3a3a063305`.

Copyright (c) 2026 IndyDevDan / AgenticEngineer.com

The upstream copyright and full MIT permission notice are preserved in LICENSE.
This package does not claim original authorship of the upstream implementation.

Relevant upstream files (relative to `apps/ten-levels/`):

- `extensions/ask-jev.ts`, `extensions/ask-jev-files.ts`, `extensions/ask-jev-file.ts`:
  tool contracts and instructions, adapted into the single package entry point.
- `src/core/client.ts`: provider endpoints, models, retry behavior and response
  validation; adapted into `lib/client.ts`, `lib/config.ts`, `lib/response.ts`.
- `src/core/types.ts`: wire contracts and validation, extracted into `lib/types.ts`.
- `src/core/helpers.ts`: question construction, adapted into the tools and bash gate.
- `src/levels/level08/{read-state,ask-file-bool,ask-file-choice,ask-file-score}.ts`:
  file budgets and single-file typed results, adapted into `lib/files.ts` and tools.
- `src/levels/level09/{prune,ask-files,pick-first}.ts`: discovery, filtering,
  bounded concurrency and candidate selection, adapted into the file library/tools.
- `src/levels/level10/{ask,assemble,tool-description}.ts`: question/state parsing,
  assembly, split suggestions and delegation instructions.
- `src/levels/level06/bash-gate.ts`: extracted internal command judgment gate.

Also inspected: the above levels' `index.ts` barrels, Level 6 `write-gate.ts` and
`result-screen.ts`, core `mock.ts`, `extensions/report.ts`, and Level 10 `spend.ts`.
These are not needed by the extracted runtime: mock/demo telemetry, unrelated
hooks and assumed-price ledger are intentionally omitted.

Pi and TypeBox are supplied by the host, not bundled. Development dependency
licenses remain with their respective packages.
