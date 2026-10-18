/* Minimal assertion recorder for the validation scripts: prints PASS/FAIL lines and a final summary. */
import { mkdirSync, writeFileSync } from 'node:fs';

export class Report {
  readonly results: { name: string; ok: boolean; detail?: string }[] = [];
  readonly facts: Record<string, unknown> = {};

  check(name: string, ok: boolean, detail?: string): void {
    this.results.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  }

  fact(key: string, value: unknown): void {
    this.facts[key] = value;
    console.log(`INFO  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }

  finish(file: string): boolean {
    const failed = this.results.filter((r) => !r.ok);
    console.log(`\n${this.results.length - failed.length}/${this.results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
    const out = new URL(`../../.devnet/results/${file}`, import.meta.url).pathname;
    mkdirSync(new URL('../../.devnet/results/', import.meta.url).pathname, { recursive: true });
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results: this.results, facts: this.facts }, null, 2));
    if (failed.length) process.exitCode = 1;
    return failed.length === 0;
  }
}
