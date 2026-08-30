import { describe, expect, it } from 'vitest';

import { JsonRpcTransport, type SocketLike, type SocketFactory } from '../src/sync/transport';
import type { TimerPort } from '../src/sync/timer';

class ManualTimer implements TimerPort {
  private nextId = 0;
  private current = 0;
  private readonly tasks = new Map<number, { readonly at: number; readonly callback: () => void }>();

  public now(): number {
    return this.current;
  }

  public setTimeout(callback: () => void, milliseconds: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.current + milliseconds, callback });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle);
  }

  public advance(milliseconds: number): void {
    this.current += milliseconds;
    while (this.tasks.size > 0) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.current)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (due === undefined) return;
      this.tasks.delete(due[0]);
      due[1].callback();
    }
  }
}

class FakeSocket implements SocketLike {
  public readyState = 0;
  public readonly sent: string[] = [];
  public readonly closes: Array<{ readonly code?: number; readonly reason?: string }> = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;

  public send(text: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(text);
  }

  public close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }

  public open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  public receive(value: unknown): void {
    this.onmessage?.({ data: value });
  }
}

function createHarness(): { readonly transport: JsonRpcTransport; readonly socket: FakeSocket; readonly timer: ManualTimer; readonly calls: Array<{ readonly url: string; readonly token: string }> } {
  const timer = new ManualTimer();
  const socket = new FakeSocket();
  const calls: Array<{ readonly url: string; readonly token: string }> = [];
  const socketFactory: SocketFactory = (url, options) => {
    calls.push({ url, token: options.headers.Authorization });
    return socket;
  };
  const transport = new JsonRpcTransport({
    address: 'wss://cloud.example.test/agent',
    token: 'secret-token',
    socketFactory,
    timer,
    requestTimeoutMs: 50,
    createRequestId: () => 'rpc-1',
  });
  return { transport, socket, timer, calls };
}

describe('WebSocket JSON-RPC transport', () => {
  it('sends Bearer auth as an upgrade header and never puts the token in the URL', async () => {
    const { transport, socket, calls } = createHarness();
    const opening = transport.open();
    socket.open();
    await opening;

    expect(calls).toEqual([{ url: 'wss://cloud.example.test/agent', token: 'Bearer secret-token' }]);
    expect(calls[0]?.url).not.toContain('secret-token');
  });

  it('settles pending RPCs for success, error, timeout, and close', async () => {
    const successHarness = createHarness();
    const opening = successHarness.transport.open();
    successHarness.socket.open();
    await opening;
    const success = successHarness.transport.request('initialize', { ok: true });
    successHarness.socket.receive(JSON.stringify({ jsonrpc: '2.0', id: 'rpc-1', result: { accepted: true } }));
    await expect(success).resolves.toEqual({ accepted: true });

    const errorHarness = createHarness();
    const errorOpening = errorHarness.transport.open();
    errorHarness.socket.open();
    await errorOpening;
    const failure = errorHarness.transport.request('initialize', {});
    errorHarness.socket.receive(JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-1',
      error: { code: -32004, message: 'resource not found' },
    }));
    await expect(failure).rejects.toMatchObject({ kind: 'rpc', code: -32004 });

    const timeoutHarness = createHarness();
    const timeoutOpening = timeoutHarness.transport.open();
    timeoutHarness.socket.open();
    await timeoutOpening;
    const timeout = timeoutHarness.transport.request('initialize', {});
    timeoutHarness.timer.advance(50);
    await expect(timeout).rejects.toMatchObject({ kind: 'timeout', method: 'initialize' });

    const closeHarness = createHarness();
    const closeOpening = closeHarness.transport.open();
    closeHarness.socket.open();
    await closeOpening;
    const closed = closeHarness.transport.request('initialize', {});
    closeHarness.socket.close(1006, 'network');
    await expect(closed).rejects.toMatchObject({ kind: 'closed', code: 1006 });
  });

  it('emits only schema-validated Host notifications', async () => {
    const { transport, socket } = createHarness();
    const opening = transport.open();
    socket.open();
    await opening;
    const events: unknown[] = [];
    transport.onEvent((event) => events.push(event));
    socket.receive(JSON.stringify({
      jsonrpc: '2.0',
      method: 'client/replaced',
      params: { reason: 'client connection replaced' },
    }));
    socket.receive(JSON.stringify({
      jsonrpc: '2.0',
      method: 'state/action',
      params: { channel: 'agent-root://', serverSeq: 1, serverTime: 't', action: { type: 'unknown' } },
    }));
    expect(events).toEqual([{ type: 'client/replaced', reason: 'client connection replaced' }]);
  });
});
