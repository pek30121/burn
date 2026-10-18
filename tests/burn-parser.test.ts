import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBurns, toBurnInput, type ParsedTransaction } from '../src/chain/burn-parser.ts';
import { BurnLedger } from '../src/core/ledger.ts';
import { parseProjectConfig } from '../src/config/schema.ts';
import { randomPubkey, randomSignature, MINT_A, projectInput } from './helpers.ts';
import {
  K, TOKEN, TOKEN_2022, baseKeys, burnCheckedIx, burnData, burnIx, makeTx, rawData, staticKeys,
} from './chain-helpers.ts';

const k = baseKeys();
const opts = { mint: MINT_A };

const show = (r: unknown) => JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));

function ok(r: ParsedTransaction) {
  assert.equal(r.status, 'ok', r.status === 'ok' ? undefined : show(r));
  return r.status === 'ok' ? r : (undefined as never);
}
function malformed(r: ParsedTransaction, pattern: RegExp) {
  assert.equal(r.status, 'malformed', show(r));
  assert.match(r.status === 'malformed' ? r.reason : '', pattern);
}

/* ---------- normal cases ---------- */

test('direct Burn on the SPL Token program', () => {
  const sig = randomSignature();
  const r = ok(parseBurns(makeTx(k, { signature: sig, slot: 77, instructions: [burnIx(1_500_000n)] }), opts));
  assert.equal(r.burns.length, 1);
  assert.deepEqual(r.burns[0], {
    mint: MINT_A, signature: sig, instructionPath: '0', slot: 77, blockTime: 1_700_000_000,
    tokenProgram: 'spl-token', kind: 'burn', tokenAccount: k.acct, authority: k.auth, holder: null,
    amountRaw: 1_500_000n, decimals: null,
  });
  assert.ok(r.complete);
  assert.equal(r.version, 'legacy');
});

test('BurnChecked on Token-2022 carries its decimals', () => {
  const r = ok(parseBurns(makeTx(k, { instructions: [burnCheckedIx(42n, 6, { program: K.token22 })] }), { ...opts, decimals: 6 }));
  assert.equal(r.burns[0]!.tokenProgram, 'token-2022');
  assert.equal(r.burns[0]!.kind, 'burnChecked');
  assert.equal(r.burns[0]!.decimals, 6);
  assert.equal(r.burns[0]!.amountRaw, 42n);
});

test('u64 amounts stay exact (no float rounding)', () => {
  const max = 2n ** 64n - 1n;
  assert.equal(ok(parseBurns(makeTx(k, { instructions: [burnIx(max)] }), opts)).burns[0]!.amountRaw, max);
  const odd = 9_007_199_254_740_993n; // 2^53 + 1
  assert.equal(ok(parseBurns(makeTx(k, { instructions: [burnIx(odd)] }), opts)).burns[0]!.amountRaw, odd);
});

test('holder comes from token balance metadata; authority is kept separately', () => {
  const holder = randomPubkey();
  const r = ok(parseBurns(makeTx(k, {
    instructions: [burnIx(5n)],
    preTokenBalances: [{ accountIndex: K.acct, mint: MINT_A, owner: holder }],
  }), opts));
  assert.equal(r.burns[0]!.holder, holder);
  assert.equal(r.burns[0]!.authority, k.auth);
  assert.equal(toBurnInput(r.burns[0]!, 'finalized').owner, holder);
  // metadata for another mint or account is not trusted
  const r2 = ok(parseBurns(makeTx(k, {
    instructions: [burnIx(5n)],
    preTokenBalances: [{ accountIndex: K.acct, mint: k.otherMint, owner: holder }, { accountIndex: K.otherAcct, mint: MINT_A, owner: holder }],
  }), opts));
  assert.equal(r2.burns[0]!.holder, null);
  assert.equal(toBurnInput(r2.burns[0]!, 'confirmed').owner, k.auth);
});

