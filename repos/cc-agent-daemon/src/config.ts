import { homedir } from "node:os";
import { join } from "node:path";

export type DaemonConfig = {
  host: string;
  port: number;
  dataDir: string;
  token: string | null;
  insecureNoAuth: boolean;
};

const DEFAULT_PORT = 4733;

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

export function parseArgs(argv: string[]): DaemonConfig {
  let host = "127.0.0.1";
  let port = DEFAULT_PORT;
  let dataDir = join(homedir(), ".cc-agent-daemon");
  let token: string | null = process.env.CC_AGENT_DAEMON_TOKEN ?? null;
  let insecureNoAuth = false;

  const args = [...argv];
  while (args.length > 0) {
    const flag = args.shift();
    if (!flag) break;
    switch (flag) {
      case "--listen": {
        const value = args.shift();
        if (!value) throw new Error("--listen requires host:port");
        const [h, p] = value.includes(":") ? value.split(":") : [host, value];
        if (h) host = h;
        if (p) port = parsePort(p);
        break;
      }
      case "--port": {
        const value = args.shift();
        if (!value) throw new Error("--port requires a number");
        port = parsePort(value);
        break;
      }
      case "--data-dir": {
        const value = args.shift();
        if (!value) throw new Error("--data-dir requires a path");
        dataDir = value;
        break;
      }
      case "--token": {
        const value = args.shift();
        if (!value?.trim()) throw new Error("--token requires a non-empty value");
        token = value.trim();
        insecureNoAuth = false;
        break;
      }
      case "--insecure-no-auth":
        token = null;
        insecureNoAuth = true;
        break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  if (!token && !insecureNoAuth) {
    throw new Error(
      "Missing --token (or CC_AGENT_DAEMON_TOKEN). Use --insecure-no-auth for local dev only.",
    );
  }

  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
  if (!allowedHosts.has(host)) {
    throw new Error(
      `Unsupported bind host=${host}. Use 127.0.0.1 for local access or 0.0.0.0 with --token for LAN access.`,
    );
  }
  if (host === "0.0.0.0" && (insecureNoAuth || !token)) {
    throw new Error("LAN bind (0.0.0.0) requires --token; do not use --insecure-no-auth on the network.");
  }

  return { host, port, dataDir, token, insecureNoAuth };
}

export function usage(): string {
  return `cc-agent-daemon [--listen 127.0.0.1:4733] [--data-dir path] [--token token | --insecure-no-auth]`;
}