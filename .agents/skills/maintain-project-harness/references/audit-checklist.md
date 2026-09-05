# Audit and update checklist

Read this reference when either `harness.md` or `AGENTS.md` already exists.

## 1. Preserve before correcting

- Read the entire existing file, including comments, status headers, appendices, and implementation notes.
- Check git history when a strange rule may encode a past incident.
- Do not replace a mature document with a generic template.
- Preserve rationale and historical corrections. Mark superseded text or move it under a historical section only when that improves clarity.
- Keep user-authored policy unless it conflicts with a newer explicit user instruction or executable fact; surface such a conflict instead of silently deleting it.

## 2. Run a drift matrix

For each important claim, record:

| Claim | Document says | Code/type/test says | Classification | Update |
| --- | --- | --- | --- | --- |
| Example | Query closes after each result | Runtime keeps one query across turns | stale | Correct harness and any derived AGENTS rule |

Check at least these drift classes:

### Identity and ownership

- Are product session, chat/conversation, provider session, runtime/process, connection, turn, and command IDs still distinct?
- Does a provider re-derive host-owned facts from URI shapes or sibling state?
- Is there one catalog/membership/state owner, or have parallel paths appeared?

### SDK and configuration

- Does the installed SDK version match the document?
- Are option names and callback signatures taken from current `.d.ts`?
- Is there still one options/configuration convergence point?
- Which values are startup-only, hot mutable, deferred, or require rebind/restart?
- Are native settings/plugins/hooks loaded by the SDK, the host, or both?

### Lifecycle and concurrency

- Is creation eager or provisional?
- Does a turn/result end the request, the runtime, or both?
- Can cancellation bypass a queue safely?
- Is same-resource work serialized and different-resource work parallel?
- What happens on iterator end, crash, disconnect, idle eviction, restore, and shutdown?

### State, protocol, and persistence

- Are raw provider messages still hidden behind domain actions/signals?
- Do live and replay paths converge to equivalent state?
- Are snapshots and sequence cursors from one atomic cut?
- Is replay fallback behavior current?
- Has an overlay/cache accidentally become a second transcript/source of truth?
- Are receipts, migrations, and after-commit publication rules accurate?

### Test harness

- Do commands and file locations exist?
- Are test tier descriptions accurate?
- Are record/update modes explicit and credential-safe?
- Do fixtures remove secrets and volatile values?
- Does shared server/process reuse have complete teardown and drain rules?
- Are skipped tests and known gaps still true?

### Operations and UI

- Do startup flags, environment variables, ports, logs, selectors, screenshots, packaging scripts, and artifact paths exist?
- Does a bundle command differ from a native/package build?
- Are platform-specific and accessibility rules still supported by code and runtime evidence?

## 3. Decide where each correction belongs

- Correct `harness.md` when the current architecture, lifecycle, source precedence, document map, or test map changed.
- Correct `AGENTS.md` only when future agent behavior must change.
- Correct API/protocol docs when an external contract changed.
- Correct README when operator commands/configuration changed.
- Correct roadmap/phase status when the plan or delivery record changed.
- Correct smoke/test README when execution or evidence collection changed.
- Add an ADR when the decision and alternatives matter independently of the current implementation.

Do not duplicate the full correction everywhere. Update the primary owner and adjust short summaries/cross-links in consumers.

## 4. Quality review

- Can a new agent distinguish current behavior from target architecture?
- Can it identify the owner of each important fact without reading every source file?
- Are hard rules supported by evidence and scoped to this repository?
- Did any reference-project term, command, version, product name, or path leak in as local truth?
- Are line citations still correct? Remove low-value brittle citations.
- Are there secrets, tokens, usernames, private endpoints, or local device IDs?
- Are test results labeled with the run/date rather than stated as timeless counts?
- Are TODOs actionable and owned, rather than vague reminders?
- Is the root AGENTS file concise enough to load for every task?
- Would a narrow nested rule be clearer than another global rule?

## 5. Validation report

State separately:

- **Verified from code/type/schema**
- **Verified by automated tests/build**
- **Verified by live/manual runtime**
- **Documented but not rerun**
- **Open or conflicting**

Never upgrade “documented” to “verified” merely because another document repeats it.
