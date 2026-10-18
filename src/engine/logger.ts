/* One JSON object per line. Every line goes through redact(), so a secret that
 * slips into a field (an error message, a URL) is masked before it is written. */

import { redact } from '../db/errors.ts';
import type { LogLevel } from './config.ts';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(base: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
  readonly base?: Record<string, unknown>;
}

/** JSON.stringify that survives bigint (as decimal strings) and Error objects (message only). */
export function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Error ? v.message : v));
}

export function createLogger(o: LoggerOptions = {}): Logger {
  const min = ORDER[o.level ?? 'info'];
  const write = o.write ?? ((line: string) => void process.stdout.write(line + '\n'));
  const now = o.now ?? (() => new Date());
  const make = (base: Record<string, unknown>): Logger => {
    const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
      if (ORDER[level] < min) return;
      write(redact(jsonSafe({ time: now().toISOString(), level, event, ...base, ...fields })));
    };
    return {
      debug: (e, f) => emit('debug', e, f),
      info: (e, f) => emit('info', e, f),
      warn: (e, f) => emit('warn', e, f),
      error: (e, f) => emit('error', e, f),
      child: (extra) => make({ ...base, ...extra }),
    };
  };
  return make(o.base ?? {});
}
