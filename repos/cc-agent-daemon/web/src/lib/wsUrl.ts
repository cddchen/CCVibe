export function defaultWsBase(
  loc: { protocol: string; hostname: string; port?: string } = location,
  opts?: { viteDevPort?: string },
): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  const viteDevPort = opts?.viteDevPort ?? "5174";
  if (loc.port === viteDevPort) {
    return `${proto}//${loc.hostname}:${loc.port}`;
  }
  return `${proto}//${loc.hostname}:4733`;
}

export function buildWsUrl(base: string, token: string): string {
  let b = base.trim().replace(/\/+$/, "");
  if (!b.includes("/ws")) b = `${b}/ws`;
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${b}${q}`;
}
