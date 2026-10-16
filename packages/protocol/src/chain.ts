import { networkSettings } from './network.js';
import { connectChainWithSettings } from './chain-client.js';
export * from './chain-client.js';
export const connectChain = (options: { checkEmulator?: boolean } = {}) => connectChainWithSettings(networkSettings(), options);
