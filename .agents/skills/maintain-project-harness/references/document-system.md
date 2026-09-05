# Harness documentation system

Read this reference for every use of the skill. A “harness document” is not one universal file. It is a set of knowledge artifacts with different audiences, authority, and decay rates.

## Core distinction

| Artifact | Primary question | Nature | Update trigger |
| --- | --- | --- | --- |
| `harness.md` | How does this project's agent/application harness actually work now? | Descriptive synthesis and evidence map | SDK/runtime/ownership/protocol/test-harness change, or demonstrated drift |
| `AGENTS.md` | What must an agent do or avoid while changing this scope? | Normative working contract | Durable workflow, ownership, safety, validation, or release rule changes |
| `CONTEXT.md` | What do terms mean, how do objects relate, and why was a contract chosen? | Glossary + relationship map + decision ledger | A concept, mapping, or resolved ambiguity changes |
| `roadmap.md` | Where is the architecture going, in what dependency order, and what is out of scope? | North star + phases + exit criteria | Scope, dependency order, phase status, or non-goal changes |
| `phaseN-plan.md` | Can an agent with no prior conversation execute one bounded phase? | Handoff plan and later implementation record | Before implementation; after implementation add deviations/evidence |
| `smoke.md` / runbook | Can an operator prove the live system still works? | Executable manual/semiautomatic procedure | Boot path, UI flow, flags, scripts, logs, expected evidence, or teardown changes |
| Architecture/API/protocol doc | What public seam or externally visible contract exists? | Current contract reference | Wire/API/schema/ownership change |
| ADR/decision note | Why was one consequential choice selected over alternatives? | Immutable decision record with supersession | A new decision or explicit supersession |
| Test README | Which test layer owns a behavior and how are fixtures/lifecycles managed? | Contributor runbook for a test harness | Test tiers, runners, fixture modes, isolation, or CI gates change |
| Package README | How does a user/operator install, run, configure, and package this deliverable? | Quick-start and operational surface | CLI, config, supported platform, artifact, or deployment change |
| Specialized docs | How does one bounded subsystem work? | Focused operational/technical reference | That subsystem changes |

Examples of specialized documents in the VS Code Agent Host include local endpoint discovery and OTel pipeline docs. They are intentionally separate because their schemas, security, lifecycle, and operator audience would overwhelm the root collaboration rules.

## What VS Code Agent Host demonstrates

The reference tree at `src/vs/platform/agentHost` illustrates a mature document system. Transfer the pattern, not its product details.

### Root AGENTS.md: living architecture contract

The root file is more than a style guide. It records:

- the mental model and ownership split among SDK conversations, chats, and orchestrator sessions;
- hard invariants such as opaque provider data, non-overloaded identities, a single catalog path, restore ownership, and typed host seams;
- capability flow instead of provider-specific switches;
- lifecycle diagrams and per-provider asymmetries;
- implementation status where the target contract and the current migration state differ.

The transferable lesson is to document ownership boundaries and load-bearing invariants close to the code. Do not copy VS Code's class names, URI schemes, provider list, or persistence keys into another project.

### Nested AGENTS.md: narrow scoped constraints

VS Code uses nested files only where the subtree has a real extra contract:

- `common/state/AGENTS.md` explains generated protocol ownership, version registries, synchronization from a sibling source repo, and what must not be edited directly.
- `test/node/AGENTS.md` adds one local test invariant: session database tests use an in-memory database.

This is the right threshold for nesting: a subtree-specific rule that would be noisy or misleading globally. Repeating the root file in every directory is not useful.

### CONTEXT.md: mapping catalogue and design memory

The Claude `CONTEXT.md` combines:

- a shared glossary;
- relationship diagrams;
- flagged ambiguities;
- detailed mappings between a stable host interface and a volatile SDK surface;
- lifecycle axes, configuration mutability, replay/live asymmetries, invariants, and open questions;
- a chronological decision log that preserves why earlier proposals were replaced.

Its strength is retaining reasoning that cannot be recovered from types alone. Its risk is age: early sections can be superseded later in the same file. A harness audit must find the latest decision and verify production code/tests before treating a CONTEXT claim as current.

### Roadmap: stable navigation, not the final truth

