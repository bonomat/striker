# Signed witness programs: isolated prototype

The current maker covenant can run as an authorized program supplied through the
Emulator witness. The deposit commits to a fixed signature-and-execution wrapper;
the supplied program is authenticated before the VM executes it against the actual
transaction. Different authorized programs can use the same wrapper and P2TR output.

This is a research prototype on `experimental/signed-witness-programs`. Live services,
the production Emulator image, quotes, and wallet code do not enable or import it.
It requires a change to the pinned Emulator VM; CSFS alone cannot execute code.

## Preserved working milestone

- Git tag: [`usd8-dynamic-v1-working`](https://github.com/bonomat/striker/tree/usd8-dynamic-v1-working).
- Commit: `97098625dc16b9b0683b3a8df84c3e965296ab65`.
- Baseline validation: `npm run check` and all 40 existing unit tests pass.
- Runtime snapshot: `.cache/milestones/usd8-dynamic-v1-working/runtime.tar.gz`.
  Its adjacent `manifest.json` records the SHA-256 checksum. The owner-only local
  archive includes maker/taker keys, the preserved Emulator signer, pool descriptors,
  configuration and systemd service files. It is ignored by Git and was not uploaded.
- At the milestone, the active pools held 900,000 demo USD and 400,000 sats.

The archive is a local backup, not an off-machine backup. Browser wallets and browser
activity are separate. Restoring files cannot undo transactions; preserve newer pool
descriptors and pending swap records if any are created after this snapshot.

## Fixed wrapper and witness format

The existing standard Bitcoin Taproot closure remains the server/Emulator multisig.
Its Emulator key is tweaked with the hash of the **wrapper**, rather than a particular
swap program. The wrapper itself is an Arkade script, not a new Bitcoin opcode.

```text
Emulator witness, bottom to top:
  <program arguments...> <program bytecode> <program authorization signature>

Committed Arkade wrapper:
  SWAP DUP TOALTSTACK
  SHA256 <domain> SWAP CAT SHA256
  <authority public key> CHECKSIGFROMSTACK VERIFY
  FROMALTSTACK
  EVALVERIFY
  TRUE
```

The authorization signs `SHA256(domain || SHA256(program))`. The fixed domain
hashes the `striker/signed-program/v1` tag, network, Arkade server key, Emulator key
and unique deposit lineage. Changing the program requires a new signature, but
does not change this wrapper or its output script. Different pools must use distinct
lineages; otherwise their outputs share one script/address and the current maker's
single-live-tip assumption would fail.

`contract.ts` constructs the wrapper, digest, signatures and witness. The opcode
byte `0xbd` is an experimental use of an otherwise invalid Arkade VM opcode. It
is not an assigned upstream opcode or something the currently deployed VM supports.

## Experimental EVALVERIFY semantics

`vm.patch` changes the exact pinned Emulator source
`fb1992c7d5ba2068753ca7aebffd7110674cfbd8`; `evalverify.go` supplies its handler.
Execution requires the explicit Go option `WithExperimentalEvalVerify()`. Existing
service call sites do not pass it, so merely building the patch does not enable
witness programs through the HTTP signing service.

The opcode consumes the program and all remaining data-stack arguments. It runs
one child program, requires exactly one truthy final result, consumes that result,
and returns with an empty parent data stack. The wrapper then pushes `TRUE`.

The prototype deliberately defines bounded behavior:

- Program length: 1–10,000 bytes. The program comes from the Emulator packet,
  so it can exceed the 520-byte limit for ordinary argument elements.
- At most one invocation per input. Child programs cannot contain EVALVERIFY or
  CODESEPARATOR instructions, even in unexecuted branches. Those byte values
  inside literal data pushes are permitted.
- Arguments retain the existing element, stack-count and aggregate-byte limits.
- The child has a fresh alternate/conditional stack; the parent's alternate stack
  must be empty when it calls EVALVERIFY.
- Transaction, input index, previous transactions/outputs, asset and Emulator
  packets, clock, expiry, intent message and spending Taproot leaf stay the same.
- Signature-operation counters and the request-wide compute budget remain shared.
  Calling another engine cannot reset those budgets. Ordinary CHECKSIG inside the
  child still signs the original Bitcoin spending leaf/transaction context.

## What has been tested

The TypeScript-generated `vector.json` is consumed by the real Go Arkade VM tests.
It demonstrates two signed payout programs with different amounts/recipients using
one fixed output script. Tests also cover changed code/signatures/domains, incorrect
transaction outputs, argument handling, programs larger than 520 bytes, malformed
and oversized programs, false/dirty stacks, recursion, parent-frame isolation,
shared signature/request budgets and preservation of Bitcoin signature context.

The vector additionally contains PSBTs from the existing Striker transaction builder
for both BTC → tokens and tokens → BTC. In these, the **existing maker covenant is
the witness-supplied child program**, with its normal signed quote as arguments.
The tests evaluate both maker and taker scripts and reject redirected recursive
change or a mismatched input epoch. Previous Ark transactions are synthetic fixtures:
these are offline VM tests, not submissions to arkd or test-network settlements.

```sh
# Generate the reproducible public fixtures and run the JS tests.
node --import tsx experiments/signed-programs/generate-vector.ts
npm run check
node --import tsx --test test/*.test.ts

# The Docker context is only this experiment directory; no wallet state is sent.
docker build -t striker-signed-program-tests:experimental \
  -f experiments/signed-programs/Dockerfile experiments/signed-programs
```

The default builder is Go 1.26.9. A local cached Go builder image can be supplied
with `--build-arg BUILD_IMAGE=striker-emulator-debug-build:local`.

## Authorization and remaining integration work

Signing a program authorizes **everything that program permits**, not just one
particular transaction. The wrapper does not sign its arguments. A policy that
accepts arbitrary payout arguments, or an authorized `TRUE` program, grants broad
spending power. Amounts, destinations, expiry, epoch, input binding and recursive
change must therefore be enforced by the signed program or additional fixed wrapper
checks. Domain separation prevents cross-domain authorization replay; it is not
per-trade replay protection. The existing maker program still verifies signed quote
terms and their epochs/expiry. An arbitrary program need not do so.
Signing a new program also does not revoke an older program authorization. Revocation
needs explicitly enforced state/epoch/expiry conditions or migration to a new wrapper
domain. Refilling the same wrapper can make an old authorization usable again.

This does not remove trust in the Emulator signer, and does not add unilateral exits.
The prototype is not a reviewed production execution extension.

Before enabling it for swaps, add explicit opt-in service configuration and advertised
capability checks, versioned protocol/witness encoding and transaction construction,
and full regtest settlement/adversarial tests through the HTTP signing service.
Keep existing maker/taker covenant compatibility. A later deployment would require
new deposits because the wrapper changes the Emulator key commitment and output
script. Do not migrate current liquidity merely to try this experiment.

Sources: the pinned upstream [key commitment and packet design](https://github.com/arkade-os/emulator/tree/fb1992c7d5ba2068753ca7aebffd7110674cfbd8#key-derivation)
and [CSFS semantics](https://github.com/bitcoin/bips/blob/master/bip-0348.md).
