# TypeScript service PoC

This PoC trades a Striker BTC liquidity deposit against a Banco-style user offer
selling an Arkade test asset for BTC. Three independently runnable TypeScript
projects implement the maker, router/executor, and user. The shared covenant byte
format remains the reference for a later Rust implementation.

## Projects and communication

| Project | Executable | Owns |
|---|---|---|
| `apps/striker` | `striker` | Maker endpoint configuration, quote selection, transaction construction and submission |
| `apps/maker` | `maker` | Maker private key, liquidity deposit, pricing and quote signatures |
| `apps/taker` | `taker` | Taker private key, quote selection request, funding and swap execution request |
| `packages/protocol` | Library only | Covenant scripts, signed quote encoding, HTTP types and Arkade adapters |

```mermaid
sequenceDiagram
    participant T as taker
    participant S as striker
    participant M as maker
    participant A as Emulator / arkd
    T->>S: Request quote for asset quantity
    S->>M: Request signed quote
    M-->>S: Signed terms against deposited liquidity
    S-->>T: Best quote + user covenant funding address
    Note over T: Derive address locally, verify, fund via Arkade
    T->>S: Execute quote with funded outpoint
    S->>A: Construct, validate and settle atomic swap
    S-->>T: Settlement transaction ID
```

There is **no maker–taker transport**. Only Striker knows maker endpoint URLs;
the taker receives public signed terms, never a maker URL. Maker quoting receives
only the asset and amount, not the taker's identity. Wallets use Arkade directly
to deposit/fund, but requests for quotes and swap execution go through Striker.
Striker holds neither actor's private key. A maker can go offline after quoting.

Each app has its own `package.json`, build configuration, and executable wrapper.
They share one npm workspace lockfile. Build output is regular Node JavaScript;
these are executable TypeScript projects, not native Rust binaries yet.

## Run

Requires Node 22+; regtest additionally requires Docker with Compose. The regtest stack downloads several
images and needs a few minutes on first boot. Default ports include 7070 (arkd),
7073 (Emulator), and 3000 (Esplora); change `.env.regtest` and the test endpoint
environment variables together if these ports are occupied.

```sh
npm ci
npm run build
npm run check
npm test
npm run demo
npm run regtest -- start
npm run test:e2e
npm run regtest -- stop
```

`scripts/regtest.mjs` clones ArkLabsHQ/arkade-regtest into ignored `.cache/`, pinned
to `9ac38fe94585bf99a65581d2e79eda63c7e61b6b`. Its `emulator` profile brings up
the base Bitcoin/indexer services, arkd, and the Emulator. The Compose project
and container prefix are isolated as `striker-poc`; block production is manual.
This project's overrides use consistent seconds-based locktimes and a one-day
VTXO expiry so the CLI faucet stays usable between test runs. Stop preserves
test volumes. Restarting the stack replenishes its CLI faucet.

The fast tests check the wire format and transaction construction. Only the E2E
suite exercises actual covenant validation and settlement; fast tests passing
alone do **not** establish that the script works. `processes.test.ts` launches
the compiled executables as separate OS processes, selects between two makers,
stops both makers, and executes from the taker through Striker. It also tests
rejection of a modified funding address and duplicate execution requests.

## Start with just

Install `just` if needed (`brew install just` on macOS). From this repository:

```sh
just setup       # install/build, start regtest, fund wallets, mint an asset, deposit liquidity
just start       # run Maker and Striker together in the foreground
```

In a second terminal:

```sh
just taker       # quote and execute 2000 asset units through Striker
just taker 1000  # choose another quantity
just status      # inspect the most recent swap
```

Ctrl-C in the `just start` terminal shuts down both services. The taker is a
one-shot user CLI, not a daemon. To run the two services separately, use
`just maker` and `just striker` in separate terminals instead of `just start`.
All swap requests still go through Striker.

`just setup` preserves existing keys, configuration, asset and deposit. It funds
wallets only when their BTC balance is low, and creates liquidity only when no
saved deposit exists. It refuses an unavailable saved deposit instead of silently
replacing it. Demo liquidity and the minted asset are finite. After explicitly
resetting regtest, preserve the key files, move the old `.maker/deposit.json`
aside, remove the stale `assetId` from `.taker/config.json`, and rerun setup.

