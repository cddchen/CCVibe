import { useTheme } from "../context/ThemeContext";

export function ThemeToggle() {
  const { preference, resolved, cycleTheme } = useTheme();
  const icon = preference === "system" ? "◐" : resolved === "dark" ? "☾" : "☀";
  const label = `切换主题，当前 ${preference === "system" ? "跟随系统" : preference === "dark" ? "深色" : "浅色"}`;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={cycleTheme}
      className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200/70 bg-white/75 text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/75 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      <span aria-hidden="true" className="text-base leading-none">{icon}</span>
    </button>
  );
}
