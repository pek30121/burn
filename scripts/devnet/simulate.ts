/* `npm run devnet:simulate` — NO FUNDS NEEDED, NOTHING IS SENT. Runs the complete token lifecycle
 * (create mint, mint supply, burn, burnChecked, revoke authority) for SPL Token and Token-2022 through the
 * real Devnet runtime with `simulateTransaction` (sigVerify off), and checks the resulting on-chain state:
 * supply arithmetic, revoked authority, program ownership, and the runtime's rejection of invalid burns.
 * A funded public account is only borrowed as an UNSIGNED fee payer of the simulation: no signature of it is
 * used and nothing reaches the chain. This validates our instruction encodings against the real programs. */
import { buildUnsignedTransaction, ix, Keypair, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type Instruction } from './chain.ts';
import { Report } from './check.ts';
import { assertDevnet, latestBlockhash, rentExempt, rpc } from './rpc.ts';

const r = new Report();
await assertDevnet();

async function findFundedPayer(): Promise<string> {
  const top = await rpc<number>('getSlot', [{ commitment: 'finalized' }]);
  for (let s = top - 20; s > top - 60; s--) {
    const b = await rpc<any>('getBlock', [s, { transactionDetails: 'accounts', rewards: false, maxSupportedTransactionVersion: 1 }]).catch(() => null);
    for (const t of b?.transactions ?? []) {
      const payer: string | undefined = t.transaction?.accountKeys?.[0]?.pubkey;
      if (!payer) continue;
      const info = await rpc<any>('getAccountInfo', [payer, { encoding: 'base64' }]);
      if (info?.value?.owner === SYSTEM_PROGRAM && info.value.lamports >= 50_000_000) return payer;
    }
  }
  throw new Error('no funded public account found to borrow as an unsigned fee payer');
}

const u64At = (b: Buffer, o: number) => b.readBigUInt64LE(o);
const MINTED = 1_000_000_000_000n;
const BURN = 1_234_567n;
const BURN_CHECKED = 7_654_321n;

async function simulate(label: string, payer: string, instructions: Instruction[], addresses: string[]) {
  const wire = buildUnsignedTransaction(payer, instructions, await latestBlockhash());
  const res = await rpc<any>('simulateTransaction', [Buffer.from(wire).toString('base64'), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', accounts: { encoding: 'base64', addresses },
  }]);
  return { label, wire, ...res.value } as { err: any; logs: string[]; accounts: ({ data: [string, string]; owner: string } | null)[]; unitsConsumed: number; wire: Uint8Array };
}

const payer = await findFundedPayer();
r.fact('borrowed unsigned fee payer (simulation only)', payer);
const mintRent = await rentExempt(82);
const acctRent = await rentExempt(165);

for (const [name, program] of [['SPL Token', TOKEN_PROGRAM], ['Token-2022', TOKEN_2022_PROGRAM]] as const) {
  const deployed = (await rpc<any>('getAccountInfo', [program, { encoding: 'base64' }])).value !== null;
  if (!deployed) {
    // Not a pass and not a failure: the scenario cannot be executed on this cluster, and is reported as such.
    r.fact(`${name}: NOT EXECUTABLE ON THIS DEVNET`, `program ${program} does not exist on the cluster; nothing was simulated or validated for it`);
    continue;
  }
  const mint = Keypair.generate();
  const acct = Keypair.generate();
  const setup = [
    ix.createAccount(payer, mint.address, mintRent, 82n, program),
    ix.initializeMint2(program, mint.address, 6, payer, null),
    ix.createAccount(payer, acct.address, acctRent, 165n, program),
    ix.initializeAccount3(program, acct.address, mint.address, payer),
    ix.mintTo(program, mint.address, acct.address, payer, MINTED),
  ];
  const lifecycle = [
    ...setup,
    ix.burn(program, acct.address, mint.address, payer, BURN),
    ix.burnChecked(program, acct.address, mint.address, payer, BURN_CHECKED, 6),
    ix.revokeAuthority(program, mint.address, payer, 0),
  ];
  const ok = await simulate(name, payer, lifecycle, [mint.address, acct.address]);
  r.check(`${name}: full lifecycle (create, mint, Burn, BurnChecked, revoke) executes on the real runtime`, ok.err === null, ok.err ? JSON.stringify(ok.err) + ' ' + ok.logs.slice(-3).join(' | ') : `${ok.unitsConsumed} compute units, ${ok.wire.length} bytes`);
  // The current Token program does not log instruction names (so the engine must never rely on logs).
  const invocations = ok.logs.filter((l) => l === `Program ${program} invoke [1]`).length;
  r.check(`${name}: the token program executed each of its ${lifecycle.filter((i) => i.programId === program).length} instructions`, invocations === lifecycle.filter((i) => i.programId === program).length, `${invocations} invocations`);
  if (ok.err === null) {
    const m = Buffer.from(ok.accounts[0]!.data[0], 'base64');
    const a = Buffer.from(ok.accounts[1]!.data[0], 'base64');
    r.check(`${name}: mint account owned by the expected program`, ok.accounts[0]!.owner === program);
    r.check(`${name}: on-chain supply = minted − burned, exactly`, u64At(m, 36) === MINTED - BURN - BURN_CHECKED, `supply ${u64At(m, 36)} raw`);
    r.check(`${name}: mint authority revoked (no further minting possible)`, m.readUInt32LE(0) === 0);
    r.check(`${name}: decimals 6, initialized`, m[44] === 6 && m[45] === 1);
    r.check(`${name}: token account balance equals the supply`, u64At(a, 64) === u64At(m, 36));
  }

  const badDecimals = await simulate(name, payer, [...setup, ix.burnChecked(program, acct.address, mint.address, payer, 1n, 5)], []);
  r.check(`${name}: BurnChecked with wrong decimals is rejected by the runtime (such a tx is "failed" and never counted)`, badDecimals.err !== null, JSON.stringify(badDecimals.err));
  const tooMuch = await simulate(name, payer, [...setup, ix.burn(program, acct.address, mint.address, payer, MINTED + 1n)], []);
  r.check(`${name}: burning more than the balance is rejected`, tooMuch.err !== null, JSON.stringify(tooMuch.err));
  const mintAfterRevoke = await simulate(name, payer, [...setup, ix.revokeAuthority(program, mint.address, payer, 0), ix.mintTo(program, mint.address, acct.address, payer, 1n)], []);
  r.check(`${name}: minting after the authority was revoked is rejected (fixed supply)`, mintAfterRevoke.err !== null, JSON.stringify(mintAfterRevoke.err));
}
r.finish(`simulate-${Date.now()}.json`);
