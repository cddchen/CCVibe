import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeQueryRuntime, ClaudeSendOptions } from './claudeQueryRuntime.js';
import {
  createChatBacking,
  markChatBackingMaterialized,
  updateChatBackingConfig,
  type ChatBacking,
  type CreateChatBackingInput,
} from './chatBacking.js';
import type { ChatUri, TurnId } from '../domain/ids.js';
import { parseChatUri } from '../domain/resources.js';
import type { SequencerByKey } from '../chat/sequencer.js';
import type { ClaudeRuntimeConfig } from './runtimeConfig.js';
import type {
  ClaudeRuntimeSignal,
  ClaudeRuntimeState,
  ClaudeTurnHandle,
} from './runtimeTypes.js';

/** The runtime surface the registry needs; raw SDK signals remain internal. */
export interface ClaudeChatRuntime extends Pick<
  ClaudeQueryRuntime,
  'start' | 'send' | 'interrupt' | 'applyRuntimeConfig' | 'close' | 'state'
> {
  supportedCommands?(): Promise<readonly ClaudeSupportedCommand[]>;
}

export interface ClaudeSupportedCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
  readonly aliases?: readonly string[];
}

export interface ClaudeChatRuntimeSession {
  readonly kind: 'new' | 'resume';
  readonly sessionId: string;
}

export interface ClaudeChatRuntimeFactoryInput {
  readonly backing: ChatBacking;
  readonly generation: number;
  readonly session: ClaudeChatRuntimeSession;
  readonly onSignal: (signal: ClaudeRuntimeSignal) => void | Promise<void>;
  /** Optional per-chat official SDK permission callback installed by the host. */
  readonly canUseTool?: CanUseTool;
}

export type ClaudeChatRuntimeFactory = (
  input: ClaudeChatRuntimeFactoryInput,
) => ClaudeChatRuntime | PromiseLike<ClaudeChatRuntime>;

export type ClaudeChatSignalObserver = (
  chatUri: ChatUri,
  signal: ClaudeRuntimeSignal,
) => void | Promise<void>;

export interface ClaudeChatRegistryOptions {
  readonly sequencer: SequencerByKey<ChatUri>;
  readonly runtimeFactory: ClaudeChatRuntimeFactory;
  readonly onSignal?: ClaudeChatSignalObserver;
  /**
   * Called before a provisional backing is promoted in memory. Hosts use this
   * hook to commit the corresponding overlay lifecycle transition first.
   */
  readonly onBackingMaterialized?: (
    backing: ChatBacking,
  ) => void | PromiseLike<void>;
  /** Construct one SDK callback per chat; the turn resolver stays registry-owned. */
  readonly createCanUseTool?: (
    chatUri: ChatUri,
    getTurnId: () => TurnId | undefined,
  ) => CanUseTool;
}

export interface ClaudeChatRegistrySnapshot {
  readonly backing: ChatBacking;
  readonly runtimeState?: ClaudeRuntimeState;
}

interface RuntimeEntry {
  readonly chatUri: ChatUri;
  readonly sdkSessionId: string;
  readonly generation: number;
  readonly runtime: ClaudeChatRuntime;
}

interface RuntimeHolder {
  runtime: ClaudeChatRuntime | undefined;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
}

const REGISTRY_SHUTDOWN_MESSAGE = 'Claude chat registry is shutting down';
const CHAT_DISPOSED_MESSAGE = 'chat backing was disposed';
const CHAT_RELEASED_MESSAGE = 'chat runtime was released';

/**
 * Owns the explicit ChatUri -> SDK session mapping and the lazy runtime pairs
 * behind it. The factory is deliberately injected so this layer can be tested
 * with a runtime constrained to the ClaudeQueryRuntime public surface.
 */
export class ClaudeChatRegistry {
  private readonly sequencer: SequencerByKey<ChatUri>;
  private readonly runtimeFactory: ClaudeChatRuntimeFactory;
  private readonly onSignal: ClaudeChatSignalObserver | undefined;
  private readonly onBackingMaterialized: ClaudeChatRegistryOptions['onBackingMaterialized'];
  private readonly createCanUseTool: ClaudeChatRegistryOptions['createCanUseTool'];
  private readonly backings = new Map<ChatUri, ChatBacking>();
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly installFlights = new Map<string, Promise<RuntimeEntry>>();
  private readonly materializeFlights = new Map<string, Promise<ClaudeChatRuntime>>();
  private readonly rebindFlights = new Map<string, Promise<void>>();
  private readonly releaseFlights = new Map<string, Promise<void>>();
  private readonly disposeFlights = new Map<string, Promise<void>>();
  private readonly closeFlights = new WeakMap<ClaudeChatRuntime, Promise<void>>();
  private readonly releaseRequested = new Set<ChatUri>();
  private readonly disposeRequested = new Set<ChatUri>();
  private readonly activeTurnIds = new Map<ChatUri, TurnId>();