The Claude roadmap supplies a north star, target architecture, reference implementations with caveats, phase dependencies, exit criteria, open questions, and explicit non-goals. Phase numbers are stable references even when delivery order changes.

Roadmaps decay because versions, status badges, workarounds, and planned APIs can be overtaken by implementation. Use them to understand intent and sequencing; use types/code/tests to state current behavior.

### Phase plans: zero-context handoff plus retrospective

The strongest phase plans explicitly say that an agent with no prior conversation should be able to execute them. They include:

- goal, scope and non-goals;
- exact files/symbols and verified references;
- dependency and ordering constraints;
- decisions that should not be reopened without new evidence;
- tests, manual validation and exit criteria;
- implementation notes and deviations after landing.

Some VS Code phase plans openly mark earlier designs as historical or superseded. Preserve this provenance. A phase plan is a scoped snapshot and rationale source, not authority over later production behavior.

### Smoke plan: live-system proof and evidence capture

The smoke plan names when it must run, prerequisites, launch and teardown, expected logs/UI state, negative assertions, screenshots/artifacts, and common failure diagnosis. It closes the gap between isolated tests and the real boot/auth/subprocess/UI path.

A smoke doc is valid only if its flags, helper scripts, selectors, log locations, expected phases, and cleanup commands still exist. An unexecutable runbook is historical evidence, not a release gate.

### Test-harness READMEs: test taxonomy and lifecycle

The reference test docs distinguish:

- in-process unit tests;
- protocol/conformance tests over the public wire;
- provider integration with a synthetic model boundary;
- deterministic E2E with the real Host and provider subprocess but replayed model traffic;
- live record/update modes that require credentials.

They also own fixture normalization, secret removal, server leases, teardown, coverage interpretation, known issues, and the rule that shared tests must drain active turns. These details belong near the test harness rather than in a general AGENTS file; AGENTS should only preserve the tier-selection and safety rules that affect everyday decisions.

## harness.md as the index across the system

When a repository does not already have a conventional harness document, use root `harness.md` as the high-signal synthesis. It should not replace every artifact above. It should explain:

1. what the harness surrounds and why it exists;
2. actual entrypoints and the composition chain;
3. layer ownership and forbidden reverse dependencies;
4. identity and source-of-truth distinctions;
5. startup, materialization/request, cancellation, restore/rebind, and shutdown lifecycles;
6. configuration/options convergence and SDK type boundary;
7. live and replay mapping, state publication, concurrency, and persistence;
8. permissions/security and external interfaces;
9. the surrounding document map with authority and known drift;
10. unit/integration/E2E/smoke coverage and explicit gaps.

This file should answer “where do I verify or change this?” It is not the place for every code style rule, packaging command, UI pixel requirement, or abandoned implementation transcript.

## Knowledge ownership and anti-duplication

Assign every durable fact one primary owner:

| Fact | Preferred owner |
| --- | --- |
| Current runtime wiring and lifecycle synthesis | `harness.md` |
| Mandatory agent behavior | `AGENTS.md` |
| Term definition or cross-object relationship | `CONTEXT.md` or current architecture doc |
| Public request/response field | schema/API/protocol doc |
| One architecture decision and rejected alternatives | ADR/decision log |
| Future phase/dependency/non-goal | roadmap |
| One phase's exact handoff and deviations | phase plan |
| Exact live verification steps and evidence | smoke/runbook |
| Fixture/test-runner mechanics | nearest test README |
| Install/run/configure/package instructions | package README |

Other documents should link to the owner and summarize only what their audience needs. Duplication without ownership produces contradictory “truths” and makes agent collaboration worse.

## Source precedence and uncertainty

Documentation cannot override executable reality. A useful default precedence is:

```text
applicable user/repository instruction
  → installed type/schema/generated contract
  → production code and manifests
  → tests and observed runtime results
  → current architecture/API/context docs
  → roadmap/phase/smoke/history/reference project
```

Do not hide uncertainty. Label a claim as one of:

- **verified current** — code/type/test or current runtime proves it;
- **documented current** — a current doc claims it, but runtime was not exercised;
- **planned** — target behavior not yet proven;
- **historical/superseded** — useful rationale but not current behavior;
- **open** — unresolved or conflicting evidence.

This labeling is more useful to a future agent than confident prose built on stale line citations.
