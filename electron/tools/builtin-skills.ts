import type { SkillEntry } from '../../src/shared/types';

export const BUILTIN_SKILLS: SkillEntry[] = [
  {
    id: 'builtin-skill-creator',
    name: 'skill-creator',
    description:
      'Design and write reusable SmolCode SKILL.md workflows with crisp triggers, actionable steps, and optional references via save_skill.',
    sourcePath: 'builtin://skill-creator/SKILL.md',
    scope: 'builtin',
    tags: ['meta', 'workflow', 'skills'],
    content: `## Purpose
Create or refine reusable workspace or global skills so SmolCode becomes faster and more accurate on recurring tasks.

## When to Create a Skill
- The user explicitly asks to turn a workflow, convention, or prompt into a skill.
- You discovered non-obvious project conventions, build/test commands, or domain invariants that future turns should reuse.

## Authoring Rules
1. Pick a short lowercase kebab-case slug (e.g. \`api-error-conventions\`, \`prisma-migrations\`).
2. Write a trigger-rich 1-sentence \`description\` stating **when** the agent should load the skill.
3. Keep \`content\` structured and token-compact for local models:
   - **When to Use** (2-3 bullets)
   - **Key Files & Commands** (exact paths/scripts verified in the workspace)
   - **Step-by-Step Workflow** (imperative numbered steps referencing SmolCode tools like \`read_symbol\`, \`patch_hashline\`, \`run_command\`)
   - **Verification & Pitfalls** (what must pass before \`finish_turn\`)
4. Use \`scope: "repo"\` for project-specific skills (\`.smolcode/skills/<slug>/SKILL.md\`) and \`scope: "global"\` for cross-project engineering workflows (\`~/.smolcode/skills/<slug>/SKILL.md\`).
5. Put bulky schemas, checklists, or long examples inside \`companionFiles\` (e.g. \`references/checklist.md\`) so \`SKILL.md\` stays crisp and progressive disclosure saves context.
6. Call \`save_skill\` once ready, then summarize the saved skill path and how to invoke it with \`/<slug>\`.`,
  },
  {
    id: 'builtin-bug-triage',
    name: 'bug-triage',
    description:
      'Systematic root-cause isolation workflow: locate symbols, reproduce failure, apply minimal anchored fix, and verify.',
    sourcePath: 'builtin://bug-triage/SKILL.md',
    scope: 'builtin',
    tags: ['debugging', 'diagnostics'],
    content: `## Workflow
1. **Locate:** Use \`repo_search\` or \`find_files\` to pinpoint the failing symbol or error message.
2. **Inspect Anchors:** Read the exact function via \`read_symbol\` or bounded \`read_range\` (note \`line:hash|\` anchors).
3. **Reproduce:** Run the narrowest failing test or check via \`run_command\` before editing so you have a baseline failure signal.
4. **Root Cause:** Identify why the invariant broke (null/edge input, off-by-one, async race, stale cache, bad type assumption)—never mask symptoms.
5. **Minimal Fix:** Patch surgically with \`patch_hashline\` (preferred) or \`patch_file\`, keeping diff minimal.
6. **Verify:** Re-run the targeted test, typecheck/lint, and full relevant checks before \`finish_turn\`.`,
  },
  {
    id: 'builtin-test-authoring',
    name: 'test-authoring',
    description:
      'Write deterministic, isolated unit and integration tests (Vitest, pytest, Cargo) without network or global state leaks.',
    sourcePath: 'builtin://test-authoring/SKILL.md',
    scope: 'builtin',
    tags: ['testing', 'quality'],
    content: `## Principles
1. Inspect existing tests in the repo via \`find_files\` (\`*test*\` / \`*spec*\`) and \`read_range\` to match runner, assertion style, and cleanup helpers.
2. **Isolation:** Use temporary directories (\`mkdtempSync\` / \`tmp_path\`), in-memory DBs (\`:memory:\`), or local loopback mock HTTP/stdio servers; always clean up resources in \`afterEach\` / \`finally\`.
3. **Behavioral Coverage:** Assert real contracts—happy path, boundary/empty inputs, error/denial paths, and state transitions—not trivial mocks.
4. **Run & Confirm:** Execute the newly added test file directly via \`run_command\` and confirm 100% pass with zero warnings before \`finish_turn\`.`,
  },
  {
    id: 'builtin-code-review',
    name: 'code-review',
    description:
      'Audit modified files or subsystems for correctness, edge cases, security boundaries, concurrency bugs, and missing tests.',
    sourcePath: 'builtin://code-review/SKILL.md',
    scope: 'builtin',
    tags: ['review', 'security', 'audit'],
    content: `## Review Checklist
1. **Scope:** List target files with \`list_dir\` / \`find_files\` and inspect symbols with \`read_symbol\` / \`read_range\`.
2. **Correctness & Edge Cases:** Check boundary inputs, error handling, resource cleanup (timers, watchers, child processes, file handles), and async race conditions.
3. **Security & Sandboxing:** Verify workspace path confinement, command/URL validation, and approval policy enforcement.
4. **Performance & Context:** Flag blocking sync I/O on hot paths, unbounded caches, or duplicated logic.
5. **Actionable Output:** Report concrete findings with \`file:line\` references, severity, and minimal fix recommendations.`,
  },
  {
    id: 'builtin-grill-me',
    name: 'grill-me',
    description:
      'Relentlessly interview the user about a plan, architecture, or design decision using request_user_input until every branch of the decision tree is resolved.',
    sourcePath: 'builtin://grill-me/SKILL.md',
    scope: 'builtin',
    tags: ['planning', 'architecture', 'interview'],
    content: `## Purpose
Stress-test a plan, design, or requirement before writing code by walking down every unsettled branch of the decision tree until you and the user reach shared understanding.

## Rules
1. **Inspect Codebase First:** Before asking any question, use \`repo_search\`, \`find_files\`, \`read_symbol\`, or \`read_range\` to verify every fact you can derive from the codebase yourself. Never ask the user about file paths, existing symbols, or current architecture you can inspect directly.
2. **Use \`request_user_input\`:** Present focused rounds (1–3 high-signal questions via \`questions[]\`) rather than prose lists. Provide 2–4 concrete options per question, placing your recommended option first prefixed with \`(Recommended)\`.
3. **Resolving Branches:** Cover requirements, data/state flow, edge cases, failure/rollback semantics, UI states, and verification criteria—resolving dependencies one frontier at a time.
4. **Hold Execution Until Aligned:** Keep interviewing until all meaningful design decisions are resolved; summarize the agreed decisions clearly before proposing a plan or editing files.`,
  },
];
