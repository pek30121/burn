/* Public entry point of the wallet module (client side, design-agnostic). */
export { BurnController, createBurnController, type BurnControllerOptions, type BurnPreview, type BurnState, type FlowStatus, type Holding } from './controller.ts';
export { createEngineClient, type EngineApi, type EngineStatus, type CountedBurn } from './engine-client.ts';
export { BurnFlowError, DEFAULT_MESSAGES, describeTxError, isUserRejection, type BurnErrorCode } from './errors.ts';
export { createJsonRpc, type WalletRpc } from './rpc.ts';
export { assessBurn, parseMint, parseTokenAccount, type BurnEligibility } from './token-info.ts';
export { assertSameMessage, buildUnsignedBurn, burnCheckedInstruction } from './tx.ts';
export { adaptStandardWallet, chainOfCluster, createWalletRegistry, type WalletProvider, type WalletRegistry } from './wallet-standard.ts';
