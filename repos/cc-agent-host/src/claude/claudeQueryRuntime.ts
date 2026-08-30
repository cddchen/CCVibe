import type { UUID } from 'node:crypto';

import type {
  Options,
  Query,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
  WarmQuery,
} from '@anthropic-ai/claude-agent-sdk';

import type { TurnId } from '../domain/ids.js';
import type { ClaudeAgentSdkService } from './claudeAgentSdkService.js';
import { AsyncInputQueue } from './asyncInputQueue.js';
import {
  applyClaudeRuntimeConfig,
  type ClaudeRuntimeConfig,
} from './runtimeConfig.js';
import type {
  ClaudeRuntimeSignal,
  ClaudeRuntimeState,
  ClaudeTurnHandle,
  ClaudeTurnOutcome,
} from './runtimeTypes.js';
import { createClaudeUserMessage } from './userMessage.js';

export type ClaudeRuntimeSignalErrorReporter = (error: unknown) => unknown;

export interface ClaudeQueryRuntimeDeps {
  readonly generation: number;
  readonly sdkSessionId: string;
  readonly sdkService: Pick<ClaudeAgentSdkService, 'startup'>;
  readonly buildOptions: () => Options;
  readonly createSdkUuid: () => UUID;
  readonly onSignal: (signal: ClaudeRuntimeSignal) => void | Promise<void>;
  readonly onSignalError?: ClaudeRuntimeSignalErrorReporter;
}

export interface ClaudeSendOptions {
  readonly steering?: boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingTurn {
  readonly turnId: TurnId;
  readonly sdkUuid: UUID;
  readonly completed: Deferred<ClaudeTurnOutcome>;
  settled: boolean;
  acceptedBySdk: boolean;
  interruptRequested: boolean;
  interruptResult?: ClaudeTurnOutcome;
}

interface PendingConfigApplication {
  readonly version: number;
  readonly config: ClaudeRuntimeConfig;
  readonly deferred: Deferred<void>;
  settled: boolean;
}

type SdkVisibleResultEntry =
  | { readonly kind: 'pending'; readonly turn: PendingTurn }
  | { readonly kind: 'interrupted'; readonly sdkUuid: UUID };

const RUNTIME_CLOSED_MESSAGE = 'Claude query runtime closed';
const RUNTIME_START_FAILED_MESSAGE = 'Claude query runtime failed to start';
const RUNTIME_CRASHED_MESSAGE = 'Claude query runtime crashed';

/**
 * Owns one long-lived SDK WarmQuery/Query pair and its input stream.
 *
 * This class is deliberately kept inside the Claude boundary. Its signal
 * union contains raw SDK messages and is therefore not part of the package
 * root API.
 */
export class ClaudeQueryRuntime {
  private readonly generation: number;
  private readonly sdkSessionId: string;
  private readonly sdkService: Pick<ClaudeAgentSdkService, 'startup'>;
  private readonly buildOptions: () => Options;
  private readonly createSdkUuid: () => UUID;
  private readonly onSignal: (signal: ClaudeRuntimeSignal) => void | Promise<void>;
  private readonly onSignalError: ClaudeRuntimeSignalErrorReporter | undefined;
  private readonly inputQueue = new AsyncInputQueue<SDKUserMessage>();

  private readonly pendingByTurnId = new Map<TurnId, PendingTurn>();
  private readonly pendingBySdkUuid = new Map<string, PendingTurn>();
  private readonly seenTurnIds = new Set<TurnId>();
  private readonly seenSdkUuids = new Set<string>();
  private readonly interruptedSdkUuids = new Set<string>();
  private readonly sdkVisibleResultQueue: SdkVisibleResultEntry[] = [];
  private readonly interruptFlights = new Map<
    TurnId,
    Promise<SDKControlInterruptResponse | undefined>
  >();
  private readonly disposedWarmQueries = new Set<WarmQuery>();
  private readonly pendingConfigApplications: PendingConfigApplication[] = [];
  private readonly scheduledConfigVersions = new Set<number>();

  private stateValue: ClaudeRuntimeState = 'starting';
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private closeRequested = false;
  private terminalSignalSent = false;
  private options: Options | undefined;
  private warmQuery: WarmQuery | undefined;
  private query: Query | undefined;
  private queryEpoch = 0;
  private activeTurnId: TurnId | undefined;
  private lastCompletedTurnId: TurnId | undefined;

