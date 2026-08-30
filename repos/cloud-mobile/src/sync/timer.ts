export interface TimerPort {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimer: TimerPort = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, milliseconds: number) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
});
