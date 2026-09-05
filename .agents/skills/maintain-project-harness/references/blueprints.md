# Creation blueprints

Read this reference when creating a missing `harness.md` or `AGENTS.md`. Adapt headings to the project; do not emit empty sections or placeholders.

## harness.md blueprint

```markdown
# <Project/Subsystem> Harness

> Scope: ...
> Last verified: YYYY-MM-DD
> Evidence baseline: package/SDK/protocol versions or revision

## Executive summary
- What the harness surrounds
- Its composition chain
- The most important ownership boundary

## Evidence and authority
| Source | Role | Authority | Known drift |

## Terminology and identities
| Term/ID | Owner | Lifetime | Must not be confused with |

## Architecture and ownership
<small diagram>
| Layer | Owns | Does not own |

## Configuration and startup
- Entrypoints
- Central options/config builder
- Environment/credential boundary
- Provisional or lazy startup behavior

## Request/turn lifecycle
- Send/request path
- Streaming/result semantics
- Cancellation/interrupt
- Concurrency and sequencing

## Restore, persistence, and shutdown
- Authoritative history
- Overlay/cache data
- Resume/rebind/migration
- Cleanup order

## State and protocol flow
- Raw provider events → domain signals/actions → state → clients
- Snapshot/replay/ordering invariants
- Validation/security boundary

## Document map
| Document | Purpose | When to trust/update |

## Test harness
| Level | Boundary | Real/fake dependencies | Command | Gaps |

## Drift and open questions
- Verified mismatch
- Unverified runtime behavior
- Planned work kept separate from current behavior
```

Creation rules:

- Begin with a compact conclusion, not the research chronology.
- Prefer one small architecture or lifecycle diagram over many decorative diagrams.
- Use current symbols and repository-relative links. Avoid brittle line citations for frequently edited files.
- Record exact versions only when they affect compatibility, and include the verification date/source.
- Distinguish an SDK `result`/turn boundary from a process/query/session boundary when applicable.
- Explain both live and cold/replay paths when they differ.

## AGENTS.md blueprint

```markdown
# AGENTS.md

## Project and scope
- Deliverables and technical stack
- The one-sentence architecture
- Scope of this rule file

## Evidence precedence
1. ...

## Repository map
<only directories that affect agent decisions>

## Hard ownership and layering rules
- Source-of-truth boundaries
- Allowed dependency direction
- Identity distinctions
- Provider/SDK vs orchestrator vs client responsibilities

## Lifecycle, state, and concurrency invariants
- Startup/materialization
- Request/turn/completion
- cancel/rebind/restore/shutdown
- ordering/idempotency/multi-client behavior

## Type, code, and schema rules
- Strictness and external-input validation
- SDK/generated-code boundary
- Pure-function/stateful-shell boundary

## Security and persistence
- Credentials and logs
- Files/process/network boundaries
- Durable vs ephemeral state

## Testing and validation
| Change | Minimum evidence |
- Exact verified commands
- Unit/integration/E2E/smoke selection

## Build/release or UI rules
<include only if this repository owns them>

## Working-tree and delivery rules
- Preserve existing changes
- Commit/publish authority
- Final report expectations

## Completion checklist
- Short decision-oriented questions
```

Creation rules:

- A root file should usually be substantially shorter than the complete harness research.
- State hard rules with their owner or reason. Do not fill the file with preferences that have no project evidence.
- Put exact commands only after verifying them in manifests/scripts/CI.
- Avoid hardcoding current test counts, transient ports, personal device IDs, local credentials, or one person's filesystem path.
- A local absolute reference path may be listed as a read-only reference when the user explicitly relies on it, but never present its classes/config as local project fact.
- If a rule applies only to generated protocol files, database tests, a native platform, or another narrow subtree, consider a short nested `AGENTS.md` rather than burdening every task.

## Minimal document set

For a small repository, two files are often enough:

- `harness.md`: current architecture/evidence map;
- `AGENTS.md`: rules derived from it.

Add separate CONTEXT/roadmap/phase/smoke/test docs only when their update cadence and audience are genuinely different. More files are not automatically better knowledge management.