  private generationCounter = 0;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(options: ClaudeChatRegistryOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('options must be an object');
    }
    if (options.sequencer === undefined || typeof options.sequencer.enqueue !== 'function') {
      throw new TypeError('sequencer must be provided');
    }
    if (typeof options.runtimeFactory !== 'function') {
      throw new TypeError('runtimeFactory must be provided');
    }
    if (options.onSignal !== undefined && typeof options.onSignal !== 'function') {
      throw new TypeError('onSignal must be a function when provided');
    }
    if (options.onBackingMaterialized !== undefined && typeof options.onBackingMaterialized !== 'function') {
      throw new TypeError('onBackingMaterialized must be a function when provided');
    }

    this.sequencer = options.sequencer;
    this.runtimeFactory = options.runtimeFactory;
    this.onSignal = options.onSignal;
    this.onBackingMaterialized = options.onBackingMaterialized;
    this.createCanUseTool = options.createCanUseTool;
  }

  public get size(): number {
    return this.backings.size;
  }

  public get runtimeCount(): number {
    return this.runtimes.size;
  }

  /** Return the turn currently routed to the SDK callback for one chat. */
  public activeTurnId(chatUri: ChatUri): TurnId | undefined {
    return this.activeTurnIds.get(parseChatUriValue(chatUri));
  }

  /** Store only a provisional, SDK-free backing. No factory or SDK call occurs. */
  public createProvisional(input: CreateChatBackingInput): ChatBacking {
    this.assertAcceptingCreate();
    const backing = createChatBacking(input);
    return this.registerBacking(backing);
  }

  /**
   * Hydrate a persisted backing without starting a runtime.
   *
   * A materialized backing is intentionally retained as materialized so the
   * first post-restart send selects the SDK resume path. Provisional rows stay
   * provisional and therefore select the SDK new-session path. This method is
   * synchronous and SDK-free; callers should commit persistence before using
   * it as their in-memory registration step.
   */
  public restorePersistedBacking(
    input: CreateChatBackingInput & { readonly lifecycle: ChatBacking['lifecycle'] },
  ): ChatBacking {
    this.assertAcceptingCreate();
    const { lifecycle, ...createInput } = input;
    const provisional = createChatBacking(createInput);
    const backing = lifecycle === 'materialized'
      ? markChatBackingMaterialized(provisional)
      : provisional;
    return this.registerBacking(backing);
  }

  /** Alias for callers that use a shorter hydration name. */
  public restoreBacking(
    input: CreateChatBackingInput & { readonly lifecycle: ChatBacking['lifecycle'] },
  ): ChatBacking {
    return this.restorePersistedBacking(input);
  }

  /**
   * Roll back a provisional entry before any runtime materialization begins.
   * This synchronous transaction hook is intentionally narrow: materialized
   * chats and chats with an active lifecycle flight must use disposeChat().
   */
  public discardProvisional(chatUri: ChatUri): boolean {
    const parsedChatUri = parseChatUriValue(chatUri);
    const backing = this.backings.get(parsedChatUri);
    if (backing === undefined) {
      return false;
    }
    if (backing.lifecycle !== 'provisional') {
      throw new Error('only a provisional backing can be discarded');
    }
    const sdkSessionId = backing.sdkSessionId;
    if (
      this.runtimes.has(sdkSessionId)
      || this.installFlights.has(sdkSessionId)
      || this.materializeFlights.has(sdkSessionId)
      || this.rebindFlights.has(sdkSessionId)
      || this.releaseFlights.has(sdkSessionId)
      || this.disposeFlights.has(sdkSessionId)
    ) {
      throw new Error('provisional backing has an active lifecycle flight');
    }
    this.backings.delete(parsedChatUri);
    return true;
  }

  /**
   * Materialize one chat at most once per SDK session. The returned runtime is
   * intentionally not part of the package-root API; callers normally use send.
   */
  public materialize(chatUri: ChatUri): Promise<ClaudeChatRuntime> {
    const parsedChatUri = parseChatUriValue(chatUri);
    if (this.shuttingDown) {
      return Promise.reject(new Error(REGISTRY_SHUTDOWN_MESSAGE));
    }

    const backing = this.requireBacking(parsedChatUri);
    const sdkSessionId = backing.sdkSessionId;
    const existingFlight = this.materializeFlights.get(sdkSessionId);
    if (existingFlight !== undefined) {
      return existingFlight;
    }

    const rebindFlight = this.rebindFlights.get(sdkSessionId);
    if (rebindFlight !== undefined) {
      return rebindFlight.then(() => {
        const entry = this.getLiveEntry(sdkSessionId);
        if (entry === undefined) {
          throw new Error('chat runtime is not materialized');
        }
        return entry.runtime;
      });
    }

    const existingEntry = this.getLiveEntry(sdkSessionId);
    if (existingEntry !== undefined) {
      return Promise.resolve(existingEntry.runtime);
    }

    this.ensureMaterializationStarted(parsedChatUri);
    const flight = this.materializeFlights.get(sdkSessionId);
    if (flight === undefined) {
      throw new Error('materialization flight was not installed');
    }
    return flight;
  }

  public async supportedCommands(chatUri: ChatUri): Promise<readonly ClaudeSupportedCommand[]> {
    const runtime = await this.materialize(chatUri);
    if (typeof runtime.supportedCommands !== 'function') {
      return Object.freeze([]);
    }
    const commands = await runtime.supportedCommands();
    return Object.freeze(commands.map((command) => Object.freeze({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
      ...(command.aliases === undefined ? {} : { aliases: Object.freeze([...command.aliases]) }),
    })));
  }

  /** Serialize materialization and handle creation, never turn completion. */
  public send(
    chatUri: ChatUri,
    turnId: TurnId,
    text: string,
    options: ClaudeSendOptions = {},
  ): Promise<ClaudeTurnHandle> {
    const parsedChatUri = parseChatUriValue(chatUri);
    if (this.shuttingDown) {
      return Promise.reject(new Error(REGISTRY_SHUTDOWN_MESSAGE));
    }

    return this.sequencer.enqueue(parsedChatUri, async () => {
      if (this.shuttingDown) {
        throw new Error(REGISTRY_SHUTDOWN_MESSAGE);
      }
      if (this.disposeRequested.has(parsedChatUri)) {
        throw new Error(CHAT_DISPOSED_MESSAGE);
      }
      if (this.releaseRequested.has(parsedChatUri)) {
        throw new Error(CHAT_RELEASED_MESSAGE);
      }

      const install = this.ensureMaterializationStarted(parsedChatUri);
      const materialize = this.materializeFlights.get(
        this.requireBacking(parsedChatUri).sdkSessionId,
      );
      if (materialize !== undefined) {
        // Startup failure is reported through the runtime's turn handle. Observe
        // the registry flight so callers do not also receive an unhandled branch.
        void materialize.catch(() => undefined);
      }
      const entry = await install;
      if (this.shuttingDown) {
        throw new Error(REGISTRY_SHUTDOWN_MESSAGE);
      }
      if (this.disposeRequested.has(parsedChatUri)) {
        throw new Error(CHAT_DISPOSED_MESSAGE);
      }
      if (this.releaseRequested.has(parsedChatUri)) {
        throw new Error(CHAT_RELEASED_MESSAGE);
      }
      this.activeTurnIds.set(parsedChatUri, turnId);
      try {
        return await entry.runtime.send(turnId, text, options);
      } catch (error) {
        if (this.activeTurnIds.get(parsedChatUri) === turnId) {
          this.activeTurnIds.delete(parsedChatUri);
        }
        throw error;
      }
    });
  }

  /** Interrupt the current live runtime without waiting for the send tail. */
  public interrupt(chatUri: ChatUri, turnId: TurnId): Promise<unknown | undefined> {
    const parsedChatUri = parseChatUriValue(chatUri);
    if (this.shuttingDown) {
      return Promise.reject(new Error(REGISTRY_SHUTDOWN_MESSAGE));
    }

    const backing = this.backings.get(parsedChatUri);
    if (backing === undefined) {
      return Promise.resolve(undefined);
    }
    const entry = this.getLiveEntry(backing.sdkSessionId);
    if (entry !== undefined) {
      return this.invokeInterrupt(entry.runtime, turnId);
    }

    // Installation is a narrower boundary than startup. Waiting for it lets an
    // async factory publish the starting runtime without waiting for start().
    const install = this.installFlights.get(backing.sdkSessionId);
    if (install === undefined) {
      return Promise.resolve(undefined);
    }
    return install.then(
      (installed) => this.invokeInterrupt(installed.runtime, turnId),
      () => undefined,
    );
  }

  /** Update desired config first; a live application failure does not roll it back. */
  public setRuntimeConfig(
    chatUri: ChatUri,
    config: ClaudeRuntimeConfig,
  ): Promise<void> {
    const parsedChatUri = parseChatUriValue(chatUri);
    if (this.shuttingDown) {
      return Promise.reject(new Error(REGISTRY_SHUTDOWN_MESSAGE));
    }

    return this.sequencer.enqueue(parsedChatUri, async () => {
      if (this.shuttingDown) {
        throw new Error(REGISTRY_SHUTDOWN_MESSAGE);
      }
      if (this.disposeRequested.has(parsedChatUri)) {
        throw new Error(CHAT_DISPOSED_MESSAGE);
      }
      const backing = this.requireBacking(parsedChatUri);
      const updated = updateChatBackingConfig(backing, config);
      this.backings.set(parsedChatUri, updated);

      const entry = this.getLiveEntry(updated.sdkSessionId);
      if (entry !== undefined) {
        await entry.runtime.applyRuntimeConfig(updated.desiredConfig);
      }
    });
  }

  /** Rebuild one runtime after the old one has completely drained. */
  public rebind(chatUri: ChatUri): Promise<void> {
    const parsedChatUri = parseChatUriValue(chatUri);
    if (this.shuttingDown) {
      return Promise.reject(new Error(REGISTRY_SHUTDOWN_MESSAGE));
    }

    const backing = this.requireBacking(parsedChatUri);
    const sdkSessionId = backing.sdkSessionId;
    const existing = this.rebindFlights.get(sdkSessionId);
    if (existing !== undefined) {
      return existing;
    }

    const flight = this.sequencer.enqueue(parsedChatUri, async () => {
      if (this.shuttingDown) {
        throw new Error(REGISTRY_SHUTDOWN_MESSAGE);
      }
      if (this.disposeRequested.has(parsedChatUri)) {
        throw new Error(CHAT_DISPOSED_MESSAGE);
      }

      // Prevent a direct materialize() that is still in its factory phase from
      // installing a runtime after this rebind has taken ownership of the key.
      const materializeFlight = this.materializeFlights.get(sdkSessionId);
      const oldEntry = this.runtimes.get(sdkSessionId);
      if (oldEntry !== undefined) {
        await this.closeRuntime(oldEntry.runtime);
        this.removeMatchingEntry(oldEntry);
      }
      if (materializeFlight !== undefined) {
        await materializeFlight.catch(() => undefined);
      }
      this.removeEntryForChat(sdkSessionId, parsedChatUri);
      if (this.shuttingDown) {
        throw new Error(REGISTRY_SHUTDOWN_MESSAGE);
      }
      if (this.disposeRequested.has(parsedChatUri)) {
        throw new Error(CHAT_DISPOSED_MESSAGE);
      }

      const latest = this.requireBacking(parsedChatUri);
      const session: ClaudeChatRuntimeSession = {
        kind: 'resume',
        sessionId: latest.sdkSessionId,
      };
      await this.beginRebind(latest, session);
    });
    this.rebindFlights.set(sdkSessionId, flight);
    void flight.then(
      () => {
        if (this.rebindFlights.get(sdkSessionId) === flight) {
          this.rebindFlights.delete(sdkSessionId);
        }
      },
      () => {
        if (this.rebindFlights.get(sdkSessionId) === flight) {
          this.rebindFlights.delete(sdkSessionId);
        }
      },
    );
    return flight;
  }

  /** Close a live runtime while retaining the materialized backing identity. */
  public release(chatUri: ChatUri): Promise<void> {
    const parsedChatUri = parseChatUriValue(chatUri);
    if (this.shuttingDown) {
      return Promise.reject(new Error(REGISTRY_SHUTDOWN_MESSAGE));
    }

    const backing = this.requireBacking(parsedChatUri);
    const sdkSessionId = backing.sdkSessionId;
    const existing = this.releaseFlights.get(sdkSessionId);
    if (existing !== undefined) {
      return existing;
    }
    this.releaseRequested.add(parsedChatUri);
    this.activeTurnIds.delete(parsedChatUri);
    this.closeLiveRuntimeForChat(parsedChatUri);

    const flight = this.sequencer.enqueue(parsedChatUri, async () => {
      try {
        const current = this.backings.get(parsedChatUri);
        if (current === undefined) {
          return;
        }
        const entry = this.runtimes.get(current.sdkSessionId);
        if (entry !== undefined) {
          await this.closeRuntime(entry.runtime);
          this.removeMatchingEntry(entry);
        }
        const materializeFlight = this.materializeFlights.get(current.sdkSessionId);
        if (materializeFlight !== undefined) {
          await materializeFlight.catch(() => undefined);
        }
        this.removeEntryForChat(current.sdkSessionId, parsedChatUri);
      } finally {
        this.releaseRequested.delete(parsedChatUri);
      }
    });
    this.releaseFlights.set(sdkSessionId, flight);
    void flight.then(
      () => {
        if (this.releaseFlights.get(sdkSessionId) === flight) {
          this.releaseFlights.delete(sdkSessionId);
        }
      },
      () => {
        if (this.releaseFlights.get(sdkSessionId) === flight) {
          this.releaseFlights.delete(sdkSessionId);
        }
      },
    );
    return flight;
  }

  /** Close and forget one chat, including a runtime still starting. */
  public disposeChat(chatUri: ChatUri): Promise<void> {
    const parsedChatUri = parseChatUriValue(chatUri);
    if (this.shuttingDown) {
      return Promise.reject(new Error(REGISTRY_SHUTDOWN_MESSAGE));
    }

    const backing = this.backings.get(parsedChatUri);
    if (backing === undefined) {
      return Promise.resolve();
    }
    const sdkSessionId = backing.sdkSessionId;
    const existing = this.disposeFlights.get(sdkSessionId);
    if (existing !== undefined) {
      return existing;
    }
    this.disposeRequested.add(parsedChatUri);
    this.activeTurnIds.delete(parsedChatUri);
    this.closeLiveRuntimeForChat(parsedChatUri);

    const flight = this.sequencer.enqueue(parsedChatUri, async () => {
      try {
        const current = this.backings.get(parsedChatUri);
        if (current === undefined) {
          return;
        }
        const currentSdkSessionId = current.sdkSessionId;
        const entry = this.runtimes.get(currentSdkSessionId);
        if (entry !== undefined) {
          await this.closeRuntime(entry.runtime);
          this.removeMatchingEntry(entry);
        }
        const materializeFlight = this.materializeFlights.get(currentSdkSessionId);
        if (materializeFlight !== undefined) {
          await materializeFlight.catch(() => undefined);
        }
        const rebindFlight = this.rebindFlights.get(currentSdkSessionId);
        if (rebindFlight !== undefined && rebindFlight !== flight) {
          await rebindFlight.catch(() => undefined);
        }
        this.removeEntryForChat(currentSdkSessionId, parsedChatUri);
        if (this.backings.get(parsedChatUri) === current) {
          this.backings.delete(parsedChatUri);
        }
      } finally {
        this.disposeRequested.delete(parsedChatUri);
      }
    });
    this.disposeFlights.set(sdkSessionId, flight);
    void flight.then(
      () => {
        if (this.disposeFlights.get(sdkSessionId) === flight) {
          this.disposeFlights.delete(sdkSessionId);
        }
      },
      () => {
        if (this.disposeFlights.get(sdkSessionId) === flight) {
          this.disposeFlights.delete(sdkSessionId);
        }
      },
    );
    return flight;
  }

  /** Return a safe immutable backing snapshot. */
  public snapshot(chatUri: ChatUri): ChatBacking | undefined {
    const parsedChatUri = parseChatUriValue(chatUri);
    return this.backings.get(parsedChatUri);
  }

  public getBacking(chatUri: ChatUri): ChatBacking | undefined {
    return this.snapshot(chatUri);
  }

  /** Return immutable snapshots in backing insertion order. */
  public snapshots(): readonly ClaudeChatRegistrySnapshot[] {
    const snapshots: ClaudeChatRegistrySnapshot[] = [];
    for (const backing of this.backings.values()) {
      const entry = this.runtimes.get(backing.sdkSessionId);
      snapshots.push(Object.freeze({
        backing,
        ...(entry === undefined ? {} : { runtimeState: entry.runtime.state }),
      }));
    }
    return Object.freeze(snapshots);
  }

  public listBackings(): readonly ChatBacking[] {
    return Object.freeze([...this.backings.values()]);
  }

  public list(): readonly ChatBacking[] {
    return this.listBackings();
  }

  /** Promise-identical, idempotent shutdown that never waits on sequencer tails. */
  public shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }
    this.shuttingDown = true;
    const promise = this.performShutdown();
    this.shutdownPromise = promise;
    return promise;
  }

  private async performShutdown(): Promise<void> {
    // Drain until dry rather than using a pass cap: a queued release/dispose can
    // expose a materialization or close flight only after an earlier flight ends.
    while (true) {
      await this.closeAllRuntimes();
      const flights = this.snapshotFlights();
      if (flights.length === 0 && this.runtimes.size === 0) {
        break;
      }
      await Promise.all(flights.map((flight) => flight.catch(() => undefined)));
    }

    this.runtimes.clear();
    this.installFlights.clear();
    this.materializeFlights.clear();
    this.rebindFlights.clear();
    this.releaseFlights.clear();
    this.disposeFlights.clear();
    this.releaseRequested.clear();
    this.disposeRequested.clear();
    this.activeTurnIds.clear();
    this.backings.clear();
  }

  private ensureMaterializationStarted(chatUri: ChatUri): Promise<RuntimeEntry> {
    const backing = this.requireBacking(chatUri);
    const sdkSessionId = backing.sdkSessionId;
    const existingEntry = this.getLiveEntry(sdkSessionId);
    if (existingEntry !== undefined) {
      return Promise.resolve(existingEntry);
    }
    const existingInstall = this.installFlights.get(sdkSessionId);
    if (existingInstall !== undefined) {
      return existingInstall;
    }
    const rebind = this.rebindFlights.get(sdkSessionId);
    if (rebind !== undefined) {
      return rebind.then(() => {
        const entry = this.getLiveEntry(sdkSessionId);
        if (entry === undefined) {
          throw new Error('chat runtime is not materialized');
        }
        return entry;
      });
    }

    const session: ClaudeChatRuntimeSession = backing.lifecycle === 'provisional'
      ? { kind: 'new', sessionId: sdkSessionId }
      : { kind: 'resume', sessionId: sdkSessionId };
    return this.beginMaterialize(backing, session);
  }

  private beginMaterialize(
    backing: ChatBacking,
    session: ClaudeChatRuntimeSession,
  ): Promise<RuntimeEntry> {
    const sdkSessionId = backing.sdkSessionId;
    const generation = this.nextGeneration();
    const holder: RuntimeHolder = { runtime: undefined };
    const installed = createDeferred<RuntimeEntry>();
    // The install promise is observed by send/interrupt and must never produce
    // an unhandled rejection when materialize is the only caller.
    void installed.promise.catch(() => undefined);
    this.installFlights.set(sdkSessionId, installed.promise);
    void installed.promise.then(
      () => this.clearInstallFlight(sdkSessionId, installed.promise),
      () => this.clearInstallFlight(sdkSessionId, installed.promise),
    );

    const flight = this.createAndStartRuntime(
      backing,
      generation,
      session,
      holder,
      installed,
    );
    this.materializeFlights.set(sdkSessionId, flight);
    void flight.then(
      () => this.clearMaterializeFlight(sdkSessionId, flight),
      () => this.clearMaterializeFlight(sdkSessionId, flight),
    );
    return installed.promise;
  }

  private async beginRebind(
    backing: ChatBacking,
    session: ClaudeChatRuntimeSession,
  ): Promise<void> {
    const sdkSessionId = backing.sdkSessionId;
    const generation = this.nextGeneration();
    const holder: RuntimeHolder = { runtime: undefined };
    const installed = createDeferred<RuntimeEntry>();
    void installed.promise.catch(() => undefined);
    this.installFlights.set(sdkSessionId, installed.promise);
    void installed.promise.then(
      () => this.clearInstallFlight(sdkSessionId, installed.promise),
      () => this.clearInstallFlight(sdkSessionId, installed.promise),
    );
    try {
      await this.createAndStartRuntime(
        backing,
        generation,
        session,
        holder,
        installed,
      );
    } finally {
      this.clearInstallFlight(sdkSessionId, installed.promise);
    }
  }

  private createAndStartRuntime(
    capturedBacking: ChatBacking,
    generation: number,
    session: ClaudeChatRuntimeSession,
    holder: RuntimeHolder,
    installed: Deferred<RuntimeEntry>,
  ): Promise<ClaudeChatRuntime> {
    return (async (): Promise<ClaudeChatRuntime> => {
      let runtime: ClaudeChatRuntime | undefined;
      let entry: RuntimeEntry | undefined;
      try {
        const onSignal = (signal: ClaudeRuntimeSignal): Promise<void> =>
          this.handleSignal(signal, capturedBacking.chatUri, generation, holder);
        runtime = await this.runtimeFactory({
          backing: capturedBacking,
          generation,
          session,
          onSignal,
          ...(this.createCanUseTool === undefined
            ? {}
            : {
                canUseTool: this.createCanUseTool(
                  capturedBacking.chatUri,
                  () => this.activeTurnIds.get(capturedBacking.chatUri),
                ),
              }),
        });
        assertRuntime(runtime);
        holder.runtime = runtime;

        if (this.mustDiscardRuntime(capturedBacking.chatUri)) {
          await this.closeRuntime(runtime);
          throw new Error(this.shuttingDown ? REGISTRY_SHUTDOWN_MESSAGE : CHAT_DISPOSED_MESSAGE);
        }

        const currentBacking = this.backings.get(capturedBacking.chatUri);
        if (
          currentBacking === undefined
          || currentBacking.sdkSessionId !== capturedBacking.sdkSessionId
        ) {
          await this.closeRuntime(runtime);
          throw new Error(CHAT_DISPOSED_MESSAGE);
        }

        entry = {
          chatUri: capturedBacking.chatUri,
          sdkSessionId: capturedBacking.sdkSessionId,
          generation,
          runtime,
        };
        this.runtimes.set(capturedBacking.sdkSessionId, entry);
        installed.resolve(entry);

        await runtime.start();

        const currentEntry = this.runtimes.get(capturedBacking.sdkSessionId);
        const current = this.backings.get(capturedBacking.chatUri);
        if (
          this.shuttingDown
          || this.mustDiscardRuntime(capturedBacking.chatUri)
          || currentEntry !== entry
          || current === undefined
        ) {
          this.removeMatchingEntry(entry);
          await this.closeRuntime(runtime);
          throw new Error(this.shuttingDown ? REGISTRY_SHUTDOWN_MESSAGE : CHAT_DISPOSED_MESSAGE);
        }

        if (current.lifecycle === 'provisional') {
          const materialized = markChatBackingMaterialized(current);
          // The host may persist this transition. Awaiting it here keeps the
          // durable overlay commit before the in-memory lifecycle promotion.
          if (this.onBackingMaterialized !== undefined) {
            await this.onBackingMaterialized(materialized);
          }
          this.backings.set(capturedBacking.chatUri, materialized);
        }
        return runtime;
      } catch (error) {
        installed.reject(error);
        if (entry !== undefined) {
          this.removeMatchingEntry(entry);
        }
        if (runtime !== undefined) {
          await this.closeRuntime(runtime);
        }
        throw error;
      }
    })();
  }

  private async handleSignal(
    signal: ClaudeRuntimeSignal,
    chatUri: ChatUri,
    generation: number,
    holder: RuntimeHolder,
  ): Promise<void> {
    await this.forwardSignal(chatUri, signal);
    if (
      (signal.type === 'turn/result' || signal.type === 'runtime/terminal')
      && signal.generation === generation
    ) {
      this.activeTurnIds.delete(chatUri);
    }
    if (signal.type !== 'runtime/terminal' || signal.generation !== generation) {
      return;
    }

    const entry = this.runtimes.get(this.backings.get(chatUri)?.sdkSessionId ?? '');
    if (
      entry !== undefined
      && entry.chatUri === chatUri
      && entry.generation === generation
      && (holder.runtime === undefined || entry.runtime === holder.runtime)
    ) {
      this.runtimes.delete(entry.sdkSessionId);
    }
  }

  private async forwardSignal(chatUri: ChatUri, signal: ClaudeRuntimeSignal): Promise<void> {
    if (this.onSignal === undefined) {
      return;
    }
    try {
      await this.onSignal(chatUri, signal);
    } catch {
      // Signal observers are observational and must not affect runtime state.
    }
  }

  private getLiveEntry(sdkSessionId: string): RuntimeEntry | undefined {
    const entry = this.runtimes.get(sdkSessionId);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.runtime.state === 'closed' || entry.runtime.state === 'crashed') {
      this.removeMatchingEntry(entry);
      return undefined;
    }
    return entry;
  }

  private invokeInterrupt(
    runtime: ClaudeChatRuntime,
    turnId: TurnId,
  ): Promise<unknown | undefined> {
    try {
      return runtime.interrupt(turnId);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private closeLiveRuntimeForChat(chatUri: ChatUri): void {
    const backing = this.backings.get(chatUri);
    if (backing === undefined) {
      return;
    }
    const entry = this.runtimes.get(backing.sdkSessionId);
    if (entry !== undefined) {
      void this.closeRuntime(entry.runtime);
    }
  }

  private async closeAllRuntimes(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(async (entry) => {
      await this.closeRuntime(entry.runtime);
      this.removeMatchingEntry(entry);
    }));
  }

  private snapshotFlights(): Array<Promise<unknown>> {
    return [
      ...this.installFlights.values(),
      ...this.materializeFlights.values(),
      ...this.rebindFlights.values(),
      ...this.releaseFlights.values(),
      ...this.disposeFlights.values(),
    ];
  }

  private closeRuntime(runtime: ClaudeChatRuntime): Promise<void> {
    const existing = this.closeFlights.get(runtime);
    if (existing !== undefined) {
      return existing;
    }
    const flight = Promise.resolve()
      .then(() => runtime.close())
      .then(() => undefined, () => undefined);
    this.closeFlights.set(runtime, flight);
    return flight;
  }

  private clearInstallFlight(
    sdkSessionId: string,
    install: Promise<RuntimeEntry>,
  ): void {
    if (this.installFlights.get(sdkSessionId) === install) {
      this.installFlights.delete(sdkSessionId);
    }
  }

  private clearMaterializeFlight(
    sdkSessionId: string,
    materialize: Promise<ClaudeChatRuntime>,
  ): void {
    if (this.materializeFlights.get(sdkSessionId) === materialize) {
      this.materializeFlights.delete(sdkSessionId);
    }
  }

  private removeMatchingEntry(entry: RuntimeEntry): void {
    if (this.runtimes.get(entry.sdkSessionId) === entry) {
      this.runtimes.delete(entry.sdkSessionId);
    }
  }

  private removeEntryForChat(sdkSessionId: string, chatUri: ChatUri): void {
    const entry = this.runtimes.get(sdkSessionId);
    if (entry?.chatUri === chatUri) {
      this.runtimes.delete(sdkSessionId);
    }
  }

  private mustDiscardRuntime(chatUri: ChatUri): boolean {
    return this.shuttingDown
      || this.disposeRequested.has(chatUri)
      || this.releaseRequested.has(chatUri);
  }

  private requireBacking(chatUri: ChatUri): ChatBacking {
    const backing = this.backings.get(chatUri);
    if (backing === undefined) {
      throw new Error('chat backing was not found');
    }
    return backing;
  }

  private assertAcceptingCreate(): void {
    if (this.shuttingDown) {
      throw new Error(REGISTRY_SHUTDOWN_MESSAGE);
    }
  }

  private registerBacking(backing: ChatBacking): ChatBacking {
    if (this.backings.has(backing.chatUri)) {
      throw new Error('chat URI is already registered');
    }
    for (const existing of this.backings.values()) {
      if (existing.sdkSessionId === backing.sdkSessionId) {
        throw new Error('sdkSessionId is already registered');
      }
    }

    this.backings.set(backing.chatUri, backing);
    return backing;
  }

  private nextGeneration(): number {
    if (this.generationCounter >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('runtime generation counter exhausted');
    }
    this.generationCounter += 1;
    return this.generationCounter;
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

function parseChatUriValue(value: ChatUri): ChatUri {
  if (typeof value !== 'string') {
    throw new TypeError('chatUri must be a valid chat URI');
  }
  return parseChatUri(value);
}

function assertRuntime(value: ClaudeChatRuntime): asserts value is ClaudeChatRuntime {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('runtimeFactory must return a runtime object');
  }
  for (const method of ['start', 'send', 'interrupt', 'applyRuntimeConfig', 'close'] as const) {
    if (typeof value[method] !== 'function') {
      throw new TypeError(`runtimeFactory result is missing ${method}()`);
    }
  }
  if (
    value.state !== 'starting'
    && value.state !== 'running'
    && value.state !== 'closing'
    && value.state !== 'closed'
    && value.state !== 'crashed'
  ) {
    throw new TypeError('runtimeFactory result has an invalid state');
  }
}
