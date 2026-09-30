# pi-jev-tools

Cheap, bounded, typed judgment tools for [Pi](https://pi.dev), adapted from
IndyDevDan's **Ten Levels of Jev**, Levels 8–10. The primary tool is `ask_jev`;
all six tools load automatically from one extension entry point.

## Installation

```bash
pi install git:github.com/FetchUpstream/pi-jev-tools
```

Then run `/reload` or restart Pi. No individual `-e` files or upstream checkout
are needed. You can start Pi in any directory, including `/tmp`; file paths
resolve against **that Pi session's working directory**, not the package.

Requires Node **22.19+** and **Pi 0.99.1+**
(`@earendil-works/pi-coding-agent`); verified with Pi 0.99.1. Older Pi releases
using the previous `@mariozechner` package names are not targeted. Bun is only a
development dependency, not a runtime requirement.

For local development:

```bash
git clone https://github.com/FetchUpstream/pi-jev-tools
cd pi-jev-tools
bun install --frozen-lockfile --ignore-scripts
pi install .
```

Local installs reference the directory; Git installs use Pi's managed checkout.
There are **no third-party runtime dependencies** beyond Pi and TypeBox, which
Pi supplies as host peers. Development copies are not installed by Pi's managed
Git installer. To uninstall, use `pi remove git:github.com/FetchUpstream/pi-jev-tools`.

## Configuration

Set at least one credential in the environment **before launching Pi**:

```bash
export TYPESAFE_API_KEY="..."
# OR:
export OPENROUTER_API_KEY="..."
```

Default precedence: **TypeSafe first**, then OpenRouter. Optional
`JEV_BACKEND=typesafe` or `JEV_BACKEND=openrouter` selects one explicitly; a
missing key for the selected provider fails rather than falling back.

| Provider | Endpoint | Model |
|---|---|---|
| TypeSafe | `https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` |

These match the upstream core client. The demo's reporting wrapper hardcodes
OpenRouter; this package instead honors the documented core precedence and
supports both keys. Pi's `/login` credentials are **not** used for Jev; neither
are keys in settings files. `.env` files are not automatically loaded.

Without credentials, tools fail with:

```text
Jev is not configured. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY.
```

## Tools

| Tool | Contract | When Pi should use it |
|---|---|---|
| **`ask_jev`** | `questions_json`, optional `state`, `paths`, `command` → typed `answers`, `state_summary`, `model`, `usage` | Score a `git diff`'s risk, or classify a customer report with relevant files. |
| `ask_jev_files` | `paths_or_globs`, `questions_json`, optional `recursive` → `results`, `skipped`, `calls`, `attempts` | Find which `src/**/*.ts` files implement authentication without opening each one. |
| `pick_first_file` | `question`, `candidates: [{path, note?}]` → `path`, `confidence`, `probabilities` | Choose which surviving candidate to read first when fixing token validation. |
| `ask_jev_file_bool` | `path`, `question`, optional `yes`, `no` → `path`, boolean `answer`, numeric `noul`, `usage` | Check whether `src/auth/session.ts` validates tokens before reading it. |
| `ask_jev_file_choice` | `path`, `question`, `options: {name: description}` → `path`, `choice`, `confidence`, `probabilities`, `usage` | Classify a module as handler, domain logic or persistence. |
| `ask_jev_file_score` | `path`, `question`, `levels: string[]` → `path`, `score`, `top`, `nearest`, `confidence`, `legend`, `usage` | Rank a file's refactor risk on a concrete rubric. |

Single-file and batch questions refer to `content` (the text) and `path`.
For `ask_jev`, `paths` become `files["path"]`; `command` becomes
`output: {command, exit_code, stdout, stderr}`. Plain-text `state` becomes
`text`; JSON object strings preserve their field names, and JSON array strings
become `items`. Generated `files`/`output` fields take precedence over own state
fields with those names. File contents and command output never appear in the
returned result—only typed judgments and a small input summary.

`questions_json` is a **JSON string**, containing an object keyed by question id:

```json
{
  "relevant": {
    "type": "noul",
    "instructions": "Does `content` validate authentication tokens?",
    "criteria": {"true": "Checks token authenticity", "false": "Only transports tokens"}
  },
  "layer": {
    "type": "choice",
    "instructions": "Which layer is `content`?",
    "criteria": {"handler": "HTTP routing", "domain": "Business rules", "other": "Neither"}
  },
  "risk": {
    "type": "score",
    "instructions": "How risky is a refactor of `content`?",
    "criteria": ["Isolated and tested", "Several callers", "Security sensitive without tests"]
  }
}
```

- **noul**: probability of yes, `0..1`; the boolean building block returns true
  only when `noul > 0.5` (a tie is false).
- **choice**: 1–255 declared options, plus confidence and their probabilities.
  Provide an `other` exit. The single-file helper adds it if no `other`, `none`
  or `none_of_the_above` exists; the 255 limit includes that exit.
- **score**: 2–10 described situations ordered low to high; a weighted numeric
  position from `0` to `levels.length - 1`, not an arbitrary prose rating.

Example tool arguments for the primary tool:

```json
{
  "command": "git diff --stat",
  "state": "Assess whether this change needs a security-focused review.",
  "questions_json": "{\"review\":{\"type\":\"noul\",\"instructions\":\"Does `output` suggest security-sensitive changes?\"}}"
}
```

Ask all needed questions in one block; they share the input. Prefer `read` when
the primary model needs the actual content to edit, quote or reason further.
Use `grep` for exact strings/counts. Jev is not a chat interface or a substitute
for arithmetic. Probabilities are judgments, not guarantees.

### Limits and batch behavior

Upstream limits are retained: 240,000 bytes per file (60k tokens at the rough
four-characters/token estimate), 255 files per batch, 16 concurrent requests,
20 files per general call, 8,000 serialized characters of own state and a 60k
state-token estimate. The complete wire request also checks the shared 64k
estimate, including questions and JSON overhead. Overflow errors suggest
splitting or narrowing inputs; content is not silently truncated.

Globs use Node's `fs.promises.glob`; directories are nonrecursive for
`ask_jev_files` unless `recursive: true`, and recursive for `ask_jev`.
Files are deduplicated and sorted. Unmatched patterns are reported in `skipped`.
A failed file does not discard the other results. If all attempted judgments
fail, Pi receives an error result with the structured skipped reasons retained.
`calls` counts successful file judgments (upstream semantics); `attempts` also
counts failed attempted judgments, but not HTTP retries. `pick_first_file` uses up to 254 distinct
candidates plus `none`, and returns null for that exit or confidence below 0.3.
It trusts the caller's candidate list; it does not read or verify those files.

## Architecture

```text
Pi primary model → extension tool → Jev → small typed result → Pi primary model
```

`extensions/jev/index.ts` registers tools, strict TypeBox input/output schemas,
and a short `ask_jev` prompt guideline. `tools/` implements Levels 8–10;
`lib/` contains provider transport/validation, file handling, state assembly
and command safety. Node reads inputs internally, avoiding large file/output
blocks in the primary model's context and delegating bounded inference to Jev.

Requests have a 30-second total timeout and at most three attempts for upstream
retry statuses 429/502/503/529, with bounded backoff and cancellation. HTTP,
contract and network failures never switch providers. Only known response
fields are returned. Usage from completed requests, including command-gate calls,
is reported to Pi even when later execution fails. Only valid provider-reported
cost is counted; absent cost
is omitted from tool data and contributes zero to Pi totals, **not a price
estimate**. Failed requests may still incur provider charges not reported here.

## Security

- Credentials stay in environment variables and authorization headers. No
  keys, full inputs, raw responses or demo telemetry are written by this package
  to logs or session entries. Pi normally persists tool arguments/results:
  **never put secrets in state, question text, criteria or candidate notes**.
- File access is read-only and confined to the session working directory,
  including realpath checks for symlink escapes. All file tools filter `.git`,
  `node_modules`, `.sessions`, `dist`, `build`, `coverage`, `.pi`, empty files,
  known binary/`.lock` extensions and oversized files. Unknown binaries are
  rejected on a NUL byte in the first 8 KiB, matching upstream detection.
- Contents are sent to the selected remote provider. Filtering is not a secret
  detector: do not target `.env`, credentials, private data, or secret-containing
  Git history/diffs. Review the provider's data policy. Filesystem checks are
  not a sandbox against concurrent hostile filesystem changes.
- `command` does **not** invoke a shell. Only `git status`, `git diff`, `git log`,
  `git show` and `git ls-files` with restricted flags run via `execFile`.
  No scripts, tests/builds, installs, writes, network Git operations, arbitrary
  executables, shell expansion, escapes, pipes, redirects or chained commands.
  Absolute/parent-traversing operands and unsupported flags are refused.
- Allowed flags: status `--short/-s`, `--branch/-b`, `--porcelain[=v1|v2]`,
  `--untracked-files=no|normal|all`; diff `--stat`, `--numstat`, `--shortstat`,
  `--name-only`, `--name-status`, `--oneline`, `--color=never`, `--check`,
  `--cached`, `--staged`, `-w`, `--ignore-space-at-eol`,
  `--ignore-space-change`, `-U<number>`; log/show accept the common display
  flags through `--color=never`, plus `-n<number>`/`--max-count=<number>`;
  log additionally `--all`, `--decorate`, `--no-decorate`, `--reverse`,
  `--no-merges`; show additionally `--check`, `-U<number>`; ls-files
  `--cached`, `--modified`, `--others`, `--exclude-standard`, `--stage`,
  `--unmerged`, `--eol`, `--full-name`. All accept `--` and ordinary relative
  paths/revisions. Simple quotes group spaces; Git pathspec expansion is disabled.
- Before execution, the extracted Level 6 Jev gate must also approve a
  **read_only** effect. Original thresholds block irreversible confidence
  ≥0.6 or destructive probability ≥0.7. Gate errors fail closed. A permitted
  command costs an extra Jev call. A refusal is final, not something to bypass.
- Commands do not inherit API keys or Git environment overrides. Git pagers,
  external diff/textconv, fsmonitor, hooks, global/system config and optional
  index locks are disabled. Capture timeout is 60 seconds, buffer 800kB,
  maximum stdout/stderr 200,000 characters each (upstream values); overflow
  is refused, not truncated. Git and PATH must be trusted. This is a safety
  policy, not an OS sandbox, and it does not modify Pi's visible bash tool.
  Use visible bash for tests/scripts, then a short state summary if needed.

## Development and verification

```bash
bun install --frozen-lockfile --ignore-scripts
bun test                     # mocked/offline; never consumes paid API calls
bun run typecheck
bun run verify:pi            # requires installed pi and Git, no paid model
bun run test:integration     # EXPLICIT opt-in: one small real Jev request
```

The integration script lives outside `tests/`, refuses execution without
`JEV_LIVE=1`, and skips if no Jev credentials exist. Never set real keys in test
source. Unit tests inject offline transports or replace fetch and isolate keys.

`verify:pi` uses isolated temporary Pi configurations and a loopback scripted
primary model to issue real tool calls through **Pi's normal Node CLI** from
`/tmp`. It installs locally, then exercises the exact
`git:github.com/FetchUpstream/pi-jev-tools` parser/clone/dependency-install path,
using a temporary Git URL rewrite to the local committed repository. It proves
all six tools are automatically registered/declared, the prompt guideline is
present, all six reach the intended missing-credential error, and managed
installs contain no duplicate Pi/TypeBox copies. No `-e`, upstream checkout,
GitHub push or changes to your real Pi settings are involved. This verifies
Git package shape, not remote publication/access.

Verified with Pi 0.99.1, Node 25.0.0 and Bun 1.3.7: **75 unit tests pass**,
TypeScript checks pass, and both installed CLI-session checks pass. Live Jev
verification was skipped because no supported provider credentials were present.

## Differences from the demo

- One automatically discovered, typed Pi package entry point instead of three
  manually loaded extensions; current Pi prompt guidelines replace wholesale
  system-prompt rewriting and unverifiable price/latency claims.
- Both upstream providers and core precedence; no production mock backend.
- No full-state stderr/session telemetry, UI hooks or assumed-price spend ledger.
- File safeguards also apply to single-file tools; workspace symlink confinement,
  explicit empty-pattern reasons, stable skipped ordering and attempted counts.
- More restrictive read-only command policy plus the original judgment gate;
  no hidden shell or test-script execution, and no truncated command output.
- Strict input/response boundaries, shared wire-budget validation, cancellation,
  duplicate-candidate handling and a reserved `none` exit check.

## Attribution

Derived from [Dan Disler (IndyDevDan)'s Ten Levels of Jev](https://github.com/disler/ten-levels-of-jev),
inspected at commit `777adaf47d37ae0553220d35b2f15b3a3a063305`. Upstream is
MIT-licensed. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for the retained copyright/permission notice and exact source files. No Vue demo,
presentation assets or unrelated levels are included.