Other recipes:

```sh
just init           # initialize config/key files without network calls or funding
just maker-address  # show the persistent maker wallet address
just taker-address  # show the persistent taker wallet address
just quote 2000     # request a quote and save it, without funding
just execute        # fund and execute the most recent quote
just test           # type checking, unit tests and regtest scenarios
just regtest-stop   # stop the test infrastructure, preserving its volumes
just --list
```

Execute a separately requested quote before its deadline (30 seconds by default).
The configured demo rate offers five BTC sats per asset atomic unit. `just taker`
performs quote and execution together so there is no manual copy/paste delay.

## Persistent local configuration

The defaults are relative to the current directory; `just` runs recipes from the
repository directory. Configuration files are created on first use and preserve
subsequent edits.

| Folder/file | Contents |
|---|---|
| `.striker/config.json` | Maker endpoint list, bind host and port; **no private key** |
| `.maker/config.json` | Bind host/port and quote TTL |
| `.maker/private-key` | Persistent maker signing/wallet key |
| `.maker/deposit.json` | Public liquidity deposit, original outpoint and configured price fraction |
| `.taker/config.json` | Striker URL, test asset ID and default quantity |
| `.taker/private-key` | Persistent taker wallet key |
| `.taker/quotes/` | Separate quote, funding and execution records for each trade |
| `.taker/last-quote.json` | Pointer to the most recently requested quote |

New folders are created with mode `0700` and key files with mode `0600`. Key files
are never printed. The three default folders are excluded from Git. Existing
invalid keys cause an error; they are never regenerated in place. Maker deposit
files and user quote records contain no private keys.

Each executable accepts `--config-dir DIR`; environment variables
`STRIKER_CONFIG_DIR`, `MAKER_CONFIG_DIR`, and `TAKER_CONFIG_DIR` provide defaults
for scripts as well. CLI settings override the corresponding `config.json`
settings. Set both the maker listener and Striker's maker URL if changing ports.

For migration from the earlier environment-only setup, `MAKER_PRIVATE_KEY` and
`TAKER_PRIVATE_KEY` import the supplied key when no key file exists. If a saved
key already exists, an environment key must match it; use a different config
folder for another identity. Restarting uses the saved key without requiring
those variables. Back up the key files if you want to preserve these test wallets.

Equivalent direct CLI commands after building:

```sh
npm run maker -- init
npm run taker -- init
npm run striker -- serve
npm run maker -- serve
npm run taker -- quote --give-amount 2000
npm run taker -- execute
npm run taker -- status
```

The npm-installed aliases are also available as `npm exec -- maker`,
`npm exec -- striker`, and `npm exec -- taker`. Explicit `--state`, `--out`,
`--quote`, `--striker`, and `--asset-id` flags still work.

The taker authenticates the maker signature and derives the user covenant locally
before funding it. It records the funding transaction before requesting execution,
and repeated execution returns the settled transaction while Striker remains
running. The funding submission and local file write are not atomic: after a
process crash at that boundary, inspect the wallet before retrying. Persistent
keys and quote files do not make Striker's in-memory execution store durable.

## HTTP boundary

All servers bind `127.0.0.1` by default. Request amounts and epochs are decimal
strings; bytes are lowercase hex. The existing signed quote bytes are unchanged.

| Service | Endpoint | Purpose |
|---|---|---|
| Maker | `POST /v1/quotes` | Receive asset/amount from Striker; return a signed quote |
| Striker | `POST /v1/quotes` | Poll configured makers, validate live liquidity, choose most BTC for the same asset amount |
| Striker | `POST /v1/swaps` | Receive quote ID and funding txid/vout; reconstruct, validate, and settle |
| Striker | `GET /v1/swaps/:quoteId` | Return execution status and settled txid |
| Both servers | `GET /health` | Report process liveness |

