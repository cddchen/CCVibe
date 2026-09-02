import { randomInt } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, chmodSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { get as getHttp } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatHostPort,
  runAgentHostCli,
} from '../server/start.js';
import { ConfigurationError } from '../server/config.js';

const RUNTIME_DIRECTORY_NAME = join('.cddchen', 'cloud');
const PID_FILE_NAME = 'server.pid';
const STATE_FILE_NAME = 'server.json';
const LOG_FILE_NAME = 'server.log';
const STARTUP_TIMEOUT_MS = 15_000;
const HEALTH_POLL_MS = 250;
const STOP_TIMEOUT_MS = 5_000;
const DAEMON_STATE_DIRECTORY_ENV = 'CCVIBE_CLOUD_DAEMON_STATE_DIR';

const USAGE = `Usage: cloud start [options]
       cloud stop
       cloud status

Commands:
  start              Start in the background (default)
  stop               Stop the background host
  status             Show background host status

Options:
  --token <token>    Bearer token; defaults to a printed random six-digit token
  --host <host>      Bind address; defaults to this machine's LAN IPv4 address
  --global           Bind every network interface (0.0.0.0)
  --port <port>      TCP port (default: 8787)
  --env <mode>       development, test, or production
  --foreground       Keep the host in the foreground
  --help, -h         Show this help message
`;

export type CloudCliEnvironment = Readonly<Record<string, string | undefined>>;

export interface CloudStartInvocation {
  readonly command: 'start';
  readonly background: boolean;
  readonly environment: CloudCliEnvironment;
  /** Present only when no token was provided through CLI or environment. */
  readonly generatedToken?: string;
}

export interface CloudStopInvocation {
  readonly command: 'stop';
}

export interface CloudStatusInvocation {
  readonly command: 'status';
}

export interface CloudHelpInvocation {
  readonly command: 'help';
}

export type CloudCliInvocation =
  | CloudStartInvocation
  | CloudStopInvocation
  | CloudStatusInvocation
  | CloudHelpInvocation;

export interface CloudCliParseOptions {
  readonly defaultLanHost?: () => string;
  readonly tokenGenerator?: () => string;
}

export class CloudCliError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CloudCliError';
  }
}

/**
 * Parse the public `cloud` command without mutating process.env. The default
 * bind is the active LAN address; --global is the explicit all-interface mode.
 */
export function parseCloudCli(
  arguments_: readonly string[],
  environment: CloudCliEnvironment = process.env,
  options: CloudCliParseOptions = {},
): CloudCliInvocation {
  const [command, ...argumentsAfterCommand] = arguments_;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help' };
  }
  if (command === 'stop') {
    requireNoOptions(argumentsAfterCommand, 'stop');
    return { command: 'stop' };
  }
  if (command === 'status') {
    requireNoOptions(argumentsAfterCommand, 'status');
    return { command: 'status' };
  }
  if (command !== 'start') {
    throw new CloudCliError('expected start, stop, or status; run cloud --help for usage');
  }
  if (argumentsAfterCommand.includes('--help') || argumentsAfterCommand.includes('-h')) {
    return { command: 'help' };
  }

  const startOptions = parseStartOptions(argumentsAfterCommand);
  const nextEnvironment: Record<string, string | undefined> = { ...environment };
  for (const [key, value] of Object.entries(startOptions.overrides)) {
    nextEnvironment[key] = value;
  }

  if (startOptions.global) {
    if (startOptions.overrides.CCVIBE_HOST !== undefined) {
      throw new CloudCliError('--global cannot be used with --host');
    }
    nextEnvironment.CCVIBE_HOST = '0.0.0.0';
  } else if (nextEnvironment.CCVIBE_HOST === undefined || nextEnvironment.CCVIBE_HOST.trim() === '') {
    nextEnvironment.CCVIBE_HOST = (options.defaultLanHost ?? resolveDefaultLanHost)();
  }

  const mode = nextEnvironment.CCVIBE_ENV ?? nextEnvironment.NODE_ENV ?? 'development';
  if (isAllInterfacesHost(nextEnvironment.CCVIBE_HOST) && (mode === 'development' || mode === 'test')) {
    // The typed CLI option is the explicit user acknowledgement required by
    // the configuration boundary for an all-interface development bind.
    nextEnvironment.CCVIBE_ALLOW_PUBLIC_DEV = 'true';
  }

  let generatedToken: string | undefined;
  if (nextEnvironment.CCVIBE_BEARER_TOKEN === undefined || nextEnvironment.CCVIBE_BEARER_TOKEN.trim() === '') {
    generatedToken = (options.tokenGenerator ?? createSixDigitToken)();
    nextEnvironment.CCVIBE_BEARER_TOKEN = generatedToken;
  }

  return Object.freeze({
    command: 'start',
    background: !startOptions.foreground,
    environment: Object.freeze(nextEnvironment),
    ...(generatedToken === undefined ? {} : { generatedToken }),
  });
}

