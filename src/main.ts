/* Engine entry point: `npm start`. Refuses to start on bad configuration (exit code 1),
 * stops cleanly on SIGINT/SIGTERM (second signal = immediate exit), SIGUSR2 logs the status.
 * Signal handlers are installed BEFORE anything starts, so a signal can never kill the
 * process in the middle of start-up work; if one arrives early, the engine stops as soon as it is up. */
import { loadEngineConfig, LOG_LEVELS, type LogLevel } from './engine/config.ts';
import { startEngine, type Engine } from './engine/engine.ts';
import { createLogger, jsonSafe } from './engine/logger.ts';

const level = (LOG_LEVELS as readonly string[]).includes(process.env.LOG_LEVEL ?? '') ? (process.env.LOG_LEVEL as LogLevel) : 'info';
const log = createLogger({ level });

let engine: Engine | undefined;
let earlySignal: string | null = null;
let signals = 0;

const shutdown = (sig: string): void => {
  if (!engine) {
    earlySignal = sig; // still starting: stop right after start-up completes
    return;
  }
  void engine.stop(sig).then((r) => {
    process.exitCode = r.clean ? 0 : 1;
    setTimeout(() => process.exit(), 3_000).unref(); // safety net if something keeps the loop alive
  });
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (++signals > 1) {
      log.error('forced_exit', { signal: sig });
      process.exit(1);
    }
    shutdown(sig);
  });
}
process.on('SIGUSR2', () => void engine?.status().then((s) => log.info('engine_status', JSON.parse(jsonSafe(s)))));
process.on('unhandledRejection', (e) => log.error('unhandled_rejection', { error: e instanceof Error ? e.message : String(e) }));

try {
  const cfg = await loadEngineConfig(process.env);
  engine = await startEngine(cfg, { log: createLogger({ level: cfg.logLevel }) });
} catch (e) {
  log.error('startup_failed', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
if (earlySignal) shutdown(earlySignal);

await engine.stopped;
