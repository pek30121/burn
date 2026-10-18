/* Database errors are rewritten so they can never carry the connection string
 * or password: drivers sometimes echo them in messages and stack traces. */

const secrets = new Set<string>();

/** Registers a value (URL, password) that must never appear in an error or log line. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 4) secrets.add(value);
}

export function redact(text: string): string {
  let out = text
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]')
    .replace(/(api[-_]?key|access[-_]?token|secret)=[^&\s"']+/gi, '$1=[redacted]');
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out;
}

export class StoreError extends Error {
  override name = 'StoreError';
  /** SQLSTATE (e.g. "23505") or a Node error code (e.g. "ECONNREFUSED"); null when unknown. */
  readonly code: string | null;
  constructor(message: string, code: string | null = null) {
    super(redact(message));
    this.code = code;
  }
}

export class StaleStateError extends StoreError {
  override name = 'StaleStateError';
}

export class ConfigMismatchError extends StoreError {
  override name = 'ConfigMismatchError';
}

/** Converts anything thrown by the driver into a StoreError without keeping the original (and its secrets). */
export function toStoreError(e: unknown): StoreError {
  if (e instanceof StoreError) return e;
  const err = e as { message?: unknown; code?: unknown } | null;
  const code = typeof err?.code === 'string' ? err.code : null;
  const message = typeof err?.message === 'string' && err.message ? err.message : 'database error';
  return new StoreError(message, code);
}
