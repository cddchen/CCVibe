const PREFIX = "[cc-daemon]";

export const log = {
  info: (...args: unknown[]) => console.log(PREFIX, ...args),
  warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
  error: (...args: unknown[]) => console.error(PREFIX, ...args),
  debug: (...args: unknown[]) => {
    if (process.env.CC_DAEMON_DEBUG === "1") console.log(PREFIX, "[debug]", ...args);
  },
};