import arkadeIcon from "./assets/arkade-icon.svg";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { WalletBalance } from "@arkade-os/sdk";
import { formatAmount, parseAmount, MIN_QUOTE_FUNDING_SECONDS, hasPendingAuthorization, type SavedSwap } from "@satora/taker-sdk";
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
  recoverWallet,
  createRecoveryBackup,
  parseRecoveryBackup,
  type Vault,
} from "./vault.js";
import "./style.css";
import { WalletBalances } from "./WalletBalances.js";
import { WalletAddress } from "./WalletAddress.js";
import { SwapDetails } from "./SwapDetails.js";
import { HowItWorks } from "./HowItWorks.js";
import { ProtocolPage } from "./ProtocolPage.js";
import { TradingView } from "./TradingView.js";
import { WalletLifecycle, type WalletLifecycleStatus } from "./WalletLifecycle.js";
import { walletSession } from "./wallet-session.js";

const currentPage = () => window.location.hash === "#/protocol" ? "protocol" : window.location.hash === "#/pro" ? "pro" : "swap";

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
  const [page, setPage] = useState(currentPage);
  useEffect(() => {
    const navigate = () => {
      setPage(currentPage());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  useEffect(() => {
    document.title = page === "protocol" ? "Protocol · Striker" : page === "pro" ? "Pro Trading · Striker" : "Striker · Swap on Arkade";
  }, [page]);
  const [config, setConfig] = useState<AppConfig | null>(null),
    [configError, setConfigError] = useState("");
  const [account, setAccount] = useState<ConnectedWallet | null>(null),
    [balance, setBalance] = useState<WalletBalance | null>(null);
  const [balanceError, setBalanceError] = useState(""),
    [revision, setRevision] = useState(0);
  const [balanceRefreshing, setBalanceRefreshing] = useState(false);
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
  const [sessionRemembered, setSessionRemembered] = useState(false);
  const [walletRecovery, setWalletRecovery] = useState<
    "none" | "recover" | "delete"
  >("none");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [restoring, setRestoring] = useState<Vault | null>(null);
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [importKey, setImportKey] = useState("");
  const [legacyBalance, setLegacyBalance] = useState<WalletBalance | null>(null);
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [walletAction, setWalletAction] = useState(false);
  const [walletActionError, setWalletActionError] = useState("");
  const [lifecycle, setLifecycle] = useState<WalletLifecycleStatus | null>(null);
  const [maintenancePending, setMaintenancePending] = useState(false);
  const [maintenanceError, setMaintenanceError] = useState("");
  const [autoRenew, setAutoRenew] = useState(() => {
    try { return localStorage.getItem('striker.auto-renew') !== 'false'; } catch { return true; }
  });
  const maintenanceRunning = useRef(false), lastMaintenanceAttempt = useRef(0);
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
      swap.intentSubmittedAt || swap.fundingStartedAt || swap.funding || swap.result || swap.refund,
  );
  const pending = history.find(
    (swap) => !swap.result && swap.refund?.status !== "refunded" && hasPendingAuthorization(swap, now),
  );
  const maintenanceBlocked = history.some(swap => hasPendingAuthorization(swap, now));
  const activeSwap = history.find((swap) => swap.response.quoteId === selected);
  const availableAsset = BigInt(
    balance?.availableAssets.find((entry) => entry.assetId === asset.id)
      ?.amount ?? 0,
  );
  const sendSymbol = reverse ? "BTC" : asset.symbol;
  const receiveSymbol = reverse ? asset.symbol : "BTC";
  const sendDecimals = reverse ? 8 : asset.decimals;
  const receiveDecimals = reverse ? asset.decimals : 8;
  const availableSend = reverse
    ? BigInt(Math.max(0, (balance?.available ?? 0) - 330))
    : availableAsset;
  const availableReceive = reverse
    ? availableAsset
    : BigInt(balance?.available ?? 0);
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
  const sessionRestoreAttempted = useRef(false);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}config.json`)
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
    setBalanceRefreshing(true);
    try {
      const [current, previous, lifecycle, maintenance] = await Promise.all([
        account.covenant.getBalance(), account.covenant.getLegacyBalance(), account.covenant.getLifecycle(), account.maintenanceStore.get(),
      ]);
      setBalance(current); setLegacyBalance(previous);
      setLifecycle(lifecycle); setMaintenancePending(!!maintenance);
      setBalanceError("");
    } catch {
      setBalanceError("Balance unavailable. Try refreshing.");
    } finally {
      refreshing.current = false;
      setBalanceRefreshing(false);
    }
  }, [account]);
  const maintainDeposits = useCallback(async () => {
    if (!account || maintenanceRunning.current) return;
    maintenanceRunning.current = true; lastMaintenanceAttempt.current = Date.now();
    setWalletAction(true); setMaintenanceError(''); setQuote(null);
    try {
      await withWalletLock(account, () => account.client.maintainWallet(account.maintenanceStore));
      setMaintenancePending(false);
    } catch (error) { setMaintenanceError(errorMessage(error)); }
    finally {
      await refreshBalance(); setWalletAction(false); maintenanceRunning.current = false;
    }
  }, [account, refreshBalance]);
  useEffect(() => {
    if (!autoRenew || !account || walletAction || busy || maintenancePending || maintenanceBlocked || !lifecycle ||
      !(lifecycle.recoverable || lifecycle.expiring) || Date.now() - lastMaintenanceAttempt.current < 60000) return;
    void maintainDeposits();
  }, [autoRenew, account, walletAction, busy, maintenancePending, maintenanceBlocked, lifecycle, maintainDeposits]);
  useEffect(() => {
    if (!account) {
      setBalance(null);
      setLifecycle(null); setMaintenancePending(false); setMaintenanceError('');
      return;
    }
    void refreshBalance();
    const interval = setInterval(() => void refreshBalance(), 15000);
    return () => clearInterval(interval);
  }, [account, refreshBalance]);
  useEffect(() => {
    if (!config || sessionRestoreAttempted.current) return;
    sessionRestoreAttempted.current = true;
    if (!vault) return;
    let cancelled = false;
    setWalletBusy(true);
    void (async () => {
      try {
        const secret = await walletSession.restore(vault);
        if (!secret || cancelled) return;
        const connected = await connectWallet(config, secret, () =>
          setRevision((value) => value + 1),
        );
        if (cancelled) {
          await connected.wallet.dispose();
          return;
        }
        setAccount(connected);
        setSessionRemembered(true);
      } catch {
        if (!cancelled)
          setWalletError("Unable to reconnect. Unlock your wallet to try again.");
      } finally {
        if (!cancelled) setWalletBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, vault]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === vaultStorageKey) {
        void walletSession.clear();
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
      walletAction || maintenancePending ||
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
        .quote(
          asset.id!,
          units.toString(),
          reverse ? "btc-to-token" : "token-to-btc",
        )
        .then((result) => {
          if (!cancelled) setQuote(result);
        })
        .catch((error) => {
          if (!cancelled)
            setQuoteError(
              errorMessage(error) === "No executable maker quotes"
                ? "No quote is available for this amount. The maker may be unavailable or have insufficient liquidity."
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
    walletAction, maintenancePending,
  ]);

  async function openWallet(event: React.FormEvent) {
    event.preventDefault();
    if (!config || walletBusy) return;
    setWalletBusy(true);
    setWalletError("");
    try {
      let encrypted = restoring ?? vault;
      if (!window.isSecureContext)
        throw new Error(
          "Open Striker on HTTPS or localhost to use your wallet.",
        );
      if (walletRecovery === "recover" && vault) {
        if (password !== confirmation)
          throw new Error("Your passwords do not match.");
        if (!importKey.trim())
          throw new Error("Enter your original wallet private key.");
        encrypted = await recoverWallet(vault, password, importKey);
        localStorage.setItem(vaultStorageKey, JSON.stringify(encrypted));
        setVault(encrypted);
        setWalletRecovery("none");
      } else if (!encrypted) {
        if (localStorage.getItem(vaultStorageKey))
          throw new Error(
            "The saved wallet could not be read. Preserve its browser data and restore your encrypted backup before creating another wallet.",
          );
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
      if (restoring) {
        localStorage.setItem(vaultStorageKey, JSON.stringify(encrypted));
        setVault(encrypted);
        setRestoring(null);
      }
      const connected = await connectWallet(config, key, () =>
        setRevision((value) => value + 1),
      );
      setSessionRemembered(await walletSession.remember(encrypted, key));
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
      const data = JSON.parse(await file.text());
      if (data?.type === "striker-recovery") {
        const recovered = parseRecoveryBackup(data);
        if (vault && recovered.publicKey !== vault.publicKey)
          throw new Error(
            "This recovery key belongs to another wallet. Delete the saved wallet first to switch wallets.",
          );
        resetWalletForm(vault ? "recover" : "none");
        setWalletMode("import");
        setImportKey(recovered.privateKey);
        return;
      }
      const encrypted = parseVault(data);
      if (vault && encrypted.publicKey !== vault.publicKey)
        throw new Error(
          "This backup belongs to another wallet. Delete the saved wallet first to switch wallets.",
        );
      setRestoring(encrypted);
      setWalletRecovery("none");
      setPassword("");
      setConfirmation("");
      setImportKey("");
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
  function downloadRecoveryKey() {
    if (!account) return;
    const recovered = createRecoveryBackup(account.identity.toHex());
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(recovered, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `striker-recovery-${recovered.publicKey.slice(0, 8)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function resetWalletForm(mode: "none" | "recover" | "delete") {
    setWalletRecovery(mode);
    setWalletError("");
    setPassword("");
    setConfirmation("");
    setImportKey("");
    setDeleteConfirmation("");
    setRestoring(null);
  }
  function deleteSavedWallet() {
    if (walletBusy || account || deleteConfirmation !== "DELETE") return;
    localStorage.removeItem(vaultStorageKey);
    void walletSession.clear();
    setVault(null);
    setQuote(null);
    setSelected(null);
    setWalletMode("create");
    resetWalletForm("none");
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
          "Execution needs attention. Check status before trying again; unspent deposits stay in your wallet.",
        );
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function movePreviousFunds() {
    if (!account || walletAction) return;
    setWalletAction(true); setWalletActionError("");
    try { await withWalletLock(account, () => account.covenant.moveLegacy()); await refreshBalance(); }
    catch (error) { setWalletActionError(errorMessage(error)); }
    finally { setWalletAction(false); }
  }
  async function withdrawFunds() {
    if (!account || walletAction) return;
    setWalletAction(true); setWalletActionError("");
    try {
      await withWalletLock(account, async () => {
        const storageKey = `striker.withdrawal:${account.publicHex}:${config!.network}`;
        const pending = localStorage.getItem(storageKey);
        const prepared = pending ? JSON.parse(pending) : await account.covenant.prepareWithdrawal(withdrawAddress.trim());
        localStorage.setItem(storageKey, JSON.stringify(prepared));
        await account.covenant.submitWithdrawal(prepared);
        localStorage.removeItem(storageKey);
      });
      setWithdrawAddress(""); await refreshBalance();
    } catch (error) { setWalletActionError(errorMessage(error)); }
    finally { setWalletAction(false); }
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
  const retryableQuoteError = quoteError === 'Maker liquidity expired and needs recovery' || quoteError === 'Maker liquidity is being renewed; try again shortly';
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
                    : retryableQuoteError
                      ? 'Retry quote'
                    : quoteError
                      ? "Try another amount"
                      : quote && expires < MIN_QUOTE_FUNDING_SECONDS
                        ? "Refresh quote"
                        : !quote
                          ? "Enter an amount"
                          : "Review swap";
  const ctaDisabled =
    walletAction || maintenancePending ||
    !config ||
    !asset.id ||
    (!!account &&
      !pending &&
      (!amount ||
        !!amountError ||
        insufficient ||
        needsCarrier ||
        quoting ||
        (!quote && !retryableQuoteError) ||
        (!!quoteError && !retryableQuoteError)));
  const succeeded = activeSwap?.result?.status === "settled",
    refunded = activeSwap?.refund?.status === "refunded";
  const cancelledIntent = activeSwap?.result?.status === "cancelled";
  const displayedSwap =
    activeSwap ?? (quote?.response.quoteId === selected ? quote : undefined);
  const primaryClick = () => {
    if (!account) {
      setWalletError("");
      setModal("wallet");
    } else if (pending) inspect(pending);
    else if (retryableQuoteError) setQuoteNonce(value => value + 1);
    else if (quote && expires < MIN_QUOTE_FUNDING_SECONDS)
      setQuoteNonce((value) => value + 1);
    else if (quote) {
      setActionError("");
      setModal("review");
    }
  };

  return (
    <div className={`app-shell ${page === "pro" ? "pro-shell" : ""}`}>
      <header className="header">
        <a className="brand" href="#/" aria-label="Striker home">
          <span className="brand-mark">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14.7 2 4 14h7l-1.7 8L21 9h-7.5z" />
            </svg>
          </span>
          striker<span className="brand-period">.</span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <a className={page === "swap" ? "nav-active" : ""} href="#/" aria-current={page === "swap" ? "page" : undefined} onClick={() => setModal(null)}>
            Swap
          </a>
          <a className={page === "pro" ? "nav-active" : ""} href="#/pro" aria-current={page === "pro" ? "page" : undefined} onClick={() => setModal(null)}>Pro</a>
          <a className={page === "protocol" ? "nav-active" : ""} href="#/protocol" aria-current={page === "protocol" ? "page" : undefined} onClick={() => setModal(null)}>Protocol</a>
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
            disabled={walletBusy}
            aria-busy={walletBusy}
            onClick={() => {
              setWalletError("");
              setModal("wallet");
              void refreshBalance();
            }}
          >
            <WalletIcon />
            <span>
              {account ? short(account.address) : walletBusy ? "Opening wallet…" : "Connect wallet"}
            </span>
          </button>
        </div>
      </header>
      <main className="main-content">
        {account && page !== 'protocol' && (walletAction || maintenancePending || maintenanceError || lifecycle?.recoverable || lifecycle?.expiring || lifecycle?.awaitingSweep) ?
          <button className="wallet-lifecycle-banner" onClick={() => setModal('wallet')}>
            <span>{walletAction ? 'Renewing wallet deposits…' : maintenanceError ? 'Wallet maintenance needs attention' : maintenancePending ? 'Wallet maintenance is pending' : lifecycle?.recoverable ? 'Expired wallet deposits need recovery' : lifecycle?.awaitingSweep ? 'Expired deposits are waiting for the Arkade sweep' : 'Wallet deposits are nearing expiry'}</span>
            <strong>View wallet ↗</strong>
          </button> : null}
        {page === "protocol" ? <ProtocolPage assetSymbol={asset.symbol} bitcoinToToken={reverse} /> : page === "pro" ? <TradingView
          asset={asset} connected={!!account} balanceReady={!!balance}
          btcBalance={BigInt(balance?.available ?? 0)} tokenBalance={availableAsset}
          availableSend={availableSend}
          reverse={reverse} setDirection={(selling) => {
            if (selling === reverse) return;
            setReverse(selling); setAmount(""); setQuote(null); setQuoteError("");
          }}
          amount={amount} setAmount={setAmount} percentage={percentage}
          quote={quote} quoting={quoting} expires={expires} history={history}
          locked={busy || walletAction || maintenancePending || !!pending} cta={walletAction ? 'Maintaining wallet…' : cta} disabled={ctaDisabled || busy}
          error={configError || amountError || quoteError || balanceError}
          onReview={primaryClick} onRefreshQuote={() => setQuoteNonce(value => value + 1)}
          onRefreshBalance={() => void refreshBalance()}
          onReceive={() => { setWalletError(""); setModal(account ? "receive" : "wallet"); }}
          onInspect={inspect} onActivity={() => setModal("activity")} pending={pending}
        /> : <>
        <section className="hero" aria-labelledby="hero-title">
          <div className="eyebrow">
            <span />
            YOUR NEXT MOVE, ON ARKADE
          </div>
          <h1 id="hero-title">
            {reverse ? "Bitcoin" : asset.symbol} to{" "}
            <em>{reverse ? `${asset.symbol}.` : "Bitcoin."}</em>
          </h1>
          <p>One swap. All on Arkade. Always your wallet.</p>
        </section>
        <section className="swap-section" aria-label="Swap assets">
          <div className="swap-frame">
            <div className="amount-card send-card">
              <div className="card-topline">
                <label htmlFor="send-amount">You send</label>
                {asset.demo && !reverse && (
                  <span className="demo-badge">DEMO ASSET</span>
                )}
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
                  disabled={busy || walletAction || maintenancePending || !!pending}
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
                      ? formatAmount(
                          reverse ? BigInt(balance.available) : availableAsset,
                          sendDecimals,
                        )
                      : "—"}
                  </b>{" "}
                  {sendSymbol}
                </span>
                <div className="percentages">
                  {[25, 50, 75, 100].map((percent) => (
                    <button
                      key={percent}
                      disabled={!account || !balance || busy || walletAction || maintenancePending || !!pending}
                      onClick={() => percentage(percent)}
                    >
                      {percent === 100 ? "Max" : `${percent}%`}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <button
              className="direction-arrow"
              aria-label="Switch swap direction"
              title="Switch swap direction"
              disabled={busy || walletAction || maintenancePending || !!pending}
              onClick={() => {
                setReverse((value) => !value);
                setAmount("");
                setQuote(null);
                setQuoteError("");
              }}
            >
              <Icon>
                <path d="M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4" />
              </Icon>
            </button>
            <div className="amount-card receive-card">
              <div className="card-topline">
                <span>You receive</span>
                {asset.demo && reverse && !quote && (
                  <span className="demo-badge">DEMO ASSET</span>
                )}
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
                    {balance
                      ? formatAmount(availableReceive, receiveDecimals)
                      : "—"}
                  </b>{" "}
                  {receiveSymbol}
                </span>
                {quote && (
                  <span className="sats-label">
                    {reverse
                      ? `${formatAmount(receive, asset.decimals)} ${asset.symbol}`
                      : `${receive.toLocaleString()} sats`}
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
                  {reverse
                    ? "The 330 sats carrier stays with the tokens you receive in your wallet."
                    : "The carrier travels with your token payment to the maker. It comes from your BTC balance."}
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
        <HowItWorks assetSymbol={asset.symbol} bitcoinToToken={reverse} />
        </>}
      </main>
      <footer className="footer">
        <span>Built for the way bitcoin moves.</span>
        <div>
          <span className="footer-arkade">
            <img className="arkade-mark" src={arkadeIcon} alt="" aria-hidden="true" />Powered by Arkade
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
              : walletRecovery === "delete"
                ? "Delete saved wallet?"
                : walletRecovery === "recover"
                  ? "Recover your wallet."
                  : vault || restoring
                    ? "Welcome back."
                    : "Your wallet. Your move."
          }
          close={() => {
            if (!walletBusy && !walletAction) {
              setModal(null);
              resetWalletForm("none");
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
              <WalletBalances
                account={account}
                balance={balance}
                asset={asset}
                refreshing={balanceRefreshing}
                error={balanceError}
                refresh={() => void refreshBalance()}
              />
              <WalletLifecycle status={lifecycle} pending={maintenancePending} busy={walletAction}
                error={maintenanceError} autoRenew={autoRenew} blocked={maintenanceBlocked || busy}
                onAutoRenew={enabled => { setAutoRenew(enabled); try { localStorage.setItem('striker.auto-renew', String(enabled)); } catch { /* Session preference still applies. */ } }}
                onMaintain={() => void maintainDeposits()} />
              <p className="small-print">
                {sessionRemembered
                  ? "Stays unlocked in this tab until you lock it or close the tab."
                  : "Unlock with your password again after reloading this tab."}
              </p>
              <p className="small-print">Deposits arrive directly in your swap wallet. Payments and change return here after each swap.</p>
              {legacyBalance && legacyBalance.total > 0 && <div className="legacy-wallet-funds">
                <p className="small-print">Previous wallet: {legacyBalance.total.toLocaleString()} sats
                  {legacyBalance.assets.length ? ` and ${legacyBalance.assets.length} asset type(s)` : ""}. Move these funds to make them available for swaps.</p>
                <button className="secondary-button" disabled={walletAction || busy || maintenancePending} onClick={() => void movePreviousFunds()}>
                  {walletAction ? "Moving funds…" : "Move previous wallet funds"}
                </button>
              </div>}
              <WalletAddress address={account.address} />
              <button
                className="secondary-button"
                onClick={() => void copyAddress()}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? "Address copied" : "Copy address"}
              </button>
              <button
                className="secondary-button"
                onClick={downloadRecoveryKey}
              >
                <Icon>
                  <path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" />
                </Icon>
                Download recovery key
              </button>
              <p className="small-print">
                Contains your unencrypted private key. Anyone with this file can
                spend your funds. Keep it safe; recovery does not need your old
                password.
              </p>
              <details className="wallet-withdrawal">
                <summary>Send all funds to another Arkade wallet</summary>
                <p className="small-print">Uses your owner key and Arkade server. Striker and the Emulator are not needed.</p>
                <input aria-label="Withdrawal Arkade address" placeholder="Arkade destination address" value={withdrawAddress}
                  onChange={event => setWithdrawAddress(event.target.value)} />
                <button className="secondary-button" disabled={walletAction || busy || maintenancePending || !withdrawAddress.trim()}
                  onClick={() => void withdrawFunds()}>{walletAction ? "Sending…" : "Send all funds"}</button>
              </details>
              {walletActionError && <p className="inline-error" role="alert">{walletActionError}</p>}
              <button
                className="text-button lock-wallet"
                disabled={busy || walletAction}
                onClick={() => {
                  void walletSession.clear();
                  void account.wallet.dispose();
                  setAccount(null);
                  setQuote(null);
                  setModal(null);
                }}
              >
                Lock wallet
              </button>
            </>
          ) : walletRecovery === "delete" ? (
            <>
              <p className="modal-caption">
                This removes the saved wallet key from this browser. It does not
                move your funds or cancel pending swaps.
              </p>
              <p className="inline-error">
                You will lose access to this wallet unless you have its private
                key, or an encrypted backup and its password. A backup alone
                cannot recover a forgotten password.
              </p>
              {vault && (
                <button className="secondary-button" onClick={backup}>
                  Download encrypted backup
                </button>
              )}
              <form
                className="wallet-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  deleteSavedWallet();
                }}
              >
                <label>
                  Type DELETE to confirm
                  <input
                    autoComplete="off"
                    spellCheck={false}
                    value={deleteConfirmation}
                    onChange={(event) =>
                      setDeleteConfirmation(event.target.value)
                    }
                    placeholder="DELETE"
                    aria-label="Delete confirmation"
                  />
                </label>
                <button
                  className="swap-button delete-wallet-button"
                  disabled={deleteConfirmation !== "DELETE"}
                >
                  Delete saved wallet
                </button>
              </form>
              <button
                className="text-button lock-wallet"
                onClick={() => resetWalletForm("none")}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <p className="modal-caption">
                {walletRecovery === "recover"
                  ? "Use your original private key to set a new password. Your wallet address, funds and swap history stay the same."
                  : restoring
                    ? "Enter the password for your encrypted backup. The saved wallet is replaced only after the backup unlocks."
                    : vault
                      ? "Unlock the wallet saved in this browser."
                      : "Create a browser wallet, or bring an existing Arkade key. Your key is encrypted with your password."}
              </p>
              {!vault && !restoring && (
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
                {((!vault && !restoring && walletMode === "import") ||
                  walletRecovery === "recover") && (
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
                  {walletRecovery === "recover"
                    ? "New password"
                    : vault || restoring
                      ? "Password"
                      : "Choose a password"}
                  <input
                    type="password"
                    autoComplete={
                      (vault || restoring) && walletRecovery !== "recover"
                        ? "current-password"
                        : "new-password"
                    }
                    minLength={1}
                    maxLength={256}
                    placeholder={
                      (vault || restoring) && walletRecovery !== "recover"
                        ? "Your wallet password"
                        : "Choose a password"
                    }
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    disabled={walletBusy}
                  />
                </label>
                {((!vault && !restoring) || walletRecovery === "recover") && (
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
                    : walletRecovery === "recover"
                      ? "Recover & connect"
                      : vault || restoring
                        ? "Unlock wallet"
                        : walletMode === "import"
                          ? "Import & connect"
                          : "Create & connect"}
                </button>
              </form>
              {vault && !restoring && walletRecovery === "none" && (
                <div className="wallet-recovery-actions">
                  <button
                    className="text-button"
                    disabled={walletBusy}
                    onClick={() => resetWalletForm("recover")}
                  >
                    Forgot password? Recover wallet
                  </button>
                  <button
                    className="text-button danger"
                    disabled={walletBusy}
                    onClick={() => resetWalletForm("delete")}
                  >
                    Delete saved wallet
                  </button>
                </div>
              )}
              {walletRecovery === "recover" && (
                <>
                  <p className="small-print">
                    Without your private key, the password cannot be reset. An
                    encrypted backup still needs its original password.
                  </p>
                  <button
                    className="text-button lock-wallet"
                    disabled={walletBusy}
                    onClick={() => resetWalletForm("none")}
                  >
                    Back to unlock
                  </button>
                </>
              )}
              {restoring && (
                <button
                  className="text-button lock-wallet"
                  disabled={walletBusy}
                  onClick={() => resetWalletForm("none")}
                >
                  Cancel backup restore
                </button>
              )}
              <label className="backup-import">
                Have a Striker backup? <span>Restore backup</span>
                <input
                  type="file"
                  disabled={walletBusy}
                  accept="application/json,.json"
                  onChange={(event) =>
                    void importBackup(event.target.files?.[0])
                  }
                />
              </label>
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
            Send BTC or {asset.symbol} on Arkade directly to your swap wallet. Use the same
            network and Arkade server.
          </p>
          <div className="receive-symbol">
            <WalletIcon />
          </div>
          <div className="network-label">
            <span className="status-dot" />
            {config?.network === "regtest" ? "Regtest" : "Mutinynet"} · Arkade
          </div>
          <WalletAddress address={account.address} />
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
                    <Coin
                      symbol={asset.symbol}
                      bitcoin={swap.request.direction === "btc-to-token"}
                      small
                    />
                    <Coin
                      symbol={asset.symbol}
                      bitcoin={swap.request.direction !== "btc-to-token"}
                      small
                    />
                  </span>
                  <span>
                    <strong>
                      {formatAmount(
                        BigInt(swap.request.giveAmount),
                        swap.request.direction === "btc-to-token"
                          ? 8
                          : asset.decimals,
                      )}{" "}
                      {swap.request.direction === "btc-to-token"
                        ? `BTC → ${asset.symbol}`
                        : `${asset.symbol} → BTC`}
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
                      : swap.result?.status === "cancelled" ? "Cancelled" : swap.refund?.status === "refunded"
                        ? "Returned"
                        : swap.intentInputs && !hasPendingAuthorization(swap, now) ? "Authorization expired"
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
                  {formatAmount(BigInt(quote.request.giveAmount), sendDecimals)}{" "}
                  {sendSymbol}
                </strong>
              </span>
            </div>
            <Arrow />
            <div>
              <Coin bitcoin={!reverse} symbol={receiveSymbol} />
              <span>
                You receive
                <strong>
                  {formatAmount(receive, receiveDecimals, reverse)}{" "}
                  {receiveSymbol}
                </strong>
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
            disabled={busy || quoting}
            onClick={() => {
              if (expires < MIN_QUOTE_FUNDING_SECONDS) {
                setModal(null);
                setQuoteNonce((value) => value + 1);
              } else void execute(quote);
            }}
          >
            {expires < MIN_QUOTE_FUNDING_SECONDS ? "Refresh quote" : "Confirm swap"}
            <Icon>
              <path d="M4 12h16m-6-6 6 6-6 6" />
            </Icon>
          </button>
          {expires < MIN_QUOTE_FUNDING_SECONDS && (
            <p className="inline-error">
              Refresh this quote so there is enough time to authorize and settle your swap.
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
              : cancelledIntent
                ? "Authorization cancelled. Your deposits are back in your swap wallet."
                : refunded
                ? "Your unspent payment has been returned."
                : busy
                  ? "Keep this window open while your swap settles."
                  : displayedSwap?.response.protocol === "intent-v1" ? "Check the swap status or resume execution. Unspent deposits remain in your wallet." : "Check the swap status, resume execution, or return an unspent offer."}
          </p>
          {displayedSwap && (
            <div className="result-amount">
              <span>
                {formatAmount(
                  BigInt(displayedSwap.request.giveAmount),
                  displayedSwap.request.direction === "btc-to-token"
                    ? 8
                    : asset.decimals,
                )}{" "}
                {displayedSwap.request.direction === "btc-to-token"
                  ? "BTC"
                  : asset.symbol}
              </span>
              <span>→</span>
              <strong>
                {formatAmount(
                  BigInt(displayedSwap.response.offer.quote.x),
                  displayedSwap.request.direction === "btc-to-token"
                    ? asset.decimals
                    : 8,
                  displayedSwap.request.direction === "btc-to-token",
                )}{" "}
                {displayedSwap.request.direction === "btc-to-token"
                  ? asset.symbol
                  : "BTC"}
              </strong>
            </div>
          )}
          {busy && (
            <div className="progress-list">
              <div className="done">
                <Check />
                Quote verified locally
              </div>
              <div className={(activeSwap?.funding || activeSwap?.intentInputs) ? "done" : "current"}>
                {(activeSwap?.funding || activeSwap?.intentInputs) ? (
                  <Check />
                ) : (
                  <span className="step-dot" />
                )}
                {displayedSwap?.response.protocol === "intent-v1" ? "Sign swap authorization" : "Fund your swap"}
              </div>
              <div className={(activeSwap?.funding || activeSwap?.intentInputs) ? "current" : ""}>
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
          {displayedSwap && (
            <SwapDetails
              quoteId={displayedSwap.response.quoteId}
              fundingTxid={displayedSwap.funding?.fundingTxid}
              fundingVout={displayedSwap.funding?.fundingVout}
              settlementTxid={displayedSwap.result?.txid}
              refundTxid={displayedSwap.refund?.txid}
              cancellationTxid={displayedSwap.cancellation?.txid}
              depositInputs={displayedSwap.intentInputs}
              network={config?.network ?? "regtest"}
            />
          )}
          {!busy && (succeeded || refunded || cancelledIntent) && (
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
          {!busy && activeSwap && !succeeded && !refunded && !cancelledIntent && (
            <>
              <button
                className="swap-button modal-primary"
                onClick={() => void checkStatus()}
              >
                Check status
              </button>
              {activeSwap.response.protocol === "intent-v1" && <>
                <button className="secondary-button" onClick={() => void execute(activeSwap)}>Resume execution</button>
                <button className="text-button" onClick={async () => {
                  if (!account || busy) return;
                  setBusy(true); setActionError("");
                  try { await withWalletLock(account, () => account.client.cancelIntent(activeSwap.response.quoteId)); setRevision(v => v + 1); await refreshBalance(); }
                  catch (error) { setActionError(errorMessage(error)); }
                  finally { setBusy(false); }
                }}>Cancel authorization and keep funds</button>
              </>}
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
                    Return unspent funds to wallet
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
