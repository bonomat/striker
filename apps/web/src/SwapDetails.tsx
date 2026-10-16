import { useState } from "react";
import type { AppConfig } from "./config.js";

function Identifier({ label, value, href }: { label: string; value: string; href?: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return (
    <div className="swap-identifier">
      <dt>{label}</dt>
      <dd>
        {href ? (
          <a className="swap-explorer-link" href={href} target="_blank" rel="noopener noreferrer"
            aria-label={`View ${label.toLowerCase()} in Arkade explorer`}>
            <code>{value}</code> <span aria-hidden="true">↗</span>
          </a>
        ) : <code>{value}</code>}
        <button
          className="icon-button"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setCopyError(false);
            } catch {
              setCopyError(true);
            }
          }}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            {copied ? <path d="m5 12 4 4L19 6" /> : <>
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V4H4v12h4" />
            </>}
          </svg>
        </button>
        {(copied || copyError) && (
          <span className="swap-copy-status" role="status">
            {copyError ? "Select the ID to copy it." : "Copied"}
          </span>
        )}
      </dd>
    </div>
  );
}

export function SwapDetails({
  quoteId, fundingTxid, fundingVout, settlementTxid, refundTxid, cancellationTxid, depositInputs, network,
}: {
  quoteId: string;
  fundingTxid?: string;
  fundingVout?: string;
  settlementTxid?: string;
  refundTxid?: string;
  cancellationTxid?: string;
  depositInputs?: { coin: { txid: string; vout: number } }[];
  network: AppConfig["network"];
}) {
  const explorerLink = (txid: string) =>
    network === "mutinynet" && /^[0-9a-f]{64}$/i.test(txid)
      ? `https://explorer.mutinynet.arkade.sh/tx/${txid}` : undefined;
  return (
    <div className="swap-identifiers">
      {(settlementTxid || cancellationTxid || refundTxid) && <dl className="swap-transaction-summary" aria-label="Swap transactions">
        {settlementTxid && <Identifier label="Swap transaction" value={settlementTxid}
          href={explorerLink(settlementTxid)} key={`settlement:${settlementTxid}`} />}
        {cancellationTxid && <Identifier label="Cancellation transaction" value={cancellationTxid}
          href={explorerLink(cancellationTxid)} key={`cancel:${cancellationTxid}`} />}
        {refundTxid && <Identifier label="Refund transaction" value={refundTxid}
          href={explorerLink(refundTxid)} key={`refund:${refundTxid}`} />}
      </dl>}
      <details className="swap-technical-details">
        <summary>Technical details</summary>
        <dl aria-label="Swap technical details">
          <Identifier label="Quote ID" value={quoteId} key={quoteId} />
          {!!depositInputs?.length && <div className="swap-inputs">
            <dt>Inputs used</dt>
            <dd>
              <p>Existing wallet coins spent by this swap.</p>
              <dl>
                {depositInputs.map((input, i) => <Identifier label={`Wallet input ${i + 1} (output ${input.coin.vout})`}
                  value={input.coin.txid} href={explorerLink(input.coin.txid)} key={`deposit:${input.coin.txid}:${input.coin.vout}`} />)}
              </dl>
            </dd>
          </div>}
          {fundingTxid && <Identifier label="Funding transaction ID" value={fundingTxid}
            href={explorerLink(fundingTxid)} key={`funding:${fundingTxid}`} />}
          {fundingVout !== undefined && (
            <div className="swap-identifier"><dt>Funding output</dt><dd>{fundingVout}</dd></div>
          )}
        </dl>
      </details>
    </div>
  );
}
