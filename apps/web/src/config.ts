import type { ChainSettings } from '@satora/striker-protocol/browser';
export interface AppConfig extends ChainSettings {
  // Static hosts use public endpoints directly; local development uses fixed proxies.
  strikerUrl?: string;
  asset: { id: string | null; symbol: string; name: string; decimals: number; demo: boolean };
}
