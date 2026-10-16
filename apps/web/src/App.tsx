import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { WalletBalance } from "@arkade-os/sdk";
import { formatAmount, parseAmount, type SavedSwap } from "@satora/taker-sdk";
import type { AppConfig } from "./config.js";
import {
  connectWallet,
  vaultStorageKey,
  withWalletLock,
  type ConnectedWallet,
} from "./wallet.js";
import {
  decryptWallet,
  encryptWallet,
  parseVault,
  type Vault,
} from "./vault.js";
import "./style.css";

const short = (text: string) => `${text.slice(0, 9)}…${text.slice(-6)}`;
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
function Icon({
  children,
  className = "",
  size = 20,
}: {
  children: ReactNode;
  className?: string;
  size?: number;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
const Arrow = () => (
  <Icon>
    <path d="M12 4v15m-6-6 6 6 6-6" />
  </Icon>
);
const Check = () => (
  <Icon>
    <path d="m5 12 4 4L19 6" />
  </Icon>
);
const WalletIcon = () => (
  <Icon>
    <path d="M20 8V6a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v9H5a3 3 0 0 1-3-3V7" />
    <path d="M20 12h-5v4h5m-3-2h.01" />
  </Icon>
);
const Copy = () => (
  <Icon size={17}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V4H4v12h4" />
  </Icon>
);
const Chevron = () => (
  <Icon size={16}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
function Coin({
  bitcoin = false,
  symbol = "USDt",
  small = false,
}: {
  bitcoin?: boolean;
  symbol?: string;
  small?: boolean;
}) {
  return (
    <span
      className={`coin ${bitcoin ? "bitcoin" : "token"} ${small ? "coin-small" : ""}`}
      aria-hidden="true"
    >
      {bitcoin ? (
        "₿"
      ) : symbol === "USDt" || symbol === "USDT" ? (
        <svg viewBox="0 0 40 40">
          <path
            fill="currentColor"
            d="M10 9h20v5h-8v3c7 .3 12 1.5 12 3s-5 2.7-12 3v9h-5v-9c-7-.3-12-1.5-12-3s5-2.7 12-3v-3h-7zm7 9c-5 .3-9 1-9 2s4 1.7 9 2v-1h5v1c5-.3 9-1 9-2s-4-1.7-9-2v2h-5z"
          />
        </svg>
      ) : (
        symbol.slice(0, 1)
      )}
    </span>
  );
}
function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    const node = dialog.current;
    return () => node?.close();
  }, []);
  return (
    <dialog
      aria-label={title}
      className={`modal ${wide ? "modal-wide" : ""}`}
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="modal-inner">
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={close}
            aria-label="Close dialog"
          >
            <Icon>
              <path d="m6 6 12 12M6 18 18 6" />
            </Icon>
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null),
    [configError, setConfigError] = useState("");
  const [account, setAccount] = useState<ConnectedWallet | null>(null),
    [balance, setBalance] = useState<WalletBalance | null>(null);
  const [balanceError, setBalanceError] = useState(""),
    [revision, setRevision] = useState(0);
  const [reverse, setReverse] = useState(true);
  const [amount, setAmount] = useState(""),
    [quote, setQuote] = useState<SavedSwap | null>(null),
    [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState(""),
    [quoteNonce, setQuoteNonce] = useState(0),
    [now, setNow] = useState(Date.now());
  const [modal, setModal] = useState<
    "wallet" | "receive" | "activity" | "review" | "result" | null
  >(null);
  const [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const [walletBusy, setWalletBusy] = useState(false),
    [walletError, setWalletError] = useState("");
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [importKey, setImportKey] = useState("");
  const [walletMode, setWalletMode] = useState<"create" | "import">("create"),
    [costsOpen, setCostsOpen] = useState(false),
    [copied, setCopied] = useState(false);
  const [vault, setVault] = useState<Vault | null>(() => {
    try {
      const raw = localStorage.getItem(vaultStorageKey);
      return raw ? parseVault(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  });
  const asset = config?.asset ?? {
    id: null,
    symbol: "USDt",
    name: "Tether USD",
    decimals: 6,
    demo: false,
  };
  const records = account?.store.list() ?? [];
  const history = records.filter(
    (swap) =>
      swap.fundingStartedAt || swap.funding || swap.result || swap.refund,
  );
  const pending = history.find(
    (swap) => !swap.result && swap.refund?.status !== "refunded",
  );
  const activeSwap = history.find((swap) => swap.response.quoteId === selected);
  const availableAsset = BigInt(
    balance?.availableAssets.find((entry) => entry.assetId === asset.id)
      ?.amount ?? 0,
  );
  const sendSymbol = reverse ? "BTC" : asset.symbol;
  const receiveSymbol = reverse ? asset.symbol : "BTC";
  const sendDecimals = reverse ? 8 : asset.decimals;
  const receiveDecimals = reverse ? asset.decimals : 8;
  const availableSend = reverse ? BigInt(Math.max(0, (balance?.available ?? 0) - 330)) : availableAsset;
  const availableReceive = reverse ? availableAsset : BigInt(balance?.available ?? 0);
  let units = 0n,
    amountError = "";
  if (amount) {
    try {
      units = parseAmount(amount, sendDecimals);
    } catch (error) {
      amountError = errorMessage(error);
    }
  }
  const insufficient = !!balance && units > availableSend;
  const needsCarrier = !!balance && balance.available < (reverse ? 660 : 330);
  const expires = quote
    ? Math.max(
        0,
        Number(quote.response.offer.quote.deadline) - Math.floor(now / 1000),
      )
    : 0;
  const receive = quote ? BigInt(quote.response.offer.quote.x) : 0n;
  const refreshing = useRef(false);

  useEffect(() => {
    fetch("/config.json")
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load the market.");
        return response.json();
      })
      .then(setConfig)
      .catch((error) => setConfigError(errorMessage(error)));
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const refreshBalance = useCallback(async () => {
    if (!account || refreshing.current) return;
    refreshing.current = true;
    try {
      setBalance(await account.wallet.getBalance());
      setBalanceError("");
    } catch {
      setBalanceError("Balance unavailable. Try refreshing.");
    } finally {
      refreshing.current = false;
    }
  }, [account]);
  useEffect(() => {
    if (!account) {
      setBalance(null);
      return;
    }
    void refreshBalance();
    const interval = setInterval(() => void refreshBalance(), 15000);
    return () => clearInterval(interval);
  }, [account, refreshBalance]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === vaultStorageKey) {
        void account?.wallet.dispose();
        setAccount(null);
        setBalance(null);
        setQuote(null);
        setVault(
          event.newValue ? parseVault(JSON.parse(event.newValue)) : null,
        );
      } else setRevision((value) => value + 1);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [account]);
  useEffect(() => {
    setQuote(null);
    setQuoteError("");
    setQuoting(false);
    if (
      !account ||
      !asset.id ||
      !units ||
      amountError ||
      insufficient ||
      needsCarrier ||
      pending ||
      !balance
    )
      return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setQuoting(true);
      account.client
        .quote(asset.id!, units.toString(), reverse ? "btc-to-token" : "token-to-btc")
        .then((result) => {
          if (!cancelled) setQuote(result);
        })
        .catch((error) => {
          if (!cancelled)
            setQuoteError(
              errorMessage(error) === "No executable maker quotes"
                ? "This amount exceeds available liquidity. Try a smaller swap."
                : errorMessage(error),
            );
        })
        .finally(() => {
          if (!cancelled) setQuoting(false);
        });
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    account,
    asset.id,
    reverse,
    units,
    amountError,
    insufficient,
    needsCarrier,
    !!pending,
    !!balance,
    quoteNonce,
  ]);

  async function openWallet(event: React.FormEvent) {
    event.preventDefault();
    if (!config || walletBusy) return;
    setWalletBusy(true);
    setWalletError("");
    try {
      let encrypted = vault;
      if (!window.isSecureContext)
        throw new Error("Open Striker on HTTPS or localhost to use your wallet.");
      if (!encrypted) {
        if (localStorage.getItem(vaultStorageKey))
          throw new Error("The saved wallet could not be read. Preserve its browser data and restore your encrypted backup before creating another wallet.");
        if (password !== confirmation)
          throw new Error("Your passwords do not match.");
        if (walletMode === "import" && !importKey.trim())
          throw new Error("Enter your wallet private key.");
        encrypted = await encryptWallet(
          password,
          walletMode === "import" ? importKey : undefined,
        );
        localStorage.setItem(vaultStorageKey, JSON.stringify(encrypted));
        setVault(encrypted);
      }
      const key = await decryptWallet(encrypted, password);
      const connected = await connectWallet(config, key, () =>
        setRevision((value) => value + 1),
      );
      setAccount(connected);
      setPassword("");
      setConfirmation("");
      setImportKey("");
      setModal(null);
    } catch (error) {
      setWalletError(errorMessage(error));
    } finally {
      setWalletBusy(false);
    }
  }
  async function importBackup(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 4096)
        throw new Error("This is not a Striker wallet backup.");
      const encrypted = parseVault(JSON.parse(await file.text()));
      localStorage.setItem(vaultStorageKey, JSON.stringify(encrypted));
      setVault(encrypted);
      setWalletError("");
    } catch (error) {
      setWalletError(errorMessage(error));
    }
  }
  function backup() {
    if (!vault) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(vault, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `striker-wallet-${vault.publicKey.slice(0, 8)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copyAddress() {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setWalletError("Copy is unavailable. Select the address below.");
    }
  }
  function percentage(percent: number) {
    const quantity = (availableSend * BigInt(percent)) / 100n;
    setAmount(quantity ? formatAmount(quantity, sendDecimals) : "");
  }
  function inspect(swap: SavedSwap) {
    setSelected(swap.response.quoteId);
    setActionError("");
    setModal("result");
  }
  async function execute(swap: SavedSwap) {
    if (!account || busy) return;
    setSelected(swap.response.quoteId);
    setBusy(true);
    setActionError("");
    setModal("result");
    try {
      await withWalletLock(account, () =>
        account.client.execute(swap.response.quoteId),
      );
      await refreshBalance();
      setAmount("");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  }
  async function checkStatus() {
    if (!account || !activeSwap || busy) return;
    setBusy(true);
    setActionError("");
    try {
      const status = await account.client.status(activeSwap.response.quoteId);
      if (status.status === "settled") {
        await account.store.put({ ...activeSwap, result: status });
        await refreshBalance();
      } else if (status.status === "failed")
        setActionError(
          "Execution needs attention. You can return an unspent offer to your wallet.",
        );
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function refund() {
    if (!account || !activeSwap || busy) return;
    setBusy(true);
    setActionError("");
    try {
      await withWalletLock(account, () =>
        account.client.refund(activeSwap.response.quoteId),
      );
      await refreshBalance();
      setAmount("");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  }
  const cta = !config
    ? "Loading market…"
    : !asset.id
      ? "Market not configured"
      : !account
        ? "Connect wallet"
        : pending
          ? "Resume your swap"
          : !amount
            ? "Enter an amount"
            : amountError
              ? "Check the amount"
              : insufficient
                ? `Not enough ${sendSymbol}`
                : needsCarrier
                  ? "Add BTC to your wallet"
                  : quoting
                    ? "Finding your best quote…"
                    : quoteError
                      ? "Try another amount"
                      : quote && !expires
                        ? "Refresh quote"
                        : !quote
                          ? "Enter an amount"
                          : "Review swap";
  const ctaDisabled =
    !config ||
    !asset.id ||
    (!!account &&
      !pending &&
      (!amount ||
        !!amountError ||
        insufficient ||
        needsCarrier ||
        quoting ||
        !quote ||
        !!quoteError));
  const succeeded = activeSwap?.result?.status === "settled",
    refunded = activeSwap?.refund?.status === "refunded";
  const finalTxid = succeeded
    ? activeSwap?.result?.txid
    : activeSwap?.refund?.txid;
  const displayedSwap =
    activeSwap ?? (quote?.response.quoteId === selected ? quote : undefined);
  const primaryClick = () => {
    if (!account) {
      setWalletError("");
      setModal("wallet");
    } else if (pending) inspect(pending);
    else if (quote && !expires) setQuoteNonce((value) => value + 1);
    else if (quote) {
      setActionError("");
      setModal("review");
    }
  };

  return (
    <div className="app-shell">
      <header className="header">
        <a className="brand" href="/" aria-label="Striker home">
          <span className="brand-mark">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14.7 2 4 14h7l-1.7 8L21 9h-7.5z" />
            </svg>
          </span>
          striker<span className="brand-period">.</span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <button className="nav-active" onClick={() => setModal(null)}>
            Swap
          </button>
          <button onClick={() => setModal("activity")}>
            Activity
            {history.length > 0 && (
              <span className="activity-count">{history.length}</span>
            )}
          </button>
        </nav>
        <div className="header-actions">
          <span className="network-pill">
            <span className="status-dot" />
            Arkade <span className="network-separator">/</span>{" "}
            {config?.network === "regtest" ? "Regtest" : "Mutinynet"}
          </span>
          <button
            className="connect-button"
            onClick={() => {
              setWalletError("");
              setModal("wallet");
            }}
          >
            <WalletIcon />
            <span>{account ? short(account.address) : "Connect wallet"}</span>
          </button>
        </div>
      </header>
      <main className="main-content">
        <section className="hero" aria-labelledby="hero-title">
          <div className="eyebrow">
            <span />
            THE SHORTEST WAY TO BITCOIN
          </div>
          <h1 id="hero-title">
            {reverse ? "Bitcoin" : asset.symbol} to <em>{reverse ? `${asset.symbol}.` : "Bitcoin."}</em>
          </h1>
          <p>One swap. All on Arkade. Always your wallet.</p>
        </section>
        <section className="swap-section" aria-label="Swap assets">
          <div className="swap-frame">
            <div className="amount-card send-card">
              <div className="card-topline">
                <label htmlFor="send-amount">You send</label>
                {asset.demo && !reverse && <span className="demo-badge">DEMO ASSET</span>}
              </div>
              <div className="amount-row">
                <input
                  id="send-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  disabled={busy || !!pending}
                  aria-describedby="send-balance"
                  aria-invalid={!!amountError || insufficient}
                />
                <div className="asset-name">
                  <Coin symbol={sendSymbol} bitcoin={reverse} />
                  <div>
                    <strong>{sendSymbol}</strong>
                    <span>Arkade</span>
                  </div>
                </div>
              </div>
              <div className="card-bottom">
                <span id="send-balance" className="balance-text">
                  Balance:{" "}
                  <b>
                    {account && balance
                      ? formatAmount(availableSend, sendDecimals)
                      : "—"}
                  </b>{" "}
                  {sendSymbol}
                </span>
                <div className="percentages">
                  {[25, 50, 75, 100].map((percent) => (
                    <button
                      key={percent}
                      disabled={!account || !balance || busy || !!pending}
                      onClick={() => percentage(percent)}
                    >
                      {percent === 100 ? "Max" : `${percent}%`}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <button className="direction-arrow" aria-label="Switch swap direction" title="Switch swap direction" disabled={busy || !!pending} onClick={() => { setReverse(value => !value); setAmount(""); setQuote(null); setQuoteError(""); }}>
              <Icon><path d="M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4" /></Icon>
            </button>
            <div className="amount-card receive-card">
              <div className="card-topline">
                <span>You receive</span>
                {asset.demo && reverse && !quote && <span className="demo-badge">DEMO ASSET</span>}
                {quote && (
                  <span
                    className={`quote-clock ${expires < 10 ? "expiring" : ""}`}
                  >
                    <span className="status-dot" />
                    {expires ? `${expires}s quote` : "Quote expired"}
                  </span>
                )}
              </div>
              <div className="amount-row">
                <output
                  className={
                    quote ? "receive-value has-value" : "receive-value"
                  }
                  aria-label={`${receiveSymbol} receive amount`}
                >
                  {quoting ? (
                    <span className="amount-skeleton" />
                  ) : quote ? (
                    formatAmount(receive, receiveDecimals, reverse)
                  ) : (
                    "0"
                  )}
                </output>
                <div className="asset-name">
                  <Coin bitcoin={!reverse} symbol={receiveSymbol} />
                  <div>
                    <strong>{receiveSymbol}</strong>
                    <span>Arkade</span>
                  </div>
                </div>
              </div>
              <div className="receive-bottom">
                <span className="balance-text">
                  Balance:{" "}
                  <b>
                    {balance ? formatAmount(availableReceive, receiveDecimals) : "—"}
                  </b>{" "}
                  {receiveSymbol}
                </span>
                {quote && (
                  <span className="sats-label">
                    {reverse ? `${formatAmount(receive, asset.decimals)} ${asset.symbol}` : `${receive.toLocaleString()} sats`}
                  </span>
                )}
              </div>
            </div>
            <div className="swap-details">
              <span className="route-label">
                <span className="route-dot" />
                Direct on Arkade
              </span>
              <button
                className="cost-toggle"
                aria-expanded={costsOpen}
                onClick={() => setCostsOpen((value) => !value)}
              >
                Swap costs <strong>330 sats</strong>
                <Chevron />
              </button>
            </div>
            {costsOpen && (
              <div className="cost-breakdown">
                <div>
                  <span>Service fee</span>
                  <span>0 sats</span>
                </div>
                <div>
                  <span>Network fee</span>
                  <span>0 sats</span>
                </div>
                <div>
                  <span>Token carrier</span>
                  <span>330 sats</span>
                </div>
                <p>
                  {reverse ? "The 330 sats carrier stays with the tokens you receive in your wallet." : "The carrier travels with your token payment to the maker. It comes from your BTC balance."}
                </p>
              </div>
            )}
            {(configError || amountError || quoteError || balanceError) && (
              <div role="alert" className="inline-error">
                {configError || amountError || quoteError || balanceError}
                {balanceError && (
                  <button onClick={() => void refreshBalance()}>Refresh</button>
                )}
              </div>
            )}
            <button
              className="swap-button"
              onClick={primaryClick}
              disabled={ctaDisabled || busy}
            >
              <span>{cta}</span>
              {!ctaDisabled && (
                <Icon>
                  <path d="M4 12h16m-6-6 6 6-6 6" />
                </Icon>
              )}
            </button>
            {!account && (
              <p className="card-footnote">
                <Icon size={13}>
                  <rect x="6" y="10" width="12" height="10" rx="2" />
                  <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                </Icon>
                Your keys never leave your browser.
              </p>
            )}
          </div>
          <div className="under-card">
            <span>
              <Icon size={15}>
                <path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7z" />
                <path d="m8 12 3 3 5-5" />
              </Icon>
              Atomic settlement
            </span>
            <span className="under-divider" />
            <span>No account needed</span>
            <button
              onClick={() => {
                setWalletError("");
                setModal(account ? "receive" : "wallet");
              }}
            >
              Your wallet, your control <span>↗</span>
            </button>
          </div>
          {pending && (
            <button className="pending-banner" onClick={() => inspect(pending)}>
              <span className="pending-indicator" />
              <span>A swap needs your attention</span>
              <strong>View swap ↗</strong>
            </button>
          )}
          {account && (
            <div className="wallet-strip">
              <span className="status-dot" />
              <span>Wallet connected</span>
              <button onClick={() => setModal("receive")}>
                Receive assets <span>↗</span>
              </button>
              <button
                className="balance-refresh"
                onClick={() => void refreshBalance()}
                aria-label="Refresh balances"
              >
                <Icon size={15}>
                  <path d="M20 7v5h-5M4 17v-5h5" />
                  <path d="M6 6a8 8 0 0 1 13 5M5 13a8 8 0 0 0 13 5" />
                </Icon>
              </button>
            </div>
          )}
        </section>
        <section className="how-it-works" aria-label="How Striker works">
          <div className="how-heading">
            <span className="tiny-label">LESS FRICTION. MORE BITCOIN.</span>
            <h2>A better way to make your move.</h2>
          </div>
          <div className="steps">
            <div>
              <span className="step-number">01</span>
              <h3>Bring your assets</h3>
              <p>Connect your wallet and choose how much you want to swap.</p>
            </div>
            <div>
              <span className="step-number">02</span>
              <h3>Get your best quote</h3>
              <p>
                Striker finds a signed offer from available maker liquidity.
              </p>
            </div>
            <div>
              <span className="step-number">03</span>
              <h3>Make it bitcoin</h3>
              <p>
                Your tokens and BTC change hands together, in one atomic swap.
              </p>
            </div>
          </div>
        </section>
      </main>
      <footer className="footer">
        <span>Built for the way bitcoin moves.</span>
        <div>
          <span className="footer-arkade">
            <span className="arkade-mark">a</span>Powered by Arkade
          </span>
          <span className="footer-separator" />
          {config?.network === "regtest" ? "Regtest" : "Mutinynet"} · Test
          assets
        </div>
        <span>striker © {new Date().getFullYear()}</span>
      </footer>

      {modal === "wallet" && (
        <Modal
          title={
            account
              ? "Your wallet"
              : vault
                ? "Welcome back."
                : "Your wallet. Your move."
          }
          close={() => {
            if (!walletBusy) {
              setModal(null);
              setPassword("");
              setConfirmation("");
              setImportKey("");
            }
          }}
        >
          {account ? (
            <>
              <div className="wallet-summary">
                <WalletIcon />
                <span>Connected on Arkade</span>
                <span className="status-dot" />
              </div>
              <p className="modal-caption">
                {config?.network === "regtest" ? "Regtest" : "Mutinynet"} wallet
                · Keys held in this browser
              </p>
              <div className="address-box">{account.address}</div>
              <button
                className="secondary-button"
                onClick={() => void copyAddress()}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? "Address copied" : "Copy address"}
              </button>
              <button className="secondary-button" onClick={backup}>
                <Icon>
                  <path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" />
                </Icon>
                Download encrypted backup
              </button>
              <p className="small-print">
                Keep your backup and password. Both are needed to restore your
                wallet.
              </p>
              <button
                className="text-button lock-wallet"
                disabled={busy}
                onClick={() => {
                  void account.wallet.dispose();
                  setAccount(null);
                  setQuote(null);
                  setModal(null);
                }}
              >
                Lock wallet
              </button>
            </>
          ) : (
            <>
              <p className="modal-caption">
                {vault
                  ? "Unlock the wallet saved in this browser."
                  : "Create a browser wallet, or bring an existing Arkade key. Your key is encrypted with your password."}
              </p>
              {!vault && (
                <div className="wallet-tabs">
                  <button
                    className={walletMode === "create" ? "selected" : ""}
                    onClick={() => setWalletMode("create")}
                  >
                    Create wallet
                  </button>
                  <button
                    className={walletMode === "import" ? "selected" : ""}
                    onClick={() => setWalletMode("import")}
                  >
                    Import key
                  </button>
                </div>
              )}
              <form
                className="wallet-form"
                onSubmit={(event) => void openWallet(event)}
              >
                {!vault && walletMode === "import" && (
                  <label>
                    Private key
                    <input
                      type="password"
                      autoComplete="off"
                      value={importKey}
                      onChange={(event) => setImportKey(event.target.value)}
                      placeholder="64 hexadecimal characters"
                      required
                    />
                  </label>
                )}
                <label>
                  {vault ? "Password" : "Choose a password"}
                  <input
                    type="password"
                    autoComplete={vault ? "current-password" : "new-password"}
                    minLength={1}
                    maxLength={256}
                    placeholder={
                      vault ? "Your wallet password" : "Choose a password"
                    }
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    disabled={walletBusy}
                  />
                </label>
                {!vault && (
                  <label>
                    Confirm password
                    <input
                      type="password"
                      autoComplete="new-password"
                      placeholder="Enter your password again"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      required
                      disabled={walletBusy}
                    />
                  </label>
                )}
                {walletError && (
                  <p className="inline-error" role="alert">
                    {walletError}
                  </p>
                )}
                <button
                  className="swap-button modal-primary"
                  disabled={walletBusy || !config}
                >
                  {walletBusy
                    ? "Opening your wallet…"
                    : vault
                      ? "Unlock wallet"
                      : walletMode === "import"
                        ? "Import & connect"
                        : "Create & connect"}
                </button>
              </form>
              {!vault && (
                <label className="backup-import">
                  Have a Striker backup? <span>Restore wallet</span>
                  <input
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) =>
                      void importBackup(event.target.files?.[0])
                    }
                  />
                </label>
              )}
              <div className="privacy-note">
                <Icon size={17}>
                  <path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7z" />
                </Icon>
                No signup. No server-held keys.
              </div>
            </>
          )}
        </Modal>
      )}
      {modal === "receive" && account && (
        <Modal title="Bring your assets." close={() => setModal(null)}>
          <p className="modal-caption">
            Send BTC or {asset.symbol} on Arkade to your wallet. Use the same
            network and Arkade server.
          </p>
          <div className="receive-symbol">
            <WalletIcon />
          </div>
          <div className="network-label">
            <span className="status-dot" />
            {config?.network === "regtest" ? "Regtest" : "Mutinynet"} · Arkade
          </div>
          <div className="address-box">{account.address}</div>
          <button
            className="swap-button modal-primary"
            onClick={() => void copyAddress()}
          >
            {copied ? "Address copied" : "Copy wallet address"}
            {copied ? <Check /> : <Copy />}
          </button>
          <div className="server-details">
            <span>Arkade server</span>
            <code>{config?.arkUrl}</code>
          </div>
          <p className="small-print">
            This is an Arkade address. Send Arkade assets, rather than an
            on-chain Bitcoin payment.
          </p>
        </Modal>
      )}
      {modal === "activity" && (
        <Modal title="Your activity" close={() => setModal(null)} wide>
          {!account ? (
            <div className="empty-state">
              <WalletIcon />
              <h3>Your swaps, in one place.</h3>
              <p>Connect your wallet to see your swap history.</p>
              <button
                className="swap-button"
                onClick={() => setModal("wallet")}
              >
                Connect wallet
              </button>
            </div>
          ) : !history.length ? (
            <div className="empty-state">
              <Arrow />
              <h3>Your next move starts here.</h3>
              <p>Completed and in-progress swaps will appear here.</p>
              <button
                className="secondary-button"
                onClick={() => setModal(null)}
              >
                Make your first swap
              </button>
            </div>
          ) : (
            <div className="history-list">
              {history.slice(0, 20).map((swap) => (
                <button
                  className="history-row"
                  key={swap.response.quoteId}
                  onClick={() => inspect(swap)}
                >
                  <span className="history-coins">
                    <Coin symbol={asset.symbol} small />
                    <Coin bitcoin small />
                  </span>
                  <span>
                    <strong>
                      {formatAmount(
                        BigInt(swap.request.giveAmount),
                        swap.request.direction === "btc-to-token" ? 8 : asset.decimals,
                      )}{" "}
                      {swap.request.direction === "btc-to-token" ? `BTC → ${asset.symbol}` : `${asset.symbol} → BTC`}
                    </strong>
                    <small>
                      {swap.createdAt
                        ? new Date(swap.createdAt).toLocaleString()
                        : short(swap.response.quoteId)}
                    </small>
                  </span>
                  <span
                    className={`history-status ${swap.result?.status === "settled" ? "completed" : ""}`}
                  >
                    {swap.result?.status === "settled"
                      ? "Complete"
                      : swap.refund?.status === "refunded"
                        ? "Returned"
                        : "In progress"}{" "}
                    ↗
                  </span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
      {modal === "review" && quote && (
        <Modal
          title="Make your move."
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          <p className="modal-caption">
            Your signed quote is ready. Both sides settle together on Arkade.
          </p>
          <div className="review-assets">
            <div>
              <Coin symbol={sendSymbol} bitcoin={reverse} />
              <span>
                You send
                <strong>
                  {formatAmount(
                    BigInt(quote.request.giveAmount),
                    sendDecimals,
                  )}{" "}
                  {sendSymbol}
                </strong>
              </span>
            </div>
            <Arrow />
            <div>
              <Coin bitcoin={!reverse} symbol={receiveSymbol} />
              <span>
                You receive
                <strong>{formatAmount(receive, receiveDecimals, reverse)} {receiveSymbol}</strong>
              </span>
            </div>
          </div>
          <div className="review-facts">
            <div>
              <span>Network</span>
              <strong>
                Arkade ·{" "}
                {config?.network === "regtest" ? "Regtest" : "Mutinynet"}
              </strong>
            </div>
            <div>
              <span>Swap costs</span>
              <strong>330 sats token carrier</strong>
            </div>
            <div>
              <span>Service & network fees</span>
              <strong>0 sats</strong>
            </div>
            <div>
              <span>Quote expires in</span>
              <strong className={expires < 10 ? "danger" : ""}>
                {expires}s
              </strong>
            </div>
          </div>
          <button
            className="swap-button modal-primary"
            disabled={!expires || busy}
            onClick={() => void execute(quote)}
          >
            Confirm swap
            <Icon>
              <path d="M4 12h16m-6-6 6 6-6 6" />
            </Icon>
          </button>
          {!expires && (
            <p className="inline-error">
              This quote expired. Close this dialog to refresh it.
            </p>
          )}
        </Modal>
      )}
      {modal === "result" && (
        <Modal
          title={
            succeeded
              ? "That’s a good move."
              : refunded
                ? "Back in your wallet."
                : busy
                  ? "Making your move…"
                  : "Your swap"
          }
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          <div
            className={`result-icon ${succeeded || refunded ? "success" : ""}`}
          >
            {succeeded || refunded ? (
              <Check />
            ) : (
              <span className={busy ? "spinner" : ""}>
                {!busy && <Arrow />}
              </span>
            )}
          </div>
          <p className="result-caption">
            {succeeded
              ? "Swap complete. Your assets are in your Arkade wallet."
              : refunded
                ? "Your unspent payment has been returned."
                : busy
                  ? "Keep this window open while your swap settles."
                  : "Check the swap status, resume execution, or return an unspent offer."}
          </p>
          {displayedSwap && (
            <div className="result-amount">
              <span>
                {formatAmount(
                  BigInt(displayedSwap.request.giveAmount),
                  displayedSwap.request.direction === "btc-to-token" ? 8 : asset.decimals,
                )}{" "}
                {displayedSwap.request.direction === "btc-to-token" ? "BTC" : asset.symbol}
              </span>
              <span>→</span>
              <strong>
                {formatAmount(
                  BigInt(displayedSwap.response.offer.quote.x),
                  displayedSwap.request.direction === "btc-to-token" ? asset.decimals : 8,
                  displayedSwap.request.direction === "btc-to-token",
                )}{" "}
                {displayedSwap.request.direction === "btc-to-token" ? asset.symbol : "BTC"}
              </strong>
            </div>
          )}
          {busy && (
            <div className="progress-list">
              <div className="done">
                <Check />
                Quote verified locally
              </div>
              <div className={activeSwap?.funding ? "done" : "current"}>
                {activeSwap?.funding ? (
                  <Check />
                ) : (
                  <span className="step-dot" />
                )}
                Fund your swap
              </div>
              <div className={activeSwap?.funding ? "current" : ""}>
                <span className="step-dot" />
                Settle through Striker
              </div>
            </div>
          )}
          {actionError && (
            <p className="inline-error" role="alert">
              {actionError}
            </p>
          )}
          {finalTxid && (
            <div className="transaction-id">
              <span>Transaction</span>
              <code title={finalTxid}>{short(finalTxid)}</code>
              <button
                className="icon-button"
                aria-label="Copy transaction ID"
                onClick={() => void navigator.clipboard.writeText(finalTxid)}
              >
                <Copy />
              </button>
            </div>
          )}
          {!busy && (succeeded || refunded) && (
            <button
              className="swap-button modal-primary"
              onClick={() => {
                setAmount("");
                setModal(null);
              }}
            >
              Back to swapping
              <Icon>
                <path d="M4 12h16m-6-6 6 6-6 6" />
              </Icon>
            </button>
          )}
          {!busy && activeSwap && !succeeded && !refunded && (
            <>
              <button
                className="swap-button modal-primary"
                onClick={() => void checkStatus()}
              >
                Check status
              </button>
              {activeSwap.funding && (
                <>
                  <button
                    className="secondary-button"
                    onClick={() => void execute(activeSwap)}
                  >
                    Resume execution
                  </button>
                  <button
                    className="text-button refund-button"
                    onClick={() => void refund()}
                  >
                    Return unspent tokens to wallet
                  </button>
                </>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