/** Cryptographically random, human-enterable token used only when none is supplied. */
export function createSixDigitToken(): string {
  return String(randomInt(1_000_000)).padStart(6, '0');
}

/**
 * Choose a private IPv4 LAN address in preference to overlay/public adapters.
 * A machine with no active LAN adapter remains safely loopback-only.
 */
export function resolveDefaultLanHost(): string {
  const candidates: Array<{ readonly address: string; readonly priority: number; readonly name: string }> = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') {
        continue;
      }
      candidates.push({ address: entry.address, priority: ipv4Priority(entry.address), name });
    }
  }
  candidates.sort((left, right) => left.priority - right.priority
    || left.name.localeCompare(right.name)
    || left.address.localeCompare(right.address));
  return candidates[0]?.address ?? '127.0.0.1';
}

/** Runs one parsed public CLI command. */
export async function runCloudCli(
  arguments_: readonly string[] = process.argv.slice(2),
  environment: CloudCliEnvironment = process.env,
  stdout: Pick<NodeJS.WriteStream, 'write'> = process.stdout,
): Promise<void> {
  const invocation = parseCloudCli(arguments_, environment);
  switch (invocation.command) {
    case 'help':
      stdout.write(USAGE);
      return;
    case 'status':
      writeStatus(stdout);
      return;
    case 'stop':
      await stopBackground(stdout);
      return;
    case 'start':
      if (invocation.background) {
        const result = await startBackground(invocation);
        if (result.kind === 'already-running') {
          stdout.write(`Cloud Agent Host is already running (PID ${result.state.pid}).\n`);
          stdout.write(`  WebSocket: ${webSocketEndpoint(result.state.host, result.state.port)}\n`);
          stdout.write(`  Log: ${result.paths.logFile}\n`);
          return;
        }
        writeStartedBackground(stdout, result.state, result.paths, invocation.generatedToken);
        return;
      }
      await startForeground(invocation, stdout);
      return;
  }
}

/** CLI-safe top-level error boundary. Errors never contain token values. */
export async function main(
  arguments_: readonly string[] = process.argv.slice(2),
  environment: CloudCliEnvironment = process.env,
  stderr: Pick<NodeJS.WriteStream, 'write'> = process.stderr,
): Promise<void> {
  try {
    await runCloudCli(arguments_, environment);
  } catch (error) {
    process.exitCode = 1;
    const message = error instanceof CloudCliError || error instanceof ConfigurationError
      ? error.message
      : 'server startup failed; inspect the Cloud log for details';
    stderr.write(`cloud: ${message}\n`);
  }
}

interface StartOptions {
  readonly overrides: Readonly<Record<string, string>>;
  readonly global: boolean;
  readonly foreground: boolean;
}

function parseStartOptions(arguments_: readonly string[]): StartOptions {
  const overrides: Record<string, string> = {};
  let global = false;
  let foreground = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === '--global') {
      global = true;
      continue;
    }
    if (argument === '--foreground') {
      foreground = true;
      continue;
    }
    const parsed = parseValueOption(argument, arguments_[index + 1]);
    if (parsed === undefined) {
      throw new CloudCliError(`unknown option ${safeOptionName(argument)}; run cloud --help for usage`);
    }
    overrides[parsed.environmentKey] = parsed.value;
    if (!argument.includes('=')) {
      index += 1;
    }
  }
  return Object.freeze({ overrides: Object.freeze(overrides), global, foreground });
}

interface ParsedOption {
  readonly environmentKey: string;
  readonly value: string;
}

function parseValueOption(argument: string, next: string | undefined): ParsedOption | undefined {
  const equals = argument.indexOf('=');
  const name = equals < 0 ? argument : argument.slice(0, equals);
  const inlineValue = equals < 0 ? undefined : argument.slice(equals + 1);
  const environmentKey = optionEnvironmentKey(name);
  if (environmentKey === undefined) {
    return undefined;
  }
  const value = inlineValue ?? next;
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new CloudCliError(`${name} requires a non-empty value`);
  }
  return { environmentKey, value };
}

function optionEnvironmentKey(name: string): string | undefined {
  switch (name) {
    case '--token':
      return 'CCVIBE_BEARER_TOKEN';
    case '--host':
      return 'CCVIBE_HOST';
    case '--port':
      return 'CCVIBE_PORT';
    case '--env':
      return 'CCVIBE_ENV';
    default:
      return undefined;
  }
}