test('trailing bytes after the fixed fields are accepted, like the on-chain unpacker', () => {
  const ix = { ...burnIx(7n), data: burnData(7n, [0, 0, 1]) };
  assert.equal(ok(parseBurns(makeTx(k, { instructions: [ix] }), opts)).burns[0]!.amountRaw, 7n);
});

/* ---------- CPI (inner instructions) ---------- */

test('CPI burn is found with the "outer.inner" path; direct and CPI burns coexist in order', () => {
  const r = ok(parseBurns(makeTx(k, {
    instructions: [burnIx(1n), { programIdIndex: K.fake, accounts: [], data: rawData([1]) }, burnIx(3n)],
    inner: [
      { index: 1, instructions: [{ programIdIndex: K.fake, accounts: [], data: rawData([2]) }, burnIx(20n), burnCheckedIx(21n, 6)] },
    ],
  }), opts));
  assert.deepEqual(r.burns.map((b) => [b.instructionPath, b.amountRaw]), [['0', 1n], ['1.1', 20n], ['1.2', 21n], ['2', 3n]]);
});

test('inner instructions recorded for several outer instructions keep distinct paths', () => {
  const r = ok(parseBurns(makeTx(k, {
    instructions: [{ programIdIndex: K.fake, accounts: [], data: rawData([1]) }, { programIdIndex: K.fake, accounts: [], data: rawData([1]) }],
    inner: [{ index: 1, instructions: [burnIx(2n)] }, { index: 0, instructions: [burnIx(1n)] }],
  }), opts));
  assert.deepEqual(r.burns.map((b) => b.instructionPath), ['0.0', '1.0']);
});

test('missing inner instructions are reported as an incomplete parse, an empty list is complete', () => {
  const none = ok(parseBurns(makeTx(k, { instructions: [burnIx(1n)], inner: null }), opts));
  assert.equal(none.complete, false);
  assert.deepEqual(none.warnings, [{ code: 'inner_instructions_unavailable' }]);
  assert.equal(none.burns.length, 1);
  assert.equal(ok(parseBurns(makeTx(k, { instructions: [burnIx(1n)], inner: [] }), opts)).complete, true);
});

/* ---------- versioned transactions / address lookup tables ---------- */

test('v0: accounts loaded from lookup tables are resolved (writable first, then read-only)', () => {
  const keys = [k.payer, k.auth, TOKEN]; // static: 0,1,2
  const acct = randomPubkey();
  const roProgram = randomPubkey();
  // loaded: writable [acct, MINT_A] -> 3,4 ; readonly [roProgram] -> 5
  const ix = { programIdIndex: 2, accounts: [3, 4, 1], data: burnData(99n) };
  const r = ok(parseBurns(makeTx(k, {
    keys, version: 0, instructions: [ix],
    loaded: { writable: [acct, MINT_A], readonly: [roProgram] },
    lookups: [{ accountKey: randomPubkey(), writableIndexes: [0, 1], readonlyIndexes: [2] }],
  }), opts));
  assert.equal(r.version, 0);
  assert.equal(r.burns[0]!.tokenAccount, acct);
  assert.equal(r.burns[0]!.authority, k.auth);
});

test('v0: the token program itself may come from a CPI-only lookup index; a burn through a table-loaded mint of another token is ignored', () => {
  const keys = [k.payer, k.auth, TOKEN];
  const ix = { programIdIndex: 2, accounts: [3, 4, 1], data: burnData(5n) };
  const r = ok(parseBurns(makeTx(k, {
    keys, version: 0, instructions: [ix],
    loaded: { writable: [randomPubkey(), randomPubkey()], readonly: [] },
    lookups: [{ accountKey: randomPubkey(), writableIndexes: [0, 1], readonlyIndexes: [] }],
  }), opts));
  assert.equal(r.burns.length, 0);
});

test('v0: loaded addresses that do not match the lookups are malformed, never guessed', () => {
  const lookups = [{ accountKey: randomPubkey(), writableIndexes: [0, 1], readonlyIndexes: [] }];
  malformed(parseBurns(makeTx(k, { version: 0, instructions: [], lookups, loaded: { writable: [randomPubkey()], readonly: [] } }), opts), /do not match/);
  malformed(parseBurns(makeTx(k, { version: 0, instructions: [], lookups }), opts), /do not match/);
  malformed(parseBurns(makeTx(k, { instructions: [], loaded: { writable: [randomPubkey()], readonly: [] } }), opts), /do not match/);
});

test('v1 transactions parse; unknown versions are refused', () => {
  assert.equal(ok(parseBurns(makeTx(k, { version: 1, instructions: [burnIx(2n)] }), opts)).version, 1);
  malformed(parseBurns(makeTx(k, { version: 2, instructions: [burnIx(2n)] }), opts), /unsupported transaction version/);
  malformed(parseBurns(makeTx(k, { version: 'legacyish', instructions: [] }), opts), /unsupported transaction version/);
});

/* ---------- things that must NOT be counted ---------- */

test('failed transactions are never counted', () => {
  const r = parseBurns(makeTx(k, { err: { InstructionError: [0, 'Custom'] }, instructions: [burnIx(1000n)] }), opts);
  assert.equal(r.status, 'failed');
  assert.equal(r.status === 'failed' && r.slot, 1234);
});

test('another mint, another program, or a look-alike instruction is ignored', () => {
  const r = ok(parseBurns(makeTx(k, {
    instructions: [
      burnIx(1n, { mint: K.otherMint, acct: K.otherAcct }), // other token
      burnIx(2n, { program: K.fake }), // tag 8 on an arbitrary program
      { programIdIndex: K.token, accounts: [K.acct, K.mint, K.auth], data: rawData([3, 1, 0, 0, 0, 0, 0, 0, 0]) }, // Transfer, not Burn
      { programIdIndex: K.token, accounts: [K.acct, K.mint, K.auth], data: '' },
    ],
    inner: [{ index: 0, instructions: [burnIx(4n, { program: K.fake })] }],
  }), opts));
  assert.equal(r.burns.length, 0);
});

test('the mint must be the 2nd account: the same key in another slot is not a burn of it', () => {
  const ix = { programIdIndex: K.token, accounts: [K.mint, K.acct, K.auth], data: burnData(5n) };
  assert.equal(ok(parseBurns(makeTx(k, { instructions: [ix] }), opts)).burns.length, 0);
});

test('zero-amount burns are ignored with a warning', () => {
  const r = ok(parseBurns(makeTx(k, { instructions: [burnIx(0n)] }), opts));
  assert.equal(r.burns.length, 0);
  assert.deepEqual(r.warnings, [{ code: 'zero_amount_burn_ignored', path: '0' }]);
});

test('a project bound to one token program ignores burns by the other', () => {
  const tx = makeTx(k, { instructions: [burnIx(1n, { program: K.token22 })] });
  const r = ok(parseBurns(tx, { ...opts, tokenProgram: 'spl-token' }));
  assert.equal(r.burns.length, 0);
  assert.deepEqual(r.warnings, [{ code: 'other_token_program_ignored', path: '0' }]);
  assert.equal(ok(parseBurns(tx, { ...opts, tokenProgram: 'token-2022' })).burns.length, 1);
});

/* ---------- malformed input ---------- */

test('malformed responses are reported, never silently treated as "no burn"', () => {
  const good = () => makeTx(k, { instructions: [burnIx(1n)] });
  const mut = (f: (t: any) => void) => {
    const t = good();
    f(t);
    return t;
  };
  malformed(parseBurns(null, opts), /expected an object/);
  malformed(parseBurns({}, opts), /slot/);
  malformed(parseBurns(mut((t) => delete t.meta), opts), /meta/);
  malformed(parseBurns(mut((t) => delete t.meta.err), opts), /meta\.err/);
  malformed(parseBurns(mut((t) => (t.transaction.signatures = ['nope'])), opts), /signature/);
  malformed(parseBurns(mut((t) => (t.transaction.signatures = [])), opts), /signature/);
  malformed(parseBurns(mut((t) => (t.slot = -1)), opts), /slot/);
  malformed(parseBurns(mut((t) => (t.slot = 1.5)), opts), /slot/);
  malformed(parseBurns(mut((t) => (t.transaction.message.instructions[0].programIdIndex = 99)), opts), /out of range/);
  malformed(parseBurns(mut((t) => (t.transaction.message.instructions[0].accounts = [1, 2])), opts), /at least 3 accounts/);
  malformed(parseBurns(mut((t) => (t.transaction.message.instructions[0].accounts = [1, 2, 99])), opts), /out of range/);
  malformed(parseBurns(mut((t) => (t.transaction.message.instructions[0].accounts = 'x')), opts), /accounts/);
  malformed(parseBurns(mut((t) => (t.transaction.message.instructions[0].data = rawData([8, 1, 2]))), opts), /too short/);
  malformed(parseBurns(mut((t) => (t.transaction.message.instructions[0].data = 7)), opts), /data/);
  malformed(parseBurns(mut((t) => (t.transaction.message.instructions[0].data = '0OIl')), opts), /base58/);
  malformed(parseBurns(mut((t) => (t.transaction.message.accountKeys = 'x')), opts), /accountKeys/);
  malformed(parseBurns(mut((t) => (t.meta.innerInstructions = [{ index: 5, instructions: [] }])), opts), /no outer instruction/);
  malformed(parseBurns(mut((t) => (t.meta.innerInstructions = [{ index: 0, instructions: [] }, { index: 0, instructions: [] }])), opts), /duplicate group/);
  malformed(parseBurns(mut((t) => (t.meta.innerInstructions = [{ index: 0, instructions: [{ programIdIndex: 99, accounts: [], data: '' }] }])), opts), /out of range/);
});

test('BurnChecked with decimals different from the configured ones is malformed', () => {
  malformed(parseBurns(makeTx(k, { instructions: [burnCheckedIx(1n, 9)] }), { ...opts, decimals: 6 }), /decimals 9 differ/);
  assert.equal(ok(parseBurns(makeTx(k, { instructions: [burnCheckedIx(1n, 9)] }), opts)).burns.length, 1); // no expectation given
});

test('the response must be the transaction that was requested', () => {
  const sig = randomSignature();
  const tx = makeTx(k, { signature: sig, instructions: [burnIx(1n)] });
  assert.equal(ok(parseBurns(tx, { ...opts, expectedSignature: sig })).burns.length, 1);
  malformed(parseBurns(tx, { ...opts, expectedSignature: randomSignature() }), /different transaction/);
});

/* ---------- duplicates ---------- */

test('parsing the same transaction twice yields identical burns, and the ledger counts them once', () => {
  const project = parseProjectConfig(projectInput());
  const ledger = new BurnLedger(project);
  const tx = makeTx(k, {
    instructions: [burnIx(10n), { programIdIndex: K.fake, accounts: [], data: rawData([1]) }],
    inner: [{ index: 1, instructions: [burnIx(5n)] }],
  });
  for (let pass = 0; pass < 3; pass++) {
    for (const b of ok(parseBurns(tx, opts)).burns) ledger.record(toBurnInput(b, 'finalized'));
  }
  assert.equal(ledger.finalizedRaw, 15n); // 10 + 5, once each
  assert.equal(ledger.count, 2);
  assert.deepEqual(parseBurns(tx, opts), parseBurns(tx, opts));
});

test('two identical burn instructions in one transaction are two burns at different positions', () => {
  const r = ok(parseBurns(makeTx(k, { instructions: [burnIx(5n), burnIx(5n)] }), opts));
  assert.deepEqual(r.burns.map((b) => b.instructionPath), ['0', '1']);
  assert.equal(new Set(r.burns.map((b) => `${b.signature}#${b.instructionPath}`)).size, 2);
});

test('parser output is accepted by the ledger as-is (addresses, paths, amounts all valid)', () => {
  const ledger = new BurnLedger(parseProjectConfig(projectInput()));
  const r = ok(parseBurns(makeTx(k, { instructions: [burnIx(1n)], inner: [{ index: 0, instructions: [burnIx(2n)] }] }), opts));
  const statuses = r.burns.map((b) => ledger.record(toBurnInput(b, 'confirmed')).status);
  assert.deepEqual(statuses, ['inserted', 'inserted']);
});

/* ---------- real Devnet transactions ---------- */

for (const n of [1, 2, 3]) {
  test(`real Devnet CPI burn #${n}: parsed amount equals the token balance change`, () => {
    const fx = JSON.parse(readFileSync(new URL(`./fixtures/devnet-cpi-burn-${n}.json`, import.meta.url), 'utf8'));
    const r = ok(parseBurns(fx.response, { mint: fx.mint, expectedSignature: fx.signature }));
    const burn = r.burns.find((b) => b.instructionPath === fx.path);
    assert.ok(burn, `burn at ${fx.path} not found`);
    assert.equal(burn.tokenProgram, 'spl-token');
    assert.equal(r.version, 0);

    // independent check against the node's own balance metadata
    const m = fx.response.meta;
    const keys = [...fx.response.transaction.message.accountKeys, ...(m.loadedAddresses?.writable ?? []), ...(m.loadedAddresses?.readonly ?? [])];
    const idx = keys.indexOf(burn.tokenAccount);
    const pre = m.preTokenBalances.find((x: any) => x.accountIndex === idx);
    const post = m.postTokenBalances.find((x: any) => x.accountIndex === idx);
    assert.equal(BigInt(pre.uiTokenAmount.amount) - BigInt(post?.uiTokenAmount.amount ?? '0'), burn.amountRaw);
    assert.equal(burn.holder, pre.owner);
    // the same transaction seen for a different mint yields nothing
    assert.equal(ok(parseBurns(fx.response, { mint: MINT_A })).burns.length, 0);
  });
}

test('real Devnet direct (outer) Burn on a legacy transaction', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/devnet-direct-burn.json', import.meta.url), 'utf8'));
  const r = ok(parseBurns(fx.response, { mint: fx.mint, expectedSignature: fx.signature }));
  assert.equal(r.version, 'legacy');
  const burn = r.burns.find((b) => b.instructionPath === fx.path);
  assert.ok(burn);
  assert.ok(!fx.path.includes('.'), 'fixture must be an outer instruction');
  const m = fx.response.meta;
  const idx = fx.response.transaction.message.accountKeys.indexOf(burn.tokenAccount);
  const pre = m.preTokenBalances.find((x: any) => x.accountIndex === idx);
  const post = m.postTokenBalances.find((x: any) => x.accountIndex === idx);
  assert.equal(BigInt(pre.uiTokenAmount.amount) - BigInt(post?.uiTokenAmount.amount ?? '0'), burn.amountRaw);
});

test('real Devnet v1 and v0-with-lookup-table transactions parse without false burns', () => {
  const v1 = JSON.parse(readFileSync(new URL('./fixtures/devnet-v1-tx.json', import.meta.url), 'utf8'));
  const r1 = ok(parseBurns(v1.response, { mint: MINT_A, expectedSignature: v1.signature }));
  assert.equal(r1.version, 1);
  assert.equal(r1.burns.length, 0);

  const v0 = JSON.parse(readFileSync(new URL('./fixtures/devnet-v0-lookup-tx.json', import.meta.url), 'utf8'));
  const loaded = v0.response.meta.loadedAddresses;
  assert.ok(loaded.writable.length + loaded.readonly.length > 0, 'fixture must really use a lookup table');
  const r0 = ok(parseBurns(v0.response, { mint: MINT_A, expectedSignature: v0.signature }));
  assert.equal(r0.version, 0);
  // Treating a table-loaded account as the mint must not produce a burn: the transaction has none.
  for (const key of [...loaded.writable, ...loaded.readonly]) {
    assert.equal(ok(parseBurns(v0.response, { mint: key })).burns.length, 0);
  }
});