  private desiredConfigVersion = 0;
  private appliedConfigVersion = 0;
  private configTail: Promise<void> = Promise.resolve();

  public constructor(deps: ClaudeQueryRuntimeDeps) {
    if (!Number.isSafeInteger(deps.generation) || deps.generation <= 0) {
      throw new RangeError('generation must be a positive integer');
    }
    if (typeof deps.sdkSessionId !== 'string' || deps.sdkSessionId.trim().length === 0) {
      throw new TypeError('sdkSessionId must be a non-empty string');
    }

    this.generation = deps.generation;
    this.sdkSessionId = deps.sdkSessionId;
    this.sdkService = deps.sdkService;
    this.buildOptions = deps.buildOptions;
    this.createSdkUuid = deps.createSdkUuid;
    this.onSignal = deps.onSignal;
    this.onSignalError = deps.onSignalError;
  }

  public get state(): ClaudeRuntimeState {
    return this.stateValue;
  }

  public start(): Promise<void> {
    if (this.closeRequested || this.terminalSignalSent) {
      return Promise.reject(new Error(RUNTIME_CLOSED_MESSAGE));
    }
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }
    this.stateValue = 'starting';
    const attempt = this.startInternal();
    this.startPromise = attempt;
    return attempt;
  }

  public send(
    turnId: TurnId,
    text: string,
    options: ClaudeSendOptions = {},
  ): ClaudeTurnHandle {
    this.assertCanSend();
    validateTurnId(turnId);
    if (this.seenTurnIds.has(turnId)) {
      throw new TypeError('turnId has already been used by this runtime');
    }

    const sdkUuid = this.createSdkUuid();
    validateSdkUuid(sdkUuid);
    if (this.seenSdkUuids.has(sdkUuid)) {
      throw new TypeError('createSdkUuid returned a duplicate UUID');
    }

    const message = createClaudeUserMessage({
      prompt: text,
      sdkUuid,
      sdkSessionId: this.sdkSessionId,
      ...(options.steering === undefined ? {} : { steering: options.steering }),
    });
    const completed = createDeferred<ClaudeTurnOutcome>();
    const entry: PendingTurn = {
      turnId,
      sdkUuid,
      completed,
      settled: false,
      acceptedBySdk: false,
      interruptRequested: false,
    };

    this.seenTurnIds.add(turnId);
    this.seenSdkUuids.add(sdkUuid);
    this.pendingByTurnId.set(turnId, entry);
    this.pendingBySdkUuid.set(sdkUuid, entry);

    const accepted = this.inputQueue.push(message);
    void accepted.then(
      () => {
        this.markSdkAccepted(entry);
      },
      () => undefined,
    );

    const handle: ClaudeTurnHandle = {
      turnId,
      sdkUuid,
      accepted,
      completed: completed.promise,
    };

    // Sends are the materialization trigger. The rejection is observed here;
    // the returned turn promises remain the caller's explicit API surface.
    if (this.startPromise === undefined && !this.closeRequested) {
      void this.start().catch(() => undefined);
    }
    return handle;
  }

  public interrupt(turnId: TurnId): Promise<SDKControlInterruptResponse | undefined> {
    const existingFlight = this.interruptFlights.get(turnId);
    if (existingFlight !== undefined) {
      return existingFlight;
    }

    const entry = this.pendingByTurnId.get(turnId);
    if (entry === undefined || entry.settled || this.closeRequested) {
      return Promise.resolve(undefined);
    }

    const query = this.query;
    if (query === undefined) {
      const flight = this.interruptBeforeQuery(entry);
      this.interruptFlights.set(turnId, flight);
      this.observeInterruptFlight(turnId, flight);
      return flight;
    }

    entry.interruptRequested = true;
    let interruptResult: Promise<SDKControlInterruptResponse | undefined>;
    try {
      // This is intentionally direct and is not sequenced behind send or
      // runtime-config work.
      interruptResult = query.interrupt();
    } catch (error) {
      interruptResult = Promise.reject(error);
    }

    const flight = interruptResult.then(
      async (receipt) => {
        if (this.isPending(entry)) {
          this.replaceWithInterruptedTombstone(entry);
          this.lastCompletedTurnId = entry.turnId;
          this.activeTurnId = this.activeTurnId === entry.turnId ? undefined : this.activeTurnId;
          await this.completeTurn(entry, { status: 'interrupted' }, true, true);
        }
        return receipt;
      },
      async (error: unknown) => {
        if (this.isPending(entry)) {
          entry.interruptRequested = false;
          const interruptedResult = entry.interruptResult;
          delete entry.interruptResult;
          if (interruptedResult !== undefined) {
            this.lastCompletedTurnId = entry.turnId;
            await this.completeTurn(entry, interruptedResult, true);
          }
        }
        throw error;
      },
    );
    this.interruptFlights.set(turnId, flight);
    this.observeInterruptFlight(turnId, flight);
    return flight;
  }

