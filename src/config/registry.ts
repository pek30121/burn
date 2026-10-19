/* Holds every project served by one engine instance. Projects are fully
 * isolated: unique ids, and a given (cluster, mint) belongs to exactly one
 * project so a burn can never be attributed to two of them. */

import { readFile } from 'node:fs/promises';
import { ConfigError, isPendingInput, parsePendingProject, parseProjectConfig, type Cluster, type PendingProject, type ProjectConfig } from './schema.ts';

export class ProjectRegistry {
  readonly #byId = new Map<string, ProjectConfig>();
  readonly #byMint = new Map<string, { id: string }>();
  readonly #pending = new Map<string, PendingProject>();

  constructor(inputs: readonly unknown[]) {
    const issues: string[] = [];
    inputs.forEach((input, i) => {
      let p: ProjectConfig | PendingProject;
      try {
        p = isPendingInput(input) ? parsePendingProject(input, `projects[${i}]`) : parseProjectConfig(input, `projects[${i}]`);
      } catch (e) {
        if (e instanceof ConfigError) return void issues.push(...e.issues);
        throw e;
      }
      const mintKey = `${p.cluster}:${p.mint}`;
      if (this.#byId.has(p.id) || this.#pending.has(p.id)) issues.push(`projects[${i}].id: duplicate project id "${p.id}"`);
      else if (this.#byMint.has(mintKey)) {
        issues.push(`projects[${i}].mint: already used by project "${this.#byMint.get(mintKey)!.id}" on ${p.cluster}`);
      } else {
        if ('levels' in p) this.#byId.set(p.id, p);
        else this.#pending.set(p.id, p);
        this.#byMint.set(mintKey, p);
      }
    });
    if (issues.length) throw new ConfigError(issues);
  }

  static async fromFile(path: string): Promise<ProjectRegistry> {
    const json: unknown = JSON.parse(await readFile(path, 'utf8'));
    const list = Array.isArray(json) ? json : (json as { projects?: unknown }).projects;
    if (!Array.isArray(list)) throw new ConfigError([`${path}: expected an array or { "projects": [...] }`]);
    return new ProjectRegistry(list);
  }

  /** Active projects only (their mint is known to exist: they are what the engine indexes at start). */
  get(id: string): ProjectConfig | undefined {
    return this.#byId.get(id);
  }

  /** Projects declared with `awaitMint`: watched until their mint exists on-chain, then activated by the engine itself. */
  pending(): PendingProject[] {
    return [...this.#pending.values()];
  }

  getPending(id: string): PendingProject | undefined {
    return this.#pending.get(id);
  }

  require(id: string): ProjectConfig {
    const p = this.#byId.get(id);
    if (!p) throw new Error(`unknown project "${id}"`);
    return p;
  }

  byMint(cluster: Cluster, mint: string): ProjectConfig | undefined {
    const id = this.#byMint.get(`${cluster}:${mint}`)?.id;
    return id === undefined ? undefined : this.#byId.get(id);
  }

  list(): ProjectConfig[] {
    return [...this.#byId.values()];
  }
}
