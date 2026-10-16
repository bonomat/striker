import type { ChainSettings } from '@satora/striker-protocol/browser';
export interface AppConfig extends ChainSettings {
  asset: { id: string | null; symbol: string; name: string; decimals: number; demo: boolean };
}