  public applyRuntimeConfig(config: ClaudeRuntimeConfig): Promise<void> {
    if (this.closeRequested || this.terminalSignalSent) {
      return Promise.reject(new Error(RUNTIME_CLOSED_MESSAGE));
    }

    const snapshot = copyRuntimeConfig(config);
    const version = ++this.desiredConfigVersion;

    if (this.query !== undefined && this.stateValue === 'running') {
      const application: PendingConfigApplication = {
        version,
        config: snapshot,
        deferred: createDeferred<void>(),
        settled: false,
      };
      this.pendingConfigApplications.push(application);
      void application.deferred.promise.catch(() => undefined);
      return this.enqueueRuntimeConfig(application, Promise.resolve());
    }

    const pending: PendingConfigApplication = {
      version,
      config: snapshot,
      deferred: createDeferred<void>(),
      settled: false,
    };
    this.pendingConfigApplications.push(pending);
    void pending.deferred.promise.catch(() => undefined);
    return pending.deferred.promise;
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    // This synchronous prefix wins every startup/interrupt/consumer race.
    this.closeRequested = true;
    if (!this.terminalSignalSent && this.stateValue !== 'crashed') {
      this.stateValue = 'closing';
    }
    const closeError = new Error(RUNTIME_CLOSED_MESSAGE);
    this.inputQueue.fail(closeError);
    this.rejectPendingConfigApplications(closeError);
    this.settlePendingWithoutResult({
      status: 'runtime_closed',
      message: RUNTIME_CLOSED_MESSAGE,
    });
    this.abortOptions();

    const cleanup = (async (): Promise<void> => {
      const startPromise = this.startPromise;
      if (startPromise !== undefined) {
        await startPromise.catch(() => undefined);
      }
      await this.disposeCurrentResources();
      if (!this.terminalSignalSent) {
        this.stateValue = 'closed';
        await this.emitTerminal('closed');
      } else if (this.stateValue === 'closing') {
        this.stateValue = 'closed';
      }
    })();
    this.closePromise = cleanup;
    return cleanup;
  }

  private async startInternal(): Promise<void> {
    let warmQuery: WarmQuery | undefined;
    let query: Query | undefined;

    try {
      const options = this.buildOptions();
      this.options = options;
      if (this.closeRequested) {
        this.abortOptions();
        return;
      }

      warmQuery = await this.sdkService.startup({ options });
      if (this.closeRequested) {
        await this.disposeWarmQuery(warmQuery);
        return;
      }

      query = warmQuery.query(this.inputQueue);
      if (this.closeRequested) {
        await this.disposeResources(query, warmQuery);
        return;
      }

      this.warmQuery = warmQuery;
      this.query = query;
      const epoch = ++this.queryEpoch;
      this.stateValue = 'running';
      const replay = this.replayDesiredConfigIfNeeded();
      if (replay !== undefined) {
        await replay;
      }
      if (this.closeRequested) {
        await this.disposeCurrentResources();
        return;
      }

      // The consumer is deliberately detached from start(). A result ends a
      // turn, not this task; only iterator completion ends the runtime.
      const consumer = this.consume(query, epoch);
      void consumer.catch(() => undefined);
    } catch (error) {
      if (this.closeRequested) {
        if (this.query === query && this.warmQuery === warmQuery && query !== undefined) {
          await this.disposeCurrentResources();
        } else if (query !== undefined || warmQuery !== undefined) {
          await this.disposeResources(query, warmQuery);
        }
        return;
      }
      if (this.query === query && this.warmQuery === warmQuery && query !== undefined) {
        await this.disposeCurrentResources();
      } else if (query !== undefined || warmQuery !== undefined) {
        await this.disposeResources(query, warmQuery);
      }
      await this.failStart(error);
      throw error;
    }
  }

