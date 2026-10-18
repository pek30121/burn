/* Per-token project configuration. Everything that changes between launches
 * (mint, names, levels) lives here; nothing visual does. Input is untrusted
 * JSON, so it is validated field by field and every problem is reported. */

import { assertDecimals, parseUiAmount, U64_MAX } from '../core/amount.ts';
import { isPublicKey } from '../core/base58.ts';

export const CLUSTERS = ['devnet', 'mainnet-beta'] as const;
export type Cluster = (typeof CLUSTERS)[number];

export const TOKEN_PROGRAMS = {
  'spl-token': 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'token-2022': 'TokenzQdBNbLqP5VEhdkAS6EnX6xJ9yS4aCc58B6zN9',
} as const;
export type TokenProgram = keyof typeof TOKEN_PROGRAMS;

export interface Level {
  readonly id: string;
  readonly name: string;
  /** Cumulative burned amount (raw base units) at which the level is reached. */
  readonly thresholdRaw: bigint;
}

export interface ProjectConfig {
  readonly id: string;
  readonly name: string;
  readonly ticker: string;
  readonly cluster: Cluster;
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram: TokenProgram;
  /** Supply right after creation (raw units), if known. Enables the supply reconciliation proof. */
  readonly initialSupplyRaw: bigint | null;
  /** Burns in slots before this one are ignored (e.g. count only after launch). */
  readonly startSlot: number;
  /** Sorted by threshold, strictly increasing; levels[0].thresholdRaw === 0n. */
  readonly levels: readonly Level[];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`invalid project config:\n  - ${issues.join('\n  - ')}`);
    this.issues = issues;
  }
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(o: Obj, key: string, path: string, issues: string[], max = 64): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) {
    issues.push(`${path}.${key}: expected a non-empty string (max ${max} chars)`);
    return '';
  }
  return v.trim();
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[], path: string, issues: string[]): T {
  const v = o[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    issues.push(`${path}.${key}: expected one of ${allowed.join(', ')}`);
    return allowed[0] as T;
  }
  return v as T;
}

export function parseProjectConfig(input: unknown, path = 'project'): ProjectConfig {
  const issues: string[] = [];
  if (!isObj(input)) throw new ConfigError([`${path}: expected an object`]);

  const id = str(input, 'id', path, issues);
  if (id && !SLUG.test(id)) issues.push(`${path}.id: must be a lowercase slug (a-z, 0-9, -)`);
  const name = str(input, 'name', path, issues);
  const ticker = str(input, 'ticker', path, issues, 16);
  const cluster = oneOf(input, 'cluster', CLUSTERS, path, issues);
  const tokenProgram = oneOf(input, 'tokenProgram', Object.keys(TOKEN_PROGRAMS) as TokenProgram[], path, issues);

  const mint = str(input, 'mint', path, issues);
  if (mint && !isPublicKey(mint)) issues.push(`${path}.mint: not a valid Solana address`);

  let decimals = 0;
  try {
    assertDecimals(input.decimals as number);
    decimals = input.decimals as number;
  } catch (e) {
    issues.push(`${path}.decimals: ${(e as Error).message}`);
  }

  let startSlot = 0;
  if (input.startSlot !== undefined) {
    if (!Number.isSafeInteger(input.startSlot) || (input.startSlot as number) < 0) {
      issues.push(`${path}.startSlot: expected a non-negative integer`);
    } else startSlot = input.startSlot as number;
  }

  let initialSupplyRaw: bigint | null = null;
  if (input.initialSupply !== undefined) {
    try {
      initialSupplyRaw = parseUiAmount(input.initialSupply as string | number, decimals);
      if (initialSupplyRaw === 0n) issues.push(`${path}.initialSupply: must be greater than 0`);
    } catch (e) {
      issues.push(`${path}.initialSupply: ${(e as Error).message}`);
    }
  }

  const levels: Level[] = [];
  if (!Array.isArray(input.levels) || input.levels.length === 0) {
    issues.push(`${path}.levels: expected a non-empty array`);
  } else {
    const seen = new Set<string>();
    input.levels.forEach((raw: unknown, i: number) => {
      const lp = `${path}.levels[${i}]`;
      if (!isObj(raw)) return void issues.push(`${lp}: expected an object`);
      const lid = str(raw, 'id', lp, issues);
      if (lid && !SLUG.test(lid)) issues.push(`${lp}.id: must be a lowercase slug`);
      if (lid && seen.has(lid)) issues.push(`${lp}.id: duplicate level id "${lid}"`);
      seen.add(lid);
      const lname = str(raw, 'name', lp, issues);
      let thresholdRaw = -1n;
      const t = raw.threshold;
      if (typeof t !== 'string' && typeof t !== 'number') {
        issues.push(`${lp}.threshold: expected a decimal string (UI units), e.g. "1000000"`);
      } else {
        try {
          thresholdRaw = parseUiAmount(t, decimals);
        } catch (e) {
          issues.push(`${lp}.threshold: ${(e as Error).message}`);
        }
      }
      levels.push({ id: lid, name: lname, thresholdRaw });
    });

    if (levels[0] && levels[0].thresholdRaw > 0n) {
      issues.push(`${path}.levels[0].threshold: the first level must start at 0`);
    }
    for (let i = 1; i < levels.length; i++) {
      const prev = levels[i - 1]!.thresholdRaw;
      const cur = levels[i]!.thresholdRaw;
      if (prev >= 0n && cur >= 0n && cur <= prev) {
        issues.push(`${path}.levels[${i}].threshold: thresholds must be strictly increasing`);
      }
    }
    if (levels.some((l) => l.thresholdRaw > U64_MAX)) issues.push(`${path}.levels: threshold exceeds u64`);
  }

  if (issues.length) throw new ConfigError(issues);
  return deepFreeze({ id, name, ticker, cluster, mint, decimals, tokenProgram, initialSupplyRaw, startSlot, levels });
}

function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