Striker stores quotes and execution status in memory. It rechecks the maker tip,
epoch, deadline, user covenant, and exact funding asset/quantity before execution.
Concurrent duplicate requests are refused; completed duplicates return the same
txid. A failed submission is held as failed rather than automatically resubmitted,
because a network error may occur after settlement. Status is lost on restart;
durable execution records and recovery are future work.

## First transaction

Inputs:

- A maker BTC covenant deposit with its epoch in an extension packet.
- A user covenant holding exactly the asset quantity offered for the swap.

Outputs:

0. Exactly the quoted BTC to the user. Banco's full-fill BTC predicate enforces
   the user's destination and minimum amount.
1. Remaining BTC to the maker's identical covenant address.
2. The quoted Arkade asset to the maker's fixed destination, carrying the user's
   input satoshis.
3. One extension containing asset accounting, both covenant witnesses, and epoch.
4. The SDK's zero-value ephemeral anchor.

The maker witness is `[BIP340 signature, encoded quote]`. The covenant verifies
the signature, parses those same signed bytes, checks the deadline against the
Emulator clock, checks the prior and new epoch packets, and checks the outputs.
Neither owner signs a fill. Both trees also have an immediate owner + arkd
tapscript leaf for cooperative withdrawal/refund. Cancellation uses that leaf
to recreate the maker deposit with epoch incremented; the covenant fill path
cannot change the epoch.

The E2E suite tests expired quotes, wrong epochs, forged signatures, diverted
payments/change, and underpayments that preserve transaction accounting. It then
tests repeated fills, a new signed price against the existing deposit, an epoch
bump, a fresh-epoch fill, refund, and withdrawal.
Each rejected fill must produce a new covenant execution failure in the local
Emulator container's logs, at the expected input. Emulator v0.0.8 hides the actual
failure behind an HTTP `internal error`, so HTTP rejection alone is insufficient.
These assertions require Docker log access (`EMULATOR_CONTAINER` defaults to
`striker-poc-emulator`) and exclusive use of that Emulator during the test.

## Mutinynet setup

Use the same maker/taker keys as regtest; no key copy or import is needed:

```sh
just setup mutinynet
just start mutinynet
# Another terminal:
just taker 2000 mutinynet
just status mutinynet
```

Setup first creates or loads the wallets and displays both Arkade addresses. It
checks available balances and never calls the Mutinynet faucet. Initial setup
requires at least 26,000 maker sats and 1,000 taker sats.
These must be **Arkade BTC VTXOs** on the same Arkade server, rather than an
on-chain balance. If a wallet is underfunded, setup prints the addresses and
stops before issuing the token or creating the deposit. Send test sats from a
funded Arkade wallet and rerun the same command. No Docker stack is started for
the hosted Mutinynet profile.

Once funded, setup issues 20,000 units of the **Striker test asset (POC)** into
the taker wallet, saves its asset ID, and deposits 25,000 maker sats with the
configured demo rate of 5 sats per asset atomic unit. This is a demo token, not
USDt. Repeated setup reuses the saved asset and deposit. Preserve these state
files as well as the keys; deleting them can create another asset or deposit.
The maker sells BTC; the taker sells the token and receives Arkade BTC.

| Data | Regtest | Mutinynet |
|---|---|---|
| Maker key | `.maker/private-key` | Same file |
| Taker key | `.taker/private-key` | Same file |
| Maker config/deposit | `.maker/` | `.maker/mutinynet/` |
| Taker config/quotes | `.taker/` | `.taker/mutinynet/` |
| Striker config | `.striker/` | `.striker/mutinynet/` |

`--config-dir` and the role's `*_CONFIG_DIR` change the root containing the key;
the Mutinynet state subfolder is still added. Existing regtest files keep their
original locations. CLI commands accept `--network regtest|mutinynet`, or set
`STRIKER_NETWORK`. Just recipes also accept a network argument; for `taker` and
`quote`, amount comes first. `STRIKER_NETWORK=mutinynet just taker` uses the
configured amount. Both networks use the same local service ports, so stop one
service pair before starting the other.