  private async consume(query: Query, epoch: number): Promise<void> {
    try {
      while (true) {
        const next = await query.next();
        if (!this.isCurrentQuery(query, epoch)) {
          return;
        }
        if (next.done) {
          if (!this.closeRequested) {
            await this.finishFromIterator('closed');
          }
          return;
        }
        if (this.closeRequested) {
          return;
        }
        await this.handleMessage(next.value);
      }
    } catch (error) {
      if (this.isCurrentQuery(query, epoch) && !this.closeRequested && !this.terminalSignalSent) {
        await this.finishFromIterator('crashed', error);
      }
    }
  }

  private async handleMessage(message: SDKMessage): Promise<void> {
    if (this.closeRequested || this.terminalSignalSent) {
      return;
    }
    if (message.type === 'system' && message.subtype === 'init') {
      await this.handleInitMessage(message);
      return;
    }
    if (message.type === 'result') {
      await this.handleResultMessage(message);
      return;
    }

    const attribution = this.attributeMessage(message);
    const signal = {
      type: 'runtime/message' as const,
      generation: this.generation,
      phase: attribution.phase,
      message,
      ...(attribution.turnId === undefined ? {} : { turnId: attribution.turnId }),
    } satisfies ClaudeRuntimeSignal;
    await this.emitSignal(signal);
  }

  private async handleInitMessage(message: SDKSystemMessage): Promise<void> {
    const capabilities = message.capabilities === undefined
      ? undefined
      : Object.fromEntries(message.capabilities.map((capability) => [capability, true]));
    const signal = {
      type: 'runtime/init' as const,
      generation: this.generation,
      sdkSessionId: message.session_id,
      ...(capabilities === undefined ? {} : { capabilities }),
    } satisfies ClaudeRuntimeSignal;
    await this.emitSignal(signal);
  }

  private async handleResultMessage(message: SDKResultMessage): Promise<void> {
    const entry = this.matchResult(message);
    if (entry === undefined) {
      return;
    }

    const outcome: ClaudeTurnOutcome = message.subtype === 'success' && !message.is_error
      ? { status: 'completed', resultSubtype: message.subtype }
      : {
          status: 'failed',
          resultSubtype: message.subtype,
          message: safeResultErrorMessage(message),
        };

    if (entry.interruptRequested) {
      entry.interruptResult = outcome;
      return;
    }

    this.lastCompletedTurnId = entry.turnId;
    await this.completeTurn(entry, outcome, true);
  }

  private matchResult(message: SDKResultMessage): PendingTurn | undefined {
    if (message.subtype === 'success' && message.user_message_uuid !== undefined) {
      const explicitUuid = message.user_message_uuid;
      if (this.interruptedSdkUuids.delete(explicitUuid)) {
        this.removeInterruptedTombstone(explicitUuid);
        return undefined;
      }
      const exact = this.pendingBySdkUuid.get(explicitUuid);
      return exact;
    }

    const next = this.shiftNextSdkVisibleResultEntry();
    return next?.kind === 'pending' ? next.turn : undefined;
  }

  private attributeMessage(
    message: SDKMessage,
  ): { readonly phase: 'active' | 'tail' | 'unmatched'; readonly turnId?: TurnId } {
    if (message.type === 'user' && message.uuid !== undefined) {
      const matchingEntry = this.pendingBySdkUuid.get(message.uuid);
      if (matchingEntry !== undefined && matchingEntry.acceptedBySdk && !matchingEntry.settled) {
        this.activeTurnId = matchingEntry.turnId;
        return { phase: 'active', turnId: matchingEntry.turnId };
      }
    }

    if (this.activeTurnId !== undefined) {
      const activeEntry = this.pendingByTurnId.get(this.activeTurnId);
      if (activeEntry !== undefined && !activeEntry.settled) {
        return { phase: 'active', turnId: activeEntry.turnId };
      }
      this.activeTurnId = undefined;
    }

    // Before the first result there is no tail owner. The accepted FIFO head
    // is a useful active fallback for SDKs that do not echo the user message.
    if (this.lastCompletedTurnId === undefined) {
      const visible = this.peekFirstSdkVisiblePending();
      if (visible !== undefined) {
        this.activeTurnId = visible.turnId;
        return { phase: 'active', turnId: visible.turnId };
      }
    }

    if (this.lastCompletedTurnId !== undefined) {
      return { phase: 'tail', turnId: this.lastCompletedTurnId };
    }
    return { phase: 'unmatched' };
  }

