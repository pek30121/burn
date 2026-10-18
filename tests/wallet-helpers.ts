/* Test doubles for the wallet module. `MockWallet` stands in for a browser extension: IT holds the test key and
 * signs; the code under test only ever receives the signed bytes (as with a real Wallet Standard wallet).
 * Nothing here is a real Phantom/Solflare. */
import { Keypair } from '../scripts/devnet/chain.ts';
import { encodeBase58, decodeBase58 } from '../src/core/base58.ts';
import { TOKEN_PROGRAMS } from '../src/config/schema.ts';
import type { EngineApi, EngineStatus, EventsPage, CountedBurn } from '../src/wallet/engine-client.ts';
import type { RawAccount, SignatureStatus, SimulationResult, WalletCommitment, WalletRpc } from '../src/wallet/rpc.ts';
import { splitTransaction, toBase64 } from '../src/wallet/tx.ts';
import type { StdAccount, StdWallet, EventHost } from '../src/wallet/wallet-standard.ts';
import { randomSignature } from './helpers.ts';

export const sleepFast = async () => { await new Promise((r) => setImmediate(r)); };

/* ------------------------------ account byte builders ------------------------------ */

const put32 = (b: Uint8Array, at: number, addr: string) => b.set(decodeBase58(addr)!, at);
export function mintBytes(o: { decimals: number; supply: bigint; mintAuthority?: string | null; extensions?: { type: number; data: Uint8Array }[] }): Uint8Array {
  const ext = o.extensions ?? [];
  const tlv = ext.flatMap((e) => [e.type & 0xff, e.type >> 8, e.data.length & 0xff, e.data.length >> 8, ...e.data]);
  const b = new Uint8Array(ext.length ? 166 + tlv.length : 82);
  const v = new DataView(b.buffer);
  if (o.mintAuthority) { v.setUint32(0, 1, true); put32(b, 4, o.mintAuthority); }
  v.setBigUint64(36, o.supply, true);
  b[44] = o.decimals;
  b[45] = 1;
  if (ext.length) { b[165] = 1; b.set(tlv, 166); }
  return b;
}
export function tokenAccountBytes(o: { mint: string; owner: string; amount: bigint; frozen?: boolean; native?: boolean; delegate?: string; extensions?: { type: number; data: Uint8Array }[] }): Uint8Array {
  const ext = o.extensions ?? [];
  const tlv = ext.flatMap((e) => [e.type & 0xff, e.type >> 8, e.data.length & 0xff, e.data.length >> 8, ...e.data]);
  const b = new Uint8Array(ext.length ? 166 + tlv.length : 165);
  const v = new DataView(b.buffer);
  put32(b, 0, o.mint);
  put32(b, 32, o.owner);
  v.setBigUint64(64, o.amount, true);
  if (o.delegate) { v.setUint32(72, 1, true); put32(b, 76, o.delegate); }
  b[108] = o.frozen ? 2 : 1;
  if (o.native) v.setUint32(109, 1, true);
  if (ext.length) { b[165] = 2; b.set(tlv, 166); }
  return b;
}

/* ----------------------------------- mock wallet ----------------------------------- */

export class MockWallet implements StdWallet {
  readonly name: string;
  readonly icon = 'data:image/svg+xml;base64,';
  readonly version = '1.0.0';
  chains: string[];
  accounts: StdAccount[] = [];
  features: Record<string, any>;
  readonly signed: Uint8Array[] = []; // transactions this "extension" was asked to sign
  rejectNext = false;
  tamper: ((signed: Uint8Array) => Uint8Array) | null = null;
  unsignedReply = false;
  readonly #listeners = new Set<(p: any) => void>();
  readonly #keys = new Map<string, Keypair>();