Defaults are `https://mutinynet.arkade.sh`,
`https://emulator.mutinynet.arkade.sh`, and
`https://mempool.mutinynet.arkade.sh/api`. The Emulator public key comes from the
SDK's pinned Mutinynet constant; its reported key must match. `ARK_URL`,
`EMULATOR_URL`, `ESPLORA_URL`, and `EMULATOR_PUBKEY` remain explicit overrides.
The reported server network must match the selected network. Current settlement
requires a zero offchain transaction fee rate and refuses a nonzero rate.
A successful funding/issuance step does not establish covenant compatibility:
only a completed swap validates the deployed Emulator's handling of the scripts
and experimental epoch packet.

Live validation on 2026-10-16 completed token issuance, a 25,000-sat maker
deposit, taker funding, and a cooperative refund. Atomic settlement was rejected
by the hosted Emulator (`v0.0.9-rc.2`) with an opaque `internal error`. Local
reconstruction passed that version's covenant, previous-output and checkpoint
validation; the hosted failure remains unresolved. The attempted swap's 2,000
tokens were returned to the taker wallet and its saved quote records the refund.
Settlement through the hosted Mutinynet Emulator is not yet verified end to end.
The local Emulator profile below has completed a real Mutinynet swap.

### Local Emulator on Mutinynet

Run the Emulator on this machine while wallets and settlement still use the
public Mutinynet Arkade server. Docker is required for this profile:

```sh
just setup mutinynet local
just start mutinynet local
# Another terminal:
just taker 100 mutinynet local
just status mutinynet local
just maker-balance mutinynet local
just taker-balance mutinynet local
# Full server-side debugging output:
just emulator-logs
# Stop the Emulator when finished:
just emulator-stop
```

Setup/start use an image built from a pinned `v0.0.9-rc.2` source archive with
the local checkpoint compatibility patch, producing `v0.0.9-rc.2-striker.1`. First build downloads a
Go builder image; Go does not need to be installed on the host. The build runs
a regression test for signature merging. The container listens only on
`127.0.0.1:7074`. It connects to `https://mutinynet.arkade.sh` over TLS. Services
use its persistent public pin from `.emulator/public.json`, rather than the
hosted Emulator's key. The separate signing key is generated once in
`.emulator/private-key`; its Docker env file is also owner-readable only. The
`.emulator/` directory is ignored by Git. Preserve this key while its covenants
hold funds. `EMULATOR_CONFIG_DIR` can relocate these Emulator files.

Maker/taker wallet keys and wallet addresses remain the same. Local-Emulator
configs, deposits and quotes live under `.maker/mutinynet/local-emulator/`,
`.taker/mutinynet/local-emulator/` and `.striker/mutinynet/local-emulator/`.
Setup reuses the hosted profile's token ID when present and creates a separate
20,000-sat maker deposit (requiring 21,000 available maker sats and 1,000 taker
sats initially). It never requests faucet funds. Existing hosted-key deposits
remain in their original state files; switching Emulator endpoints cannot
change the key committed by an already-funded covenant.

Alternatively export `STRIKER_NETWORK=mutinynet STRIKER_EMULATOR=local` for CLI
commands. `just emulator-start` starts the standalone container; Ctrl-C in
`just start` stops maker/Striker but leaves that container running for log
inspection. Both profiles use the same maker/Striker ports, so run only one
service pair at a time. The local profile defaults to 100 asset units per
trade (500 sats at the demo rate), so the small deposit supports several fills.
Prices remain static demo prices.

`maker balance` and `taker balance` (or the `just maker-balance` and
`just taker-balance` recipes) show wallet balances. Wallet BTC amounts are sats;
asset amounts are atomic units. Maker balance additionally reports the selected
profile's covenant deposit separately, since deposited liquidity is outside the
ordinary wallet balance. `availableToSwapSats` retains the 330-sat recursive
remainder and is zero if the deposit has no unique live tip. Wallet balances
are shared by the two Mutinynet profiles; the deposit report is specific to the
selected profile. These commands only read balances and do not request funding.

