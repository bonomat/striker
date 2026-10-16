import { networkSettings } from './network.js';
import { connectChainWithSettings } from './chain-client.js';
export * from './chain-client.js';
export const connectChain = () => connectChainWithSettings(networkSettings());
