# Plan: Add `hello world` to first line of `readme.md`

## Context
The user requested: “修改readme.md，增加hello world在第一行” — update the repository-root `readme.md` so that `hello world` appears as the first line. The existing document currently starts with the heading `# 仓库现状说明`, so the intended outcome is to prepend a new line before the current content without otherwise changing the README.

## Recommended approach
1. Modify `/Users/cdd/Documents/cc/readme.md` by inserting this exact line at the very top:
   ```text
   hello world
   ```
2. Keep the existing README content unchanged after that line. The beginning of the file should become:
   ```markdown
   hello world
   # 仓库现状说明
   ```

## Critical files to modify
- `/Users/cdd/Documents/cc/readme.md`

## Reuse / existing patterns
No code utilities or project patterns are needed; this is a direct Markdown text prepend.

## Verification
1. Read the first few lines of `/Users/cdd/Documents/cc/readme.md` after editing.
2. Confirm line 1 is exactly `hello world`.
3. Confirm the prior first line `# 仓库现状说明` remains immediately after it and the rest of the file is unchanged.
