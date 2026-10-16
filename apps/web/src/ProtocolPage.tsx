import type { ReactNode } from "react";
import "./protocol.css";

const source = "https://github.com/bonomat/striker/blob/3b29f6e63a8051a1550a5c711be3990d05be0e57/";
function Code({ title, file, children }: { title: string; file: string; children: string }) {
  return <div className="protocol-code">
    <div className="protocol-code-heading"><span>{title}</span><span>PSEUDOCODE</span></div>
    <pre tabIndex={0} aria-label={title}><code>{children}</code></pre>
    <a href={`${source}${file}`} target="_blank" rel="noopener noreferrer">Read the TypeScript implementation ↗</a>
  </div>;
}
function Section({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return <section className="protocol-section" aria-labelledby={`protocol-${number}`}>
    <span className="protocol-number">{number}</span>
    <div><h2 id={`protocol-${number}`}>{title}</h2>{children}</div>
  </section>;
}
export function ProtocolPage() {
  return <article className="protocol-page">
    <header className="protocol-hero">
      <span className="tiny-label">THE STRIKER PROTOCOL · INTENT V1</span>
      <h1>Sign the terms.<br /><em>Settle together.</em></h1>
      <p>A maker signs a price. Your wallet signs an authorization. Striker brings them together in one atomic transaction on Arkade.</p>
      <div className="protocol-tags"><span>BTC ↔ Arkade tokens</span><span>Reusable covenants</span><span>Mutinynet PoC</span></div>
    </header>

    <Section number="01" title="Funds arrive ready to swap.">
      <p>Your receive address is a reusable taker covenant. Deposits already carry the spending rules needed for a swap, so accepting a quote does not create another funding transaction. Swap receipts and change return to that same address.</p>
      <p>Makers also deposit liquidity into recursive covenants, with separate pools for each direction. Their remaining liquidity returns to the same covenant after every fill.</p>
      <div className="protocol-callout">A deposit is an earlier wallet transaction. Once funds are in the covenant, each swap creates one settlement transaction.</div>
    </Section>

    <Section number="02" title="Two client requests. One settlement.">
      <ol className="protocol-flow">
        <li><span>01 / REQUEST</span><h3>Wallet → Striker → Maker</h3><p>The wallet requests a price. Striker obtains a signed maker offer and returns it for the wallet to verify.</p><code>POST /v2/quotes</code></li>
        <li><span>02 / AUTHORIZE</span><h3>Wallet → Striker</h3><p>The wallet selects existing coins and signs the accepted terms. It sends the authorization, never the private key.</p><code>POST /v2/swaps</code></li>
        <li><span>03 / SETTLE</span><h3>Striker → Arkade</h3><p>Striker finds the live maker coin, builds the transaction, and submits it through the Emulator and arkd.</p><code>Both sides paid atomically</code></li>
      </ol>
      <p>Maker and taker never communicate directly. Quotes, execution requests and status go through Striker. The maker can go offline after signing its quote.</p>
    </Section>

    <Section number="03" title="The maker covenant protects the pool.">
      <p>The quote commits to the market, direction, deposit lineage, payout destination, amounts, epoch and deadline. It does not bind the offer to one transaction ID. Striker can follow a newer coin in the same valid liquidity lineage while the quote remains valid and sufficient liquidity remains.</p>
      <Code title="Maker · signed price + recursive liquidity" file="packages/protocol/src/covenant.ts">{`require verify(makerKey, sha256(quoteBytes), signature)
require quote matches this pool's fixed terms
require quote.amounts > 0 && now < quote.deadline
require input.epoch == quote.epoch == transaction.epoch

if direction == BTC_TO_TOKEN:
    require output[0].tokens == quote.makerGives
    require output[1].tokens == input.tokens - quote.makerGives
    require output[1].sats == input.sats
    require output[1].tokens > 0
    require output[2].sats == quote.takerPays
else:
    require output[0].sats == quote.makerGives
    require output[1].sats == input.sats - quote.makerGives
    require output[1].sats >= 330
    require output[2].tokens >= quote.takerPays

require output[1].script == input.script  // same pool
require output[2].script == makerPayout`}</Code>
      <p>The taker covenant separately enforces the destination of output 0. The maker signature authorizes these rules; it is not a presigned settlement transaction.</p>
    </Section>

    <Section number="04" title="The taker signs an intent, not a transaction.">
      <p>The authorization binds the accepted maker script and quote witness, market, direction, minimum receipt, expiry, and the exact taker coins and contributions. A domain binds it to the network, arkd key and Emulator key. The maker’s live coin can change; the taker’s authorized coins cannot.</p>
      <Code title="Taker · one signature for the whole input batch" file="packages/protocol/src/intent.ts">{`records = [(checkpointOutpoint, paySats, payTokens), ...]
message = encode(
    domain, makerScriptHash, makerQuoteWitnessHash,
    assetId, direction, minimumReceive, deadline,
    sha256(records), records.length
)
signature = schnorr.sign(sha256(message), ownerKey)

// Every taker input checks the same batch authorization.
require verify(ownerKey, sha256(message), signature)
require now < deadline && 1 <= records.length <= 4
require sha256(records) == message.inputsHash
require inputCount == records.length + 1  // maker + taker
require allTakerInputsHaveIdenticalWitness()
require input[0].scriptHash == makerScriptHash
require input[0].witnessHash == makerQuoteWitnessHash

for each taker input i:
    require input[i].outpoint == records[i - 1].outpoint
    require records[i - 1].contributions >= 0
    change = output[i + 2]
    require change.script == input[i].script
    require change.sats == input[i].sats - records[i - 1].paySats
    require change.marketTokens == input[i].marketTokens
                                   - records[i - 1].payTokens
    require otherAssetsPreserved(input[i], change)

require output[0].script == takerCovenantScript
require output[0].sats >= 330
require output[0].receivedAsset >= minimumReceive`}</Code>
      <p>These examples simplify the VM checks for readability. The executable implementation uses fixed-width encoding, Schnorr signatures, transaction introspection and <code>OP_TUNNEL</code> to preserve change and unrelated assets. Identical batch witnesses prevent combining parts of separate authorizations.</p>
    </Section>

    <Section number="05" title="What actually goes into the transaction?">
      <p>For a BTC → POC swap of 500 sats for 100 POC, suppose your input already holds 27,840 sats and 300 POC. The current layout produces:</p>
      <div className="protocol-table-wrap"><table>
        <thead><tr><th>Output</th><th>Purpose</th><th>Receives</th></tr></thead>
        <tbody>
          <tr><td>0</td><td>Your swap receipt</td><td>330 sats + 100 POC</td></tr>
          <tr><td>1</td><td>Remaining maker liquidity</td><td>Same maker covenant</td></tr>
          <tr><td>2</td><td>Maker payment</td><td>500 sats</td></tr>
          <tr><td>3</td><td>Your change</td><td>27,010 sats + 300 POC</td></tr>
          <tr><td>4 + 5</td><td>Protocol packet + anchor</td><td>Asset allocations, covenant witnesses and metadata; anchor</td></tr>
        </tbody>
      </table></div>
      <p>You finish with 27,340 sats and 400 POC: a net exchange of 500 sats for 100 POC. Outputs 0 and 3 share your wallet address but stay separate under the current covenant rules. With multiple taker inputs, each gets its own change output.</p>
      <a className="protocol-source-link" href={`${source}packages/protocol/src/intent-settlement.ts`} target="_blank" rel="noopener noreferrer">Inspect the transaction builder ↗</a>
    </Section>

    <Section number="06" title="Who enforces the rules?">
      <p>In this PoC, the Emulator evaluates the covenant program and signs only after validation. Arkd also co-signs and settles the Arkade transaction. These covenant rules depend on the configured Emulator and arkd; they are not Bitcoin consensus opcodes.</p>
      <Code title="Spending tree · swap or cooperative owner recovery" file="packages/protocol/src/covenant.ts">{`swapLeaf = multisig(
    arkdKey,
    emulatorKeyTweakedWith(covenantScript)
)
ownerLeaf = multisig(ownerKey, arkdKey)

// The owner path does not need Striker or the Emulator.
// It still requires arkd cooperation.
withdrawOrCancel = owner.sign(selfSpendOrWithdrawal)`}</Code>
      <p>Cancellation spends the authorized coins to fresh wallet outputs, invalidating their old outpoints. Expiry alone is not a replacement for cancellation if a transaction has already been co-signed.</p>
    </Section>

    <aside className="protocol-limits" aria-labelledby="protocol-limits-title">
      <span className="tiny-label">CURRENT IMPLEMENTATION</span>
      <h2 id="protocol-limits-title">An experiment you can inspect.</h2>
      <p>This runs on Mutinynet with the demo token POC, priced statically at 5 sats per atomic unit. POC is not USDt. Each swap uses one maker and up to four taker inputs. Striker orders are held in memory; durable execution recovery, automatic rebalancing and unilateral exits remain future work.</p>
      <div><a href="https://github.com/bonomat/striker" target="_blank" rel="noopener noreferrer">Explore the repository ↗</a><a href="#/">Back to swapping →</a></div>
    </aside>
  </article>;
}
