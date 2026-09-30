export const JEV_POLICY_MARKER = "## Jev usage policy";

export const JEV_USAGE_POLICY = `${JEV_POLICY_MARKER}
Proactively use Jev for bounded semantic judgments when it saves primary-model reasoning or avoids loading unnecessary context; do not wait for the user to request Jev.
Tool-selection priority: deterministic cheap operation > Jev bounded semantic judgment > primary-model semantic reasoning.
Prefer Jev for semantic yes/no judgments, classification, relevance checks, risk assessment, confidence estimates, scoring against explicit scales, choosing between known options, filtering candidate files, deciding which files are worth reading, checking whether files contain or implement a concept, triaging large groups of files, and judging command output or repository state.
Question types:
- Prefer noul for filtering: Is this file relevant or worth inspecting? Does it appear to contain X? Is this change security-sensitive?
- Prefer choice for categories: Which category, risk bucket, subsystem or candidate best fits?
- Use score only when continuous ordinal position on an ordered scale is useful, not merely because three risk levels exist. Ordinary repository triage should use noul or choice.
Repository exploration:
- Need candidate files → deterministic search/find/glob.
- Need semantic filtering of candidates → ask_jev_files before reading the candidate corpus.
- Need a bounded judgment about one file → ask_jev_file_bool / ask_jev_file_choice / ask_jev_file_score.
- Need exact implementation details → read the selected file with the primary model.
Treat Jev findings as triage or hypotheses, not proof. Before reporting a code defect as confirmed, inspect the selected source and verify with deterministic evidence (reproduction, test, compiler/type-checker, parser, grep or another exact tool) where practical. Read only the narrowed candidate set, not the entire corpus again.
For partial batch failures, keep successful judgments. Retry only affected files with another bounded question form if useful; do not rerun successes or endlessly retry Jev.
Use grep, a parser, compiler, test, type checker or another deterministic tool when it answers exactly; do not call Jev unnecessarily. Do not use Jev for code generation, code editing or complex multi-step reasoning.
Prefer passing paths or command to ask_jev instead of first loading their contents into primary-model context; command safety restrictions still apply. Batch multiple questions about the same state into one Jev request where possible.`;
