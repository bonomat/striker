import arkadeIcon from "./assets/arkade-icon.svg";
import { useEffect, useRef, useState } from "react";
import "./how-it-works.css";

const stages = [
  {
    label: "Request",
    title: "Your wallet makes the first move.",
    text: "Choose what to send and what to receive. Your wallet asks Striker for a quote, without contacting a maker directly.",
  },
  {
    label: "Quote",
    title: "Signed offers. Verified in your wallet.",
    text: "Makers sign prices against liquidity they have already deposited. Striker selects one offer, and your wallet checks its signature and terms.",
  },
  {
    label: "Fund",
    title: "Your payment stays on Arkade.",
    text: "After you confirm, your wallet funds an offer on Arkade. Its spending conditions bind the swap to the payment you agreed to receive.",
  },
  {
    label: "Settle",
    title: "Both payments. One transaction.",
    text: "Striker builds and submits the swap on Arkade. Both sides get paid atomically, and unused maker liquidity returns to the same covenant.",
  },
];

function NodeIcon({ kind }: { kind: "wallet" | "maker" | "striker" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "wallet" ? <>
        <path d="M20 8V6a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v9H5a3 3 0 0 1-3-3V7" />
        <path d="M20 12h-5v4h5m-3-2h.01" />
      </> : kind === "maker" ? <>
        <ellipse cx="12" cy="6" rx="7" ry="3" />
        <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
      </> : <path d="M14.7 2 4 14h7l-1.7 8L21 9h-7.5z" fill="currentColor" stroke="none" />}
    </svg>
  );
}

function FlowRoutes({ stage, mobile = false }: { stage: number; mobile?: boolean }) {
  const routes = [
    {
      id: "request", active: stage === 0 || stage === 1 || stage === 3,
      reverse: stage === 1,
      path: mobile ? "M460 79 H540" : "M250 172 H390",
    },
    {
      id: "maker-a", active: stage === 1, reverse: true,
      path: mobile
        ? "M540 79 H520 Q500 79 500 99 V168 Q500 188 480 188 H270 Q250 188 250 208 V234"
        : "M610 172 H650 Q680 172 680 142 V116 Q680 86 710 86 H750",
    },
    {
      id: "maker-b", active: stage === 1, reverse: true,
      path: mobile ? "M750 145 V234"
        : "M610 172 H650 Q680 172 680 202 V228 Q680 258 710 258 H750",
    },
    {
      id: "fund", active: stage === 2, reverse: false,
      path: mobile ? "M40 79 H20 V498 Q20 528 50 528 H175"
        : "M140 228 V335 Q140 365 170 365 H360",
    },
    {
      id: "settle", active: stage === 3, reverse: false,
      path: mobile ? "M960 79 H980 V498 Q980 528 950 528 H825"
        : "M500 238 V325",
    },
  ];
  return (
    <svg className={`flow-routes ${mobile ? "flow-routes-mobile" : "flow-routes-desktop"}`}
      viewBox={mobile ? "0 0 1000 660" : "0 0 1000 430"}
      preserveAspectRatio="none" aria-hidden="true">
      {routes.map((route) => (
        <g key={route.id} className={`flow-route flow-route-${route.id} ${route.active ? "is-active" : ""} ${route.reverse ? "is-returning" : ""}`}>
          <path className="flow-track" d={route.path} />
          <path className="flow-glow" pathLength="100" d={route.path} />
          <path className="flow-beam" pathLength="100" d={route.path} />
        </g>
      ))}
    </svg>
  );
}

