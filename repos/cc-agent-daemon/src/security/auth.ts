import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function loadOrCreateToken(dataDir: string, provided: string | null): string {
  if (provided) return provided;
  mkdirSync(dataDir, { recursive: true });
  const tokenPath = join(dataDir, "daemon.token");
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // create below
  }
  const token = generateToken();
  writeFileSync(tokenPath, token, { mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // windows may not support
  }
  return token;
}

export function validateToken(expected: string | null, presented: string | undefined): boolean {
  if (expected === null) return true; // insecure-no-auth
  if (!presented) return false;
  return timingSafeEqual(expected, presented);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function extractTokenFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url, "http://localhost");
    return u.searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}