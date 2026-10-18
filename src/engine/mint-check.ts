/* H2 — check that a project's configured `tokenProgram` is the real on-chain owner of its mint.
 * Without it a wrong program id makes the parser ignore every burn of the project while it still looks "synced"
 * (this exact failure existed for Token-2022, see D23). Messages are explicit, per project, and never contain the
 * RPC URL. A definitive mismatch is a configuration error (the engine refuses to start); a transient RPC failure is
 * NOT a mismatch: it is reported as `unverified` so the project's runner re-checks before its first sync. */

import { TOKEN_PROGRAMS, type ProjectConfig } from '../config/schema.ts';
import { RpcError, type SolanaRpc } from '../chain/rpc.ts';

const NAME_BY_ID = new Map<string, string>(Object.entries(TOKEN_PROGRAMS).map(([name, id]) => [id, name]));

/** Returns the problem description, or null when the mint belongs to the configured token program. Throws on RPC failure. */
export async function mintProgramProblem(rpc: Pick<SolanaRpc, 'getAccountOwner'>, p: ProjectConfig): Promise<string | null> {
  const owner = await rpc.getAccountOwner(p.mint, 'finalized');
  if (owner === null) return `project "${p.id}": the mint ${p.mint} does not exist on ${p.cluster} at finalized commitment (wrong mint or cluster, or not created yet)`;
  const actual = NAME_BY_ID.get(owner);
  if (actual === undefined) return `project "${p.id}": the account ${p.mint} is owned by ${owner}, which is not a token program (it is not a mint)`;
  if (actual !== p.tokenProgram) return `project "${p.id}": tokenProgram is "${p.tokenProgram}" but the mint is owned on-chain by "${actual}"; set tokenProgram to "${actual}" in PROJECTS_CONFIG`;
  return null;
}

export interface MintCheckResult {
  readonly problems: string[];
  /** Projects whose check could not be completed (RPC failure): they must be re-checked before they index anything. */
  readonly unverified: ProjectConfig[];
}

export async function checkMintPrograms(rpc: Pick<SolanaRpc, 'getAccountOwner'>, projects: readonly ProjectConfig[]): Promise<MintCheckResult> {
  const problems: string[] = [];
  const unverified: ProjectConfig[] = [];
  for (const p of projects) {
    try {
      const problem = await mintProgramProblem(rpc, p);
      if (problem) problems.push(problem);
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      unverified.push(p);
    }
  }
  return { problems, unverified };
}