  private markSdkAccepted(entry: PendingTurn): void {
    if (entry.settled || entry.acceptedBySdk || this.pendingBySdkUuid.get(entry.sdkUuid) !== entry) {
      return;
    }
    entry.acceptedBySdk = true;
    this.sdkVisibleResultQueue.push({ kind: 'pending', turn: entry });
  }

  private peekFirstSdkVisiblePending(): PendingTurn | undefined {
    for (const visible of this.sdkVisibleResultQueue) {
      if (
        visible.kind === 'pending'
        && !visible.turn.settled
        && this.pendingBySdkUuid.get(visible.turn.sdkUuid) === visible.turn
      ) {
        return visible.turn;
      }
    }
    return undefined;
  }

  private shiftNextSdkVisibleResultEntry(): SdkVisibleResultEntry | undefined {
    while (true) {
      const visible = this.sdkVisibleResultQueue.shift();
      if (visible === undefined) {
        return undefined;
      }
      if (visible.kind === 'interrupted') {
        this.interruptedSdkUuids.delete(visible.sdkUuid);
        return visible;
      }
      if (
        !visible.turn.settled
        && this.pendingBySdkUuid.get(visible.turn.sdkUuid) === visible.turn
      ) {
        return visible;
      }
    }
  }

  private replaceWithInterruptedTombstone(entry: PendingTurn): void {
    const index = this.sdkVisibleResultQueue.findIndex(
      (visible) => visible.kind === 'pending' && visible.turn === entry,
    );
    if (index >= 0) {
      this.sdkVisibleResultQueue[index] = { kind: 'interrupted', sdkUuid: entry.sdkUuid };
      this.interruptedSdkUuids.add(entry.sdkUuid);
    }
  }

  private removeInterruptedTombstone(sdkUuid: string): void {
    const index = this.sdkVisibleResultQueue.findIndex(
      (visible) => visible.kind === 'interrupted' && visible.sdkUuid === sdkUuid,
    );
    if (index >= 0) {
      this.sdkVisibleResultQueue.splice(index, 1);
    }
  }

  private removePendingResultEntry(entry: PendingTurn): void {
    const index = this.sdkVisibleResultQueue.findIndex(
      (visible) => visible.kind === 'pending' && visible.turn === entry,
    );
    if (index >= 0) {
      this.sdkVisibleResultQueue.splice(index, 1);
    }
  }

  private async completeTurn(
    entry: PendingTurn,
    outcome: ClaudeTurnOutcome,
    emitResult: boolean,
    preserveResultTombstone = false,
  ): Promise<void> {
    if (entry.settled) {
      return;
    }
    entry.settled = true;
    if (this.pendingByTurnId.get(entry.turnId) === entry) {
      this.pendingByTurnId.delete(entry.turnId);
    }
    if (this.pendingBySdkUuid.get(entry.sdkUuid) === entry) {
      this.pendingBySdkUuid.delete(entry.sdkUuid);
    }
    if (!preserveResultTombstone) {
      this.removePendingResultEntry(entry);
    }
    if (this.activeTurnId === entry.turnId) {
      this.activeTurnId = undefined;
    }

    entry.completed.resolve(outcome);
    if (emitResult) {
      const signal = {
        type: 'turn/result' as const,
        generation: this.generation,
        turnId: entry.turnId,
        outcome,
      } satisfies ClaudeRuntimeSignal;
      await this.emitSignal(signal);
    }
  }

  private settlePendingWithoutResult(outcome: ClaudeTurnOutcome): void {
    for (const entry of [...this.pendingByTurnId.values()]) {
      void this.completeTurn(entry, outcome, false);
    }
    this.activeTurnId = undefined;
  }