function requireNoOptions(arguments_: readonly string[], command: string): void {
  if (arguments_.length > 0) {
    throw new CloudCliError(`${command} does not accept options`);
  }
}

function safeOptionName(argument: string): string {
  const equals = argument.indexOf('=');
  return equals < 0 ? argument : argument.slice(0, equals);
}

function isAllInterfacesHost(host: string | undefined): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function ipv4Priority(address: string): number {
  const [first, second] = address.split('.').map((part) => Number(part));
  if (first === 192 && second === 168) {
    return 0;
  }
  if (first === 10) {
    return 1;
  }
  if (first === 172 && second !== undefined && second >= 16 && second <= 31) {
    return 2;
  }
  return 3;
}

interface DaemonRuntimePaths {
  readonly directory: string;
  readonly pidFile: string;
  readonly stateFile: string;
  readonly logFile: string;
}

interface DaemonState {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: string;
}

function daemonRuntimePaths(directory = join(homedir(), RUNTIME_DIRECTORY_NAME)): DaemonRuntimePaths {
  return Object.freeze({
    directory,
    pidFile: join(directory, PID_FILE_NAME),
    stateFile: join(directory, STATE_FILE_NAME),
    logFile: join(directory, LOG_FILE_NAME),
  });
}

async function startBackground(invocation: CloudStartInvocation): Promise<
  | { readonly kind: 'started'; readonly state: DaemonState; readonly paths: DaemonRuntimePaths }
  | { readonly kind: 'already-running'; readonly state: DaemonState; readonly paths: DaemonRuntimePaths }
> {
  const paths = daemonRuntimePaths();
  const current = readDaemonState(paths);
  if (current !== undefined && isProcessRunning(current.pid)) {
    return { kind: 'already-running', state: current, paths };
  }
  clearDaemonState(paths);
  ensureRuntimeDirectory(paths);

  const logDescriptor = openSync(paths.logFile, 'a', 0o600);
  chmodSync(paths.logFile, 0o600);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [daemonEntrypointPath(), 'start', '--foreground'], {
      detached: true,
      stdio: ['ignore', logDescriptor, logDescriptor],
      env: {
        ...invocation.environment,
        [DAEMON_STATE_DIRECTORY_ENV]: paths.directory,
      },
    });
  } finally {
    closeSync(logDescriptor);
  }

  if (child.pid === undefined) {
    throw new CloudCliError('could not create the background host process');
  }
  const state: DaemonState = Object.freeze({
    pid: child.pid,
    host: requiredEnvironmentValue(invocation.environment, 'CCVIBE_HOST'),
    port: Number(requiredEnvironmentValue(invocation.environment, 'CCVIBE_PORT', '8787')),
    startedAt: new Date().toISOString(),
  });
  writeDaemonState(paths, state);

  try {
    await waitForHealth(state.host, state.port, child);
  } catch (error) {
    clearDaemonState(paths);
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // The child may have failed before becoming a process group leader.
    }
    throw error;
  }
  child.unref();
  return { kind: 'started', state, paths };
}

async function startForeground(
  invocation: CloudStartInvocation,
  stdout: Pick<NodeJS.WriteStream, 'write'>,
): Promise<void> {
  installDaemonExitCleanup(invocation.environment);
  const started = await runAgentHostCli(invocation.environment);
  if (invocation.generatedToken !== undefined) {
    stdout.write(`Cloud access token: ${invocation.generatedToken}\n`);
  }
  stdout.write(`Cloud Agent Host listening on ${formatHostPort(started.config.host, started.config.port)}\n`);
}

function writeStartedBackground(
  stdout: Pick<NodeJS.WriteStream, 'write'>,
  state: DaemonState,
  paths: DaemonRuntimePaths,
  generatedToken: string | undefined,
): void {
  stdout.write(`Cloud Agent Host started in the background (PID ${state.pid}).\n`);
  stdout.write(`  WebSocket: ${webSocketEndpoint(state.host, state.port)}\n`);
  if (generatedToken !== undefined) {
    stdout.write(`  Cloud access token: ${generatedToken}\n`);
  }
  stdout.write(`  Log: ${paths.logFile}\n`);
}

async function stopBackground(stdout: Pick<NodeJS.WriteStream, 'write'>): Promise<void> {
  const paths = daemonRuntimePaths();
  const state = readDaemonState(paths);
  if (state === undefined || !isProcessRunning(state.pid)) {
    clearDaemonState(paths);
    stdout.write('Cloud Agent Host is not running.\n');
    return;
  }
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    throw new CloudCliError(`could not stop background process ${state.pid}`);
  }
  if (!await waitForProcessExit(state.pid)) {
    throw new CloudCliError(`background process ${state.pid} did not stop within 5 seconds`);
  }
  clearDaemonState(paths);
  stdout.write(`Cloud Agent Host stopped (PID ${state.pid}).\n`);
}