export function HowItWorks({ assetSymbol, bitcoinToToken }: {
  assetSymbol: string;
  bitcoinToToken: boolean;
}) {
  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(() =>
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [visible, setVisible] = useState(false);
  const section = useRef<HTMLElement>(null);
  const send = bitcoinToToken ? "BTC" : assetSymbol;
  const receive = bitcoinToToken ? assetSymbol : "BTC";

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { threshold: 0.15 });
    if (section.current) observer.observe(section.current);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => { if (preference.matches) setPlaying(false); };
    preference.addEventListener("change", changed);
    return () => { observer.disconnect(); preference.removeEventListener("change", changed); };
  }, []);

  useEffect(() => {
    if (!playing || !visible) return;
    const interval = setInterval(() => setStage((current) => (current + 1) % stages.length), 4600);
    return () => clearInterval(interval);
  }, [playing, visible]);

  return (
    <section className="swap-story" ref={section} aria-labelledby="swap-story-title">
      <div className="story-heading">
        <span className="tiny-label">BEHIND THE SWAP</span>
        <h2 id="swap-story-title">A few messages. One atomic swap.</h2>
        <p>Striker finds signed maker liquidity. Both sides settle together on Arkade.</p>
      </div>

      <div className={`flow-card ${playing && visible ? "flow-playing" : "flow-paused"}`} data-stage={stage}>
        <div className="flow-toolbar">
          <span className="flow-illustration"><span /> FLOW ILLUSTRATION</span>
          <button className="flow-play" onClick={() => setPlaying((current) => !current)}
            aria-label={playing ? "Pause swap diagram" : "Play swap diagram"} aria-pressed={playing}>
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              {playing ? <path d="M4 3h3v10H4zm5 0h3v10H9z" /> : <path d="m5 3 8 5-8 5z" />}
            </svg>
            {playing ? "Pause" : "Play"}
          </button>
        </div>

        <figure className="flow-diagram" aria-label="A taker requests quotes through Striker. Makers reply through Striker. Funding and atomic settlement take place on Arkade.">
          <FlowRoutes stage={stage} />
          <FlowRoutes stage={stage} mobile />

          <div className={`flow-node flow-taker ${stage === 0 || stage === 2 ? "node-active" : ""}`}>
            <span className="flow-node-id">taker_0 <i /></span>
            <div className="flow-node-name"><NodeIcon kind="wallet" /><strong>Your wallet</strong></div>
            <p>{send} <span>→</span> {receive}</p>
          </div>

          <div className="flow-node flow-striker node-active">
            <span className="flow-node-id">THE COORDINATOR</span>
            <div className="flow-node-name"><NodeIcon kind="striker" /><strong>striker.</strong></div>
            <p>{["Routing your request", "Selecting a signed offer", "Awaiting your funding", "Building the swap"][stage]}</p>
          </div>

          <div className={`flow-node flow-maker-a ${stage === 1 ? "node-active" : ""} ${stage > 0 ? "node-selected" : ""}`}>
            <span className="flow-node-id">maker_0 <span className="flow-maker-badge">{stage > 0 ? "SELECTED" : "READY"}</span></span>
            <div className="flow-node-name"><NodeIcon kind="maker" /><strong>Liquidity maker</strong></div>
            <p>{receive} liquidity committed</p>
          </div>

          <div className={`flow-node flow-maker-b ${stage === 1 ? "node-active" : ""}`}>
            <span className="flow-node-id">maker_1 <i /></span>
            <div className="flow-node-name"><NodeIcon kind="maker" /><strong>Liquidity maker</strong></div>
            <p>{stage === 1 ? "Another signed offer" : "Standing by"}</p>
          </div>

          <div className={`flow-node flow-arkade ${stage === 2 || stage === 3 ? "node-active" : ""}`}>
            <img className="flow-arkade-mark" src={arkadeIcon} alt="" aria-hidden="true" />
            <div><strong>Arkade</strong><p>{stage === 3 ? "Both sides settle together" : "Where the assets move"}</p></div>
            <span className="flow-asset-pair"><b>{send}</b><span>⇄</span><b>{receive}</b></span>
          </div>

          <span className="flow-wire-label flow-quote-label">{stage === 1 ? "SIGNED QUOTE" : "REQUEST"}</span>
          <span className={`flow-wire-label flow-fund-label ${stage === 2 ? "label-active" : ""}`}>FUND ON ARKADE</span>
          <span className={`flow-wire-label flow-settle-label ${stage === 3 ? "label-active" : ""}`}>BUILD & SUBMIT</span>
        </figure>

        <div className="flow-stages" aria-label="Explore the swap steps">
          {stages.map((item, index) => (
            <button key={item.label} className={index === stage ? "is-current" : ""}
              aria-current={index === stage ? "step" : undefined}
              onClick={() => { setStage(index); setPlaying(false); }}>
              <span className="flow-step-number">0{index + 1}</span>
              <span>{item.label}</span><span className="flow-step-progress" key={`${index}-${stage}-${playing}`} />
            </button>
          ))}
        </div>
        <div className="flow-explanation" aria-live="off">
          <span className="flow-explanation-number">0{stage + 1}</span>
          <div><h3>{stages[stage]!.title}</h3><p>{stages[stage]!.text}</p></div>
        </div>
      </div>

      <div className="story-footnotes">
        <span><i /> Your keys stay in your wallet</span>
        <span><i /> One maker fills each swap</span>
        <span><i /> Makers can go offline after quoting</span>
      </div>
    </section>
  );
}