  private async finishFromIterator(
    terminalState: 'closed' | 'crashed',
    error?: unknown,
  ): Promise<void> {
    if (this.terminalSignalSent || this.closeRequested) {
      return;
    }

    const terminalError = terminalState === 'closed'
      ? new Error(RUNTIME_CLOSED_MESSAGE)
      : error;
    this.inputQueue.fail(terminalError);
    this.rejectPendingConfigApplications(terminalError);
    this.settlePendingWithoutResult(
      terminalState === 'closed'
        ? { status: 'runtime_closed', message: RUNTIME_CLOSED_MESSAGE }
        : { status: 'failed', message: safeRuntimeErrorMessage(error) },
    );
    this.stateValue = terminalState;
    await this.emitTerminal(terminalState, terminalState === 'crashed' ? error : undefined);
    await this.disposeCurrentResources();
  }

  private async failStart(error: unknown): Promise<void> {
    if (this.terminalSignalSent || this.closeRequested) {
      return;
    }
    this.inputQueue.fail(error);
    this.rejectPendingConfigApplications(error);
    this.settlePendingWithoutResult({
      status: 'failed',
      message: safeRuntimeErrorMessage(error, RUNTIME_START_FAILED_MESSAGE),
    });
    this.stateValue = 'crashed';
    await this.emitTerminal('crashed', error);
    await this.disposeCurrentResources();
  }

  private async emitTerminal(state: 'closed' | 'crashed', error?: unknown): Promise<void> {
    if (this.terminalSignalSent) {
      return;
    }
    this.terminalSignalSent = true;
    const signal = {
      type: 'runtime/terminal' as const,
      generation: this.generation,
      state,
      ...(error === undefined ? {} : { error }),
    } satisfies ClaudeRuntimeSignal;
    await this.emitSignal(signal, true);
  }

  private async emitSignal(signal: ClaudeRuntimeSignal, terminal = false): Promise<void> {
    if (this.terminalSignalSent && !terminal) {
      return;
    }
    try {
      await this.onSignal(signal);
    } catch (error) {
      await this.reportSignalError(error);
    }
  }

  private async reportSignalError(error: unknown): Promise<void> {
    if (this.onSignalError === undefined) {
      return;
    }
    try {
      await this.onSignalError(error);
    } catch {
      // Signal error reporters are observational and must not affect runtime state.
    }
  }

  private rejectPendingConfigApplications(error: unknown): void {
    for (const application of this.pendingConfigApplications) {
      if (!application.settled) {
        application.settled = true;
        application.deferred.reject(error);
      }
    }
  }

  private interruptBeforeQuery(entry: PendingTurn): Promise<undefined> {
    return (async (): Promise<undefined> => {
      if (this.closeRequested || !this.isPending(entry)) {
        return undefined;
      }
      entry.interruptRequested = true;
      this.lastCompletedTurnId = entry.turnId;
      await this.completeTurn(entry, { status: 'interrupted' }, true);
      this.abortOptions();
      await this.close();
      return undefined;
    })();
  }

  private observeInterruptFlight(
    turnId: TurnId,
    flight: Promise<SDKControlInterruptResponse | undefined>,
  ): void {
    void flight.then(
      () => {
        if (this.interruptFlights.get(turnId) === flight) {
          this.interruptFlights.delete(turnId);
        }
      },
      () => {
        if (this.interruptFlights.get(turnId) === flight) {
          this.interruptFlights.delete(turnId);
        }
      },
    );
  }

  private enqueueRuntimeConfig(
    application: PendingConfigApplication,
    ready: Promise<void>,
  ): Promise<void> {
    this.scheduledConfigVersions.add(application.version);
    const operation = this.configTail.then(async () => {
      await ready;
      if (this.closeRequested || this.terminalSignalSent) {
        throw new Error(RUNTIME_CLOSED_MESSAGE);
      }
      const query = this.query;
      const epoch = this.queryEpoch;
      if (query === undefined || this.stateValue !== 'running') {
        throw new Error('Claude query is not running');
      }
      await applyClaudeRuntimeConfig(query, application.config);
      if (
        !this.isCurrentQuery(query, epoch)
        || this.closeRequested
        || this.terminalSignalSent
      ) {
        throw new Error(RUNTIME_CLOSED_MESSAGE);
      }
      if (
        application.version === this.desiredConfigVersion
        && application.version >= this.appliedConfigVersion
      ) {
        this.appliedConfigVersion = application.version;
      }
    });
    const settled = operation.then(
      () => {
        if (!application.settled) {
          application.settled = true;
          application.deferred.resolve();
        }
      },
      (error: unknown) => {
        this.scheduledConfigVersions.delete(application.version);
        if (!application.settled) {
          application.settled = true;
          application.deferred.reject(error);
        }
      },
    );
    this.configTail = settled.then(() => undefined);
    return application.deferred.promise;
  }

  private replayDesiredConfigIfNeeded(): Promise<void> | undefined {
    const applications = this.pendingConfigApplications.filter(
      (application) => !this.scheduledConfigVersions.has(application.version),
    );
    if (applications.length === 0) {
      return undefined;
    }
    return Promise.all(
      applications.map((application) => this.enqueueRuntimeConfig(application, Promise.resolve())),
    ).then(() => undefined);
  }

  private isPending(entry: PendingTurn): boolean {
    return !entry.settled && this.pendingByTurnId.get(entry.turnId) === entry;
  }

  private isCurrentQuery(query: Query, epoch: number): boolean {
    return this.query === query && this.queryEpoch === epoch;
  }

  private abortOptions(): void {
    if (this.options?.abortController === undefined) {
      return;
    }
    try {
      this.options.abortController.abort();
    } catch {
      // Abort is best effort; cleanup still proceeds.
    }
  }

  private async disposeCurrentResources(): Promise<void> {
    if (this.cleanupPromise !== undefined) {
      return this.cleanupPromise;
    }

    const query = this.query;
    const warmQuery = this.warmQuery;
    this.query = undefined;
    this.warmQuery = undefined;
    this.queryEpoch += 1;
    this.abortOptions();

    const cleanup = this.disposeResources(query, warmQuery);
    this.cleanupPromise = cleanup;
    await cleanup;
  }

  private async disposeResources(
    query: Query | undefined,
    warmQuery: WarmQuery | undefined,
  ): Promise<void> {
    if (query !== undefined) {
      await Promise.resolve()
        .then(() => query.return())
        .then(() => undefined)
        .catch(() => undefined);
    }
    if (warmQuery !== undefined) {
      await this.disposeWarmQuery(warmQuery);
    }
  }

  private async disposeWarmQuery(warmQuery: WarmQuery): Promise<void> {
    if (this.disposedWarmQueries.has(warmQuery)) {
      return;
    }
    this.disposedWarmQueries.add(warmQuery);
    await Promise.resolve()
      .then(() => warmQuery[Symbol.asyncDispose]())
      .then(() => undefined)
      .catch(() => undefined);
  }

  private assertCanSend(): void {
    if (
      this.closeRequested
      || this.terminalSignalSent
      || this.stateValue === 'closing'
    ) {
      throw new Error(RUNTIME_CLOSED_MESSAGE);
    }
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function validateTurnId(value: TurnId): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('turnId must be a non-empty identifier');
  }
}

function validateSdkUuid(value: UUID): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('createSdkUuid must return a non-empty UUID');
  }
}

function copyRuntimeConfig(config: ClaudeRuntimeConfig): ClaudeRuntimeConfig {
  return {
    permissionMode: config.permissionMode,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.effort === undefined ? {} : { effort: config.effort }),
  };
}

function safeResultErrorMessage(message: SDKResultMessage): string {
  if (message.subtype === 'success') {
    return message.result.trim().length > 0
      ? truncateSafeMessage(message.result)
      : `Claude SDK result failed (${message.subtype})`;
  }

  const firstError = message.errors.find((error) => error.trim().length > 0);
  if (firstError === undefined) {
    return `Claude SDK result failed (${message.subtype})`;
  }
  return truncateSafeMessage(firstError);
}

function safeRuntimeErrorMessage(error: unknown, fallback = RUNTIME_CRASHED_MESSAGE): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return truncateSafeMessage(error.message);
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return truncateSafeMessage(error);
  }
  return fallback;
}

function truncateSafeMessage(message: string): string {
  const normalized = message.trim();
  return normalized.length <= 1024 ? normalized : `${normalized.slice(0, 1021)}...`;
}