  constructor(name: string, keys: Keypair[], o: { chains?: string[]; signAndSendOnly?: ((tx: Uint8Array) => Promise<Uint8Array>) | null; noDisconnect?: boolean } = {}) {
    this.name = name;
    this.chains = o.chains ?? ['solana:mainnet', 'solana:devnet'];
    for (const k of keys) this.#keys.set(k.address, k);
    this.features = {
      'standard:connect': { version: '1.0.0', connect: async () => { this.accounts = keys.slice(0, 1).map((k) => this.#account(k)); return { accounts: this.accounts }; } },
      'standard:events': { version: '1.0.0', on: (_e: string, l: (p: any) => void) => { this.#listeners.add(l); return () => this.#listeners.delete(l); } },
    };
    if (!o.noDisconnect) this.features['standard:disconnect'] = { version: '1.0.0', disconnect: async () => { this.accounts = []; } };
    if (!o.signAndSendOnly) {
      this.features['solana:signTransaction'] = {
        version: '1.0.0', supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs: { account: StdAccount; transaction: Uint8Array; chain?: string }[]) => {
          if (this.rejectNext) { this.rejectNext = false; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
          const i = inputs[0]!;
          const kp = this.#keys.get(i.account.address);
          if (!kp) throw new Error('unknown account');
          this.signed.push(i.transaction);
          const { message } = splitTransaction(i.transaction);
          let out: Uint8Array = Uint8Array.from([1, ...(this.unsignedReply ? new Array(64).fill(0) : kp.sign(message)), ...message]);
          if (this.tamper) out = this.tamper(out);
          return [{ signedTransaction: out }];
        },
      };
    } else {
      const send = o.signAndSendOnly;
      this.features['solana:signAndSendTransaction'] = {
        version: '1.0.0', supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async (...inputs: { account: StdAccount; transaction: Uint8Array }[]) => {
          if (this.rejectNext) { this.rejectNext = false; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
          const i = inputs[0]!;
          const kp = this.#keys.get(i.account.address)!;
          const { message } = splitTransaction(i.transaction);
          const signed = Uint8Array.from([1, ...kp.sign(message), ...message]);
          return [{ signature: await send(signed) }];
        },
      };
    }
  }

  #account(k: Keypair): StdAccount {
    return { address: k.address, publicKey: k.publicKey, chains: this.chains.filter((c) => c.startsWith('solana:')), features: ['solana:signTransaction'] };
  }
  emit(p: { accounts?: StdAccount[]; chains?: string[]; features?: unknown }): void { for (const l of this.#listeners) l(p); }
  /** The user picks another account inside the wallet UI. */
  switchTo(k: Keypair): void { this.accounts = [this.#account(k)]; this.emit({ accounts: this.accounts }); }
  /** The user disconnects from the wallet UI. */
  walletSideDisconnect(): void { this.accounts = []; this.emit({ accounts: [] }); }
  /** Network switch inside the wallet: accounts now only support these chains. */
  setNetwork(chains: string[]): void {
    this.accounts = this.accounts.map((a) => ({ ...a, chains }));
    this.emit({ accounts: this.accounts, chains });
  }
}

/** A `window`-like host honouring the Wallet Standard registration events. */
export function fakeWindow(): EventHost & { registerWallet(w: StdWallet): void } {
  const target = new EventTarget();
  return {
    addEventListener: (t, l) => target.addEventListener(t, l),
    removeEventListener: (t, l) => target.removeEventListener(t, l),
    dispatchEvent: (e) => target.dispatchEvent(e),
    // What a wallet extension does: announce itself, and answer 'app-ready' for apps that load later.
    registerWallet(w) {
      const cb = (api: { register: (...w: StdWallet[]) => void }) => api.register(w);
      target.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: cb }));
      target.addEventListener('wallet-standard:app-ready', (e) => cb((e as CustomEvent).detail));
    },
  };
}

/* ------------------------------------- fake RPC ------------------------------------- */

export class FakeRpc implements WalletRpc {
  genesis: string;
  accounts = new Map<string, RawAccount>();
  tokenAccounts: { address: string; account: RawAccount }[] = [];
  balances = new Map<string, bigint>();
  fee: bigint | null = 5000n;
  simulation: SimulationResult = { err: null, logs: [], unitsConsumed: 4500 };
  blockhash = encodeBase58(new Uint8Array(32).fill(7));
  height = 1000;
  lastValid = 1150;
  /** Statuses returned one per poll; the last one repeats. null = unknown to the node. */
  statusScript: (SignatureStatus | null)[] = [{ slot: 10, err: null, confirmationStatus: 'processed' }, { slot: 10, err: null, confirmationStatus: 'confirmed' }, { slot: 10, err: null, confirmationStatus: 'finalized' }];
  sent: string[] = [];
  sendError: Error | null = null;
  down = false;
  onSend: ((b64: string) => void) | null = null;
  #polls = 0;
  constructor(genesis: string) { this.genesis = genesis; }
  #guard() { if (this.down) throw new Error('rpc down'); }
  async getGenesisHash() { this.#guard(); return this.genesis; }
  async getLatestBlockhash(_c: WalletCommitment) { this.#guard(); return { blockhash: this.blockhash, lastValidBlockHeight: this.lastValid }; }
  async getBlockHeight() { this.#guard(); return this.height; }
  async getBalance(a: string) { this.#guard(); return this.balances.get(a) ?? 0n; }
  async getAccountInfo(a: string) { this.#guard(); return this.accounts.get(a) ?? null; }
  async getTokenAccountsByOwner() { this.#guard(); return this.tokenAccounts; }
  async getFeeForMessage() { this.#guard(); return this.fee; }
  async simulateTransaction() { this.#guard(); return this.simulation; }
  async sendTransaction(b64: string) {
    this.#guard();
    if (this.sendError) throw this.sendError;
    this.sent.push(b64);
    this.onSend?.(b64);
    // The node returns the first signature of the transaction it received.
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return encodeBase58(raw.slice(1, 65));
  }
  async getSignatureStatus() {
    this.#guard();
    const s = this.statusScript[Math.min(this.#polls++, this.statusScript.length - 1)] ?? null;
    return s;
  }
}

/* ------------------------------------ fake engine ----------------------------------- */

export class FakeEngine implements EngineApi {
  finalizedRaw = 0n;
  events: CountedBurn[] = [];
  down = false;
  statusCalls = 0;
  async getStatus(): Promise<EngineStatus> {
    this.statusCalls++;
    if (this.down) throw new Error('engine down');
    return { finalizedRaw: this.finalizedRaw, finalized: this.finalizedRaw.toString(), levelId: 'l0', levelName: 'Zero', latestEventId: String(this.events.length), synced: true };
  }
  async eventsAfter(after: string): Promise<EventsPage> {
    if (this.down) throw new Error('engine down');
    const list = this.events.filter((e) => Number(e.eventId) > Number(after));
    return { burns: list, nextAfter: String(this.events.length), hasMore: false };
  }
  /** What the real engine does once it re-read and finalized the transaction. */
  count(signature: string, amountRaw: bigint, owner: string): void {
    this.finalizedRaw += amountRaw;
    this.events.push({ eventId: String(this.events.length + 1), signature, instructionPath: '0', owner, amountRaw, slot: 10 });
  }
}

export const otherSignature = randomSignature;
export const TOKEN_PROGRAM = TOKEN_PROGRAMS['spl-token'];
export const b64 = toBase64;
