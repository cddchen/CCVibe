export const HOME_EXPANDED_DIRS_KEY = "cc_web_home_expanded_dirs";
export const CHAT_SIDEBAR_OPEN_KEY = "cc_web_chat_sidebar_open";
export const CHAT_FOLLOW_OUTPUT_KEY = "cc_web_chat_follow_output";

export function readBooleanPreference(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function writeBooleanPreference(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, String(value));
}

export function readExpandedPreference(key: string): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  const value = window.localStorage.getItem(key);
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
  } catch {
    return {};
  }
}

export function writeExpandedPreference(key: string, value: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}