function writeStatus(stdout: Pick<NodeJS.WriteStream, 'write'>): void {
  const paths = daemonRuntimePaths();
  const state = readDaemonState(paths);
  if (state === undefined || !isProcessRunning(state.pid)) {
    clearDaemonState(paths);
    stdout.write('Cloud Agent Host is not running.\n');
    return;
  }
  stdout.write(`Cloud Agent Host is running (PID ${state.pid}).\n`);
  stdout.write(`  WebSocket: ${webSocketEndpoint(state.host, state.port)}\n`);
  stdout.write(`  Log: ${paths.logFile}\n`);
}

function waitForHealth(host: string, port: number, child: ChildProcess): Promise<void> {
  const probeHost = isAllInterfacesHost(host) ? '127.0.0.1' : host;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      child.off('exit', onExit);
      child.off('error', onError);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new CloudCliError(`background host exited during startup (code=${code ?? 'none'}, signal=${signal ?? 'none'})`));
    };
    const onError = (): void => {
      finish(new CloudCliError('background host could not be started'));
    };
    const poll = (): void => {
      if (settled) {
        return;
      }
      if (Date.now() - startedAt >= STARTUP_TIMEOUT_MS) {
        finish(new CloudCliError('background host did not become healthy within 15 seconds; inspect its log'));
        return;
      }
      const request = getHttp({ host: probeHost, port, path: '/health', timeout: 1_000 }, (response) => {
        response.resume();
        if (response.statusCode !== undefined && response.statusCode > 0) {
          finish();
          return;
        }
        timer = setTimeout(poll, HEALTH_POLL_MS);
      });
      request.once('error', () => {
        timer = setTimeout(poll, HEALTH_POLL_MS);
      });
      request.once('timeout', () => {
        request.destroy();
        timer = setTimeout(poll, HEALTH_POLL_MS);
      });
    };
    child.once('exit', onExit);
    child.once('error', onError);
    poll();
  });
}

function waitForProcessExit(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!isProcessRunning(pid)) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= STOP_TIMEOUT_MS) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

function daemonEntrypointPath(): string {
  return fileURLToPath(new URL('../bin/cloud.js', import.meta.url));
}

function installDaemonExitCleanup(environment: CloudCliEnvironment): void {
  const directory = environment[DAEMON_STATE_DIRECTORY_ENV];
  if (directory === undefined || !isAbsolute(directory)) {
    return;
  }
  const paths = daemonRuntimePaths(directory);
  process.once('exit', () => {
    clearDaemonState(paths);
  });
}

function ensureRuntimeDirectory(paths: DaemonRuntimePaths): void {
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  chmodSync(paths.directory, 0o700);
}

function readDaemonState(paths: DaemonRuntimePaths): DaemonState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(paths.stateFile, 'utf8')) as Record<string, unknown>;
    if (
      !Number.isSafeInteger(parsed.pid)
      || typeof parsed.host !== 'string'
      || !Number.isSafeInteger(parsed.port)
      || typeof parsed.startedAt !== 'string'
      || (parsed.pid as number) <= 0
      || (parsed.port as number) < 1
      || (parsed.port as number) > 65_535
    ) {
      return undefined;
    }
    return Object.freeze({
      pid: parsed.pid as number,
      host: parsed.host,
      port: parsed.port as number,
      startedAt: parsed.startedAt,
    });
  } catch {
    return undefined;
  }
}

function writeDaemonState(paths: DaemonRuntimePaths, state: DaemonState): void {
  writeFileSync(paths.pidFile, `${state.pid}\n`, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(paths.stateFile, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(paths.pidFile, 0o600);
  chmodSync(paths.stateFile, 0o600);
}

function clearDaemonState(paths: DaemonRuntimePaths): void {
  removeIfPresent(paths.pidFile);
  removeIfPresent(paths.stateFile);
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function requiredEnvironmentValue(
  environment: CloudCliEnvironment,
  key: string,
  fallback?: string,
): string {
  const value = environment[key] ?? fallback;
  if (value === undefined) {
    throw new CloudCliError(`${key} was not configured`);
  }
  return value;
}

function webSocketEndpoint(host: string, port: number): string {
  const reachableHost = isAllInterfacesHost(host) ? resolveDefaultLanHost() : host;
  return `ws://${formatHostPort(reachableHost, port)}/ws`;
}
