---
name: maintain-project-harness
description: Research a repository and its reference implementations, then create, audit, or refresh harness.md and AGENTS.md as durable agent-collaboration knowledge. Use when a project lacks these files, when they may be stale after architecture or SDK changes, or when asked to turn implementation history into reusable rules. Do not use for ordinary feature docs or a one-off code explanation.
---

# Maintain Project Harness

Build a small, evidence-backed documentation system that lets a future agent enter the repository without relying on the original conversation.

`harness.md` and `AGENTS.md` have different jobs:

- `harness.md` is descriptive: how the runtime, adapters, state, lifecycle, tests, and surrounding documents actually work, including drift and unresolved questions.
- `AGENTS.md` is normative: the compact rules future agents must follow while changing the project.

Write or update the harness first. Derive AGENTS rules only from verified, durable facts.

## Start safely

1. Resolve the target repository root. Read every already-applicable `AGENTS.md`, `CLAUDE.md`, or equivalent instruction file before other project work.
2. Inspect the worktree. Treat existing changes as user work; never reset, overwrite, stage, commit, or publish them unless explicitly asked.
3. Run the inventory helper when Python is available:

   ```bash
   python3 <skill-dir>/scripts/inventory_project.py <project-root> --format markdown
   ```

   The inventory is a lead, not proof. Read the files that own the relevant behavior.
4. Read [references/document-system.md](references/document-system.md) completely. It defines each document's role, authority, and update boundary.
5. Select the operating mode:
   - If both files are absent, read [references/blueprints.md](references/blueprints.md) and create both.
   - If either file exists, read [references/audit-checklist.md](references/audit-checklist.md), preserve useful content, and update only demonstrated drift. Also read the blueprint for any missing file you create.

## Build an evidence ledger

Gather enough evidence to answer five questions before editing:

1. What executable or application is the harness around?
2. Which layer owns identity, state, persistence, configuration, side effects, and UI?
3. What is the actual startup, request/turn, cancellation, restore, and shutdown lifecycle?
4. Which type/schema/code/test is authoritative when documents disagree?
5. Which commands genuinely validate unit, integration, end-to-end, smoke, packaging, and release behavior?

Use this evidence order unless the repository proves a more specific one:

1. User instructions and already-applicable repository rules.
2. Installed SDK/library types and generated schemas.
3. Current production code and manifests.
4. Tests and observed runtime/build results.
5. Current architecture/API/context documents.
6. Roadmaps, phase plans, smoke notes, conversation history, and reference implementations.

Record claims as `fact → owner → strongest source → confidence → drift/action`. Conversation and task history are useful for recovering repeated user intent and past failures, but are not proof of current code. Verify their claims before making them hard rules.

For an SDK or external harness integration, inspect the installed `.d.ts`, the options/configuration convergence point, runtime lifecycle, mapper boundaries, persistence seam, and tests. If a reference repository is supplied, treat it as read-only inspiration and state which ideas transfer and which are project-specific.

## Maintain the document system

### harness.md

Create or update a repository-root `harness.md` unless the user names another location. It should let a future agent understand current behavior and know where to verify it.

- Separate current implementation, reference insight, planned work, and open questions.
- Explain ownership and data flow, not just list files.
- Name lifecycle and concurrency invariants that are easy to break.
- Include a document-role/authority table and a test-harness map.
- Cite repository-relative files and stable symbols. Add line numbers only after verifying them and only when they materially help.
- Mark stale or superseded material instead of silently rewriting history.
- Do not paste SDK manuals, large code blocks, every type, or a chronological task diary.

### AGENTS.md

Create or update the root `AGENTS.md` from the verified harness.

- Keep scope, source precedence, repository map, hard ownership/layering rules, lifecycle and state invariants, testing commands, safety, workflow, and completion checks.
- Prefer rules that change future decisions. Exclude generic advice the agent already knows.
- Do not copy framework, product, command, path, version, or policy details from a reference project unless they are true here.
- Do not convert every historical bug into a universal rule. Promote a lesson only when it expresses a recurring ownership, protocol, lifecycle, safety, UI, or release invariant.
- Avoid contradictory nested rules. Use nested `AGENTS.md` only when a subtree genuinely has additional constraints; otherwise keep one root file.
- Preserve user-authored rules and tighten wording rather than replacing the document wholesale.

Do not create CONTEXT, roadmap, phase-plan, smoke, ADR, or testing README files by default. Identify the missing knowledge owner in the report; create another document only when the user requests it or the repository clearly needs that distinct lifecycle.

## Validate

Before finishing:

1. Re-read both documents as a fresh agent and check that descriptive facts and normative rules are not mixed.
2. Verify every named file, script, package command, manifest field, SDK version, and test location against the current tree.
3. Search for stale copied names, absolute reference-project paths presented as local facts, unresolved template markers, secrets, and contradictory statements.
4. Run the repository's documentation linter if one exists, then `git diff --check` and inspect the final diff/status.
5. Do not run expensive builds merely because Markdown changed. Run code tests only if the documentation change also modifies executable helpers or the repository explicitly gates docs through them.
6. If this skill itself was created or changed, run:

   ```bash
   python3 <skill-creator-dir>/scripts/quick_validate.py <skill-dir>
   ```

   Also execute any new helper script against at least one representative repository.

Report:

- files created or updated;
- the main ownership/invariant conclusions captured;
- evidence inspected and validation performed;
- unresolved drift or facts that still need runtime verification;
- confirmation that unrelated user changes were preserved.
