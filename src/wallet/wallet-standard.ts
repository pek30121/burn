/* Wallet discovery and adapter based on the Wallet Standard (https://github.com/wallet-standard/wallet-standard),
 * the protocol Phantom, Solflare, Backpack and most Solana wallets register with. Implemented from the protocol's
 * event contract, without a dependency: no key, seed or signature ever passes through this code except the
 * signed bytes the wallet itself returns.
 *
 * Honest scope: this was exercised against a mock Wallet Standard wallet (tests/wallet-*) and a real Devnet
 * transaction signed by a locally held test key behind that mock. It was NOT run against the real Phantom or
 * Solflare browser extensions. */

export type SolanaChain = 'solana:mainnet' | 'solana:devnet' | 'solana:testnet';
export const chainOfCluster = (c: 'devnet' | 'mainnet-beta'): SolanaChain => (c === 'devnet' ? 'solana:devnet' : 'solana:mainnet');

/** Structural subset of the Wallet Standard `Wallet` / `WalletAccount` that we use. */
export interface StdAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: readonly string[];
  readonly features: readonly string[];
  readonly label?: string;
}
export interface StdWallet {
  readonly name: string;
  readonly icon?: string;
  readonly version?: string;
  readonly chains: readonly string[];
  readonly accounts: readonly StdAccount[];
  readonly features: Readonly<Record<string, any>>;
}

export type WalletEvent = { kind: 'accounts'; accounts: readonly WalletAccount[] } | { kind: 'chains' } | { kind: 'features' };

export interface WalletAccount {
  readonly address: string;
  readonly chains: readonly string[];
  /** The standard account, passed back verbatim to the wallet when signing. */
  readonly raw: StdAccount;
}

/** What the burn flow needs from a wallet, independent of the wallet protocol behind it. */
export interface WalletProvider {
  readonly name: string;
  readonly icon: string | null;
  readonly chains: readonly string[];
  readonly canSign: boolean;
  readonly canSignAndSend: boolean;
  accounts(): readonly WalletAccount[];
  connect(): Promise<readonly WalletAccount[]>;
  disconnect(): Promise<void>;
  /** Returns the signed serialized transaction. The wallet is the only place a signature is produced. */
  signTransaction(account: WalletAccount, transaction: Uint8Array, chain: SolanaChain): Promise<Uint8Array>;
  /** Returns the 64-byte signature of a transaction the wallet signed AND submitted itself. */
  signAndSendTransaction(account: WalletAccount, transaction: Uint8Array, chain: SolanaChain): Promise<Uint8Array>;
  onChange(listener: (e: WalletEvent) => void): () => void;
}

const toAccount = (a: StdAccount): WalletAccount => ({ address: a.address, chains: a.chains, raw: a });
export const isSolanaWallet = (w: StdWallet): boolean =>
  typeof w?.name === 'string' && Array.isArray(w.chains) && w.chains.some((c) => c.startsWith('solana:')) &&
  typeof w.features?.['standard:connect']?.connect === 'function' && typeof w.features?.['standard:events']?.on === 'function' &&
  (typeof w.features?.['solana:signTransaction']?.signTransaction === 'function' || typeof w.features?.['solana:signAndSendTransaction']?.signAndSendTransaction === 'function');

export function adaptStandardWallet(w: StdWallet): WalletProvider {
  const f = w.features;
  const sign = f['solana:signTransaction']?.signTransaction as undefined | ((...i: unknown[]) => Promise<{ signedTransaction: Uint8Array }[]>);
  const signSend = f['solana:signAndSendTransaction']?.signAndSendTransaction as undefined | ((...i: unknown[]) => Promise<{ signature: Uint8Array }[]>);
  return {
    name: w.name,
    icon: w.icon ?? null,
    chains: w.chains,
    canSign: sign !== undefined,
    canSignAndSend: signSend !== undefined,
    accounts: () => w.accounts.map(toAccount),
    async connect() {
      const r = await f['standard:connect'].connect();
      return (r?.accounts ?? w.accounts).map(toAccount);
    },
    async disconnect() {
      // `standard:disconnect` is optional in the standard; a wallet without it is forgotten locally by the caller.
      await f['standard:disconnect']?.disconnect?.();
    },
    async signTransaction(account, transaction, chain) {
      if (!sign) throw new Error('this wallet cannot sign transactions without sending them');
      const out = await sign({ account: account.raw, transaction, chain });
      const signed = out?.[0]?.signedTransaction;
      if (!(signed instanceof Uint8Array)) throw new Error('the wallet returned no signed transaction');
      return signed;
    },
    async signAndSendTransaction(account, transaction, chain) {
      if (!signSend) throw new Error('this wallet cannot sign and send');
      const out = await signSend({ account: account.raw, transaction, chain });
      const signature = out?.[0]?.signature;
      if (!(signature instanceof Uint8Array)) throw new Error('the wallet returned no signature');
      return signature;
    },
    onChange(listener) {
      return f['standard:events'].on('change', (p: { accounts?: readonly StdAccount[]; chains?: unknown; features?: unknown }) => {
        // The standard reports the new values of what changed; always re-read the wallet's current accounts.
        if (p.accounts) listener({ kind: 'accounts', accounts: w.accounts.map(toAccount) });
        if (p.chains) listener({ kind: 'chains' });
        if (p.features) listener({ kind: 'features' });
      });
    },
  };
}

/** Minimal `window`-like surface (injectable for tests). */
export interface EventHost {
  addEventListener(type: string, listener: (e: any) => void): void;
  removeEventListener(type: string, listener: (e: any) => void): void;
  dispatchEvent(e: Event): boolean;
}

export interface WalletRegistry {
  list(): WalletProvider[];
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** Discovers Wallet Standard wallets (those already registered and those that register later). */
export function createWalletRegistry(host: EventHost = globalThis as unknown as EventHost): WalletRegistry {
  const wallets = new Map<StdWallet, WalletProvider>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const api = {
    register(...ws: StdWallet[]) {
      let added = false;
      for (const w of ws) if (isSolanaWallet(w) && !wallets.has(w)) { wallets.set(w, adaptStandardWallet(w)); added = true; }
      if (added) notify();
      return () => { for (const w of ws) wallets.delete(w); notify(); };
    },
  };
  const onRegister = (e: any) => { if (typeof e?.detail === 'function') e.detail(api); };
  host.addEventListener('wallet-standard:register-wallet', onRegister);
  host.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  return {
    list: () => [...wallets.values()],
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    dispose() { host.removeEventListener('wallet-standard:register-wallet', onRegister); listeners.clear(); },
  };
}
