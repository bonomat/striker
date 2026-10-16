import { useEffect, useState } from "react";
import type { AssetMetadata, WalletBalance } from "@arkade-os/sdk";
import { formatAmount } from "@satora/taker-sdk";
import type { AppConfig } from "./config.js";
import type { ConnectedWallet } from "./wallet.js";

export function WalletBalances({
  account,
  balance,
  asset,
  refreshing,
  error,
  refresh,
}: {
  account: ConnectedWallet;
  balance: WalletBalance | null;
  asset: AppConfig["asset"];
  refreshing: boolean;
  error: string;
  refresh: () => void;
}) {
  const [metadata, setMetadata] = useState<Record<string, AssetMetadata>>({});
  const held = new Map(
    balance?.assets.map((entry) => [entry.assetId, BigInt(entry.amount)]),
  );
  const available = new Map(
    balance?.availableAssets.map((entry) => [entry.assetId, BigInt(entry.amount)]),
  );
  const ids = [...new Set([...held.keys(), ...available.keys()])];
  if (asset.id && !ids.includes(asset.id)) ids.unshift(asset.id);
  ids.sort((a, b) =>
    a === asset.id ? -1 : b === asset.id ? 1 : a.localeCompare(b),
  );
  const assetIds = JSON.stringify(ids.filter((id) => id !== asset.id));

  useEffect(() => {
    let cancelled = false;
    for (const id of JSON.parse(assetIds) as string[]) {
      void account.wallet.assetManager.getAssetDetails(id).then(
        (details) => {
          const metadata = details.metadata;
          if (!cancelled && details.assetId === id && metadata)
            setMetadata((current) => ({ ...current, [id]: metadata }));
        },
        () => {
          // Asset IDs and atomic amounts remain usable without metadata.
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [account, assetIds]);

  return (
    <section className="wallet-balances" aria-labelledby="wallet-balances-title">
      <div className="wallet-balances-heading">
        <h3 id="wallet-balances-title">Balances</h3>
        <button
          className="text-button"
          onClick={refresh}
          disabled={refreshing}
          aria-label="Refresh wallet balances"
        >
          {refreshing ? "Refreshing…" : "Refresh ↻"}
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">{error}</p>
      )}
      {balance ? (
        <>
          <ul className="wallet-asset-list" aria-label="Wallet balances">
            <li className="wallet-asset-row">
              <span className="coin wallet-asset-icon bitcoin" aria-hidden="true">
                ₿
              </span>
              <div className="wallet-asset-info">
                <strong>Bitcoin</strong>
                <span>Swap wallet on Arkade</span>
              </div>
              <div className="wallet-asset-amount">
                <strong>
                  {BigInt(balance.total).toLocaleString()} <span>sats</span>
                </strong>
                {balance.total !== balance.available && (
                  <small>{BigInt(balance.available).toLocaleString()} sats available to swap</small>
                )}
              </div>
            </li>
            {ids.map((id) => {
              const configured = id === asset.id;
              const details = configured ? asset : metadata[id];
              const name =
                typeof details?.name === "string" && details.name.trim()
                  ? details.name.slice(0, 80) : "Arkade asset";
              const ticker = configured ? asset.symbol : metadata[id]?.ticker;
              const symbol =
                typeof ticker === "string" && ticker.trim()
                  ? ticker.slice(0, 16) : undefined;
              const decimals = details?.decimals;
              const precision =
                typeof decimals === "number" && Number.isInteger(decimals) &&
                decimals >= 0 && decimals <= 18 ? decimals : null;
              const amount = held.get(id) ?? available.get(id) ?? 0n;
              const spendable = available.get(id) ?? 0n;
              const display = (value: bigint) => precision === null
                ? value.toLocaleString() : formatAmount(value, precision);
              return (
                <li className="wallet-asset-row wallet-token-row" key={id}>
                  <span className="coin wallet-asset-icon token" aria-hidden="true">
                    {symbol?.slice(0, 1) ?? "◇"}
                  </span>
                  <div className="wallet-asset-info">
                    <strong>{symbol ?? name}</strong>
                    {symbol && <span>{name}</span>}
                    <details className="wallet-asset-id">
                      <summary aria-label={`Asset ID ${id}`}>
                        {id.slice(0, 8)}…{id.slice(-8)}
                      </summary>
                      <code>{id}</code>
                    </details>
                  </div>
                  <div className="wallet-asset-amount">
                    <strong>{display(amount)}</strong>
                    <small>{precision !== null ? (symbol ?? "units") : "atomic units"}</small>
                    {spendable !== amount && (
                      <small>{display(spendable)} available</small>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {!held.size && <p className="wallet-balances-note">No tokens held yet.</p>}
        </>
      ) : (
        <p className="wallet-balances-note" role="status">
          {error ? "Refresh to load your balances." : "Loading your balances…"}
        </p>
      )}
    </section>
  );
}