The local patch submits checkpoints without client signatures, retaining the
verified signatures locally for finalization, as the wallet SDK flow does. It
then merges signatures by public key and leaf hash, removes identical duplicates
and rejects conflicts. Unpatched local testing reproduced malformed checkpoint
PSBTs from duplicate signatures; deduplication alone then exposed an arkd stage
error. The unsigned-checkpoint submission flow completed a real Mutinynet swap
on 2026-10-16: 500 POC units for 2,500 sats, transaction
`82d69f2c53cd6dc5214876c5ad73aad8eeef0d8aee72715f80affb804c2b9a9c`.
The hosted Emulator's original failure remains unconfirmed without its logs;
this workaround applies to the local profile. Failed diagnostic orders are
preserved in the local quote directory for inspection; they must not be blindly
retried or re-funded based only on a client error.

## Wire format and Rust port

`vectors/quote-v0.json` contains deterministic quote bytes, digest, signature,
covenant bytes/ASM, scriptPubKeys, and an unsigned synthetic settlement PSBT.
These are conformance vectors, not a funded transaction. The fixture keys are
public test keys. To intentionally regenerate after a protocol change:

```sh
npm run demo -- --write-vector
```

The signed message is the concatenation of:

| Field | Encoding |
|---|---|
| Domain/version | UTF-8 `striker/quote/v0` followed by a zero byte |
| Lineage | 32 opaque bytes |
| Wanted asset | 34-byte SDK AssetId (display-order txid + u16 LE group) |
| Maker destination | 34-byte P2TR scriptPubKey |
| BTC sats X | 8-byte unsigned LE, 1..2^63-1 |
| Asset units Y | 8-byte unsigned LE, 1..2^63-1 |
| Epoch | 8-byte unsigned LE, 0..2^63-1 |
| Deadline | 8-byte unsigned LE Unix seconds, 0..2^63-1 |

BIP340 signs SHA256 of that whole message. Fixed widths avoid concatenation
ambiguity, and the integer cap aligns positive u64 LE with the VM's fixed-width
sign-magnitude integers. Asset introspection takes the txid in reversed byte
order; the wire quote retains SDK serialization order. The experimental epoch
packet tag is `0x7e`, containing eight LE bytes. It is transaction-wide in this PoC.

Port `packages/protocol/src/{quote,covenant,settlement}.ts` to Rust against the same
vectors, then implement the three executables against the documented HTTP
boundary. Keep the TypeScript E2E driver initially. Prove byte equality and run
the same adversarial scenarios before replacing the driver. No independent
Script VM is implemented here.

## Boundaries

- One BTC maker deposit and one asset user offer per settlement. Striker selects
  among several makers, but does not aggregate deposits, route multiple hops,
  or charge service fees. Maker prices are configured integer fractions.
- The services support regtest and Mutinynet with in-memory orders and no durable
  execution recovery. Deposit tracking requires exactly one live tip at its
  script; full original-outpoint lineage traversal remains future work. Maker
  cancellation/withdrawal and taker refund are tested at the covenant level;
  their management commands are not yet exposed by these CLIs.
- The recursive BTC remainder must be at least 330 sats; final deposit exhaustion
  is deferred. Asset liquidity deposits require separate asset balance accounting:
  an asset quantity is **not** the VTXO's native BTC value.
- Banco compatibility means composition with its reproduced **full-fill BTC
  predicate**, not compatibility with every Banco SDK, TLV format, or partial-fill
  contract. The PoC has its own tree and immediate cancellation behavior.
- Expiry is enforced when the Emulator validates. This does not prove that a
  previously co-signed transaction cannot settle after the deadline.
- The stack's single-spend rule prevents concurrent spends; quotes reserve no
  liquidity. This suite does not yet stress competing fills or refund races.
- Owner paths still require arkd. These PoC trees have no unilateral L1 exit
  leaf and must not be used with real funds. Exit construction and recovery are
  separate work before production.
- Epoch storage and fixed output slots must be redesigned for multiple makers
  in one transaction. The epoch packet tag is experimental, not registered.

References: [Arkade regtest](https://github.com/ArkLabsHQ/arkade-regtest),
[Banco predicate](https://github.com/arkade-os/banco/blob/master/src/offer.ts),
[Emulator](https://github.com/arkade-os/emulator).
