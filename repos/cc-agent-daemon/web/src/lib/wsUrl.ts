export function defaultWsBase(loc: { protocol: string; hostname: string } = location): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.hostname}:4733`;
}

export function buildWsUrl(base: string, token: string): string {
  let b = base.trim().replace(/\/+$/, "");
  if (!b.includes("/ws")) b = `${b}/ws`;
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${b}${q}`;
}
