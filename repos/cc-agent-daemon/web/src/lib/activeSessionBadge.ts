import type { ActiveKind } from "../hooks/useActiveSessions";

export function activeBadgeLabel(kind: ActiveKind): string {
  return kind === "running" ? "对话中" : "活跃";
}

export function activeBadgeClassName(kind: ActiveKind): string {
  if (kind === "running") {
    return "shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-950/50 dark:text-violet-300";
  }
  return "shrink-0 rounded-full bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
}