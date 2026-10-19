import type { ConnectedWallet } from './wallet.js';

export type WalletLifecycleStatus = Awaited<ReturnType<ConnectedWallet['covenant']['getLifecycle']>>;
export function WalletLifecycle({ status, pending, busy, error, autoRenew, onAutoRenew, onMaintain, blocked }: {
  status: WalletLifecycleStatus | null; pending: boolean; busy: boolean; error: string;
  autoRenew: boolean; onAutoRenew: (enabled: boolean) => void; onMaintain: () => void; blocked: boolean;
}) {
  const nextExpiry = status?.deposits.map(d => d.expiresAt).filter((date): date is string => !!date).sort()[0];
  const due = !!status && !!(status.recoverable || status.expiring);
  return <section className="wallet-lifecycle" aria-label="Deposit expiry and recovery">
    <h3>Keep your deposits available</h3>
    <p>{busy ? 'Renewing your deposits. Keep this tab open until settlement completes.' : pending ?
      'A wallet maintenance operation needs attention. Resume its recorded transaction; do not clear browser storage.' : status?.recoverable ?
        `${status.recoverable} deposit(s) expired and were swept. Recover them to make these funds available for swaps again.` : status?.awaitingSweep ?
          'Expired deposits are waiting for the Arkade sweep. They will become recoverable afterward.' : status?.expiring ?
            `${status.expiring} deposit(s) expire within six hours and should be renewed.` : 'Deposits have an expiry. Renewal gives them a fresh lifetime.'}</p>
    {nextExpiry && <p className="small-print">Earliest expiry: {new Date(nextExpiry).toLocaleString()}</p>}
    <label className="wallet-renew-toggle"><input type="checkbox" checked={autoRenew} disabled={busy} onChange={event => onAutoRenew(event.target.checked)} />Automatically renew while this wallet is unlocked</label>
    <p className="small-print">Checks every 15 seconds while this tab is open. Pending swaps pause maintenance. Recovery uses a batch settlement and then returns funds to your swap wallet.</p>
    {blocked && (due || pending) && <p className="small-print">Resolve your pending swap or cancel its authorization first.</p>}
    {(due || pending || busy) && <button className="secondary-button" disabled={busy || blocked || (!due && !pending)} onClick={onMaintain}>{busy ? 'Maintaining deposits…' : pending ? 'Resume maintenance' : status?.recoverable ? 'Recover expired deposits' : 'Renew deposits'}</button>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
