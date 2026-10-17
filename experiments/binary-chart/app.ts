import { expiryColumns, illustrativeMultiplier, parseTrade, resolveTrade,
  STEP_MS, FEED_STALE_MS, type Tick, type PaperTrade } from './model.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('plot'), ctx = canvas.getContext('2d')!;
const chart = $('chart'), cellLayer = $('cells');
const dollars = (value: number, decimals = 2) => '$' + value.toLocaleString('en-US', {
  minimumFractionDigits: decimals, maximumFractionDigits: decimals,
});
const clock = (time: number) => new Date(time).toLocaleTimeString('en-GB', { hour12: false });
const API = 'https://data-api.binance.vision/api/v3';
let width = 1000, height = 450, band = 10, center = 0, stake = 100, balance = 10_000;
let ticks: Tick[] = [], trades: PaperTrade[] = [], id = 0, generation = 0;
let mode: 'live' | 'demo' = 'live', transport = 'stream', receivedAt = 0, lastLabel = 0;
let websocket: WebSocket | null = null, pollTimer = 0, retryTimer = 0, demoTimer = 0;
let retryCount = 0, lastPoll = 0, polling = false, demoIndex = 0, sigma = 2;
let clockOffset = 0, clockSet = false;
const marketNow = () => Date.now() + clockOffset;
let toastTimer = 0, hoverKey: string | null = null, pointerInside = false;
let plotRight = 900, nowX = 350, pixelsPerMs = 0.01, rowHeight = 48;
const cells = new Map<string, { button: HTMLButtonElement; lower: number; expiry: number; multiplier: number | null }>();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function announce(message: string) { $('announcer').textContent = message; }
function toast(message: string) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 3000);
}
function fresh() { return receivedAt > 0 && Date.now() - receivedAt < FEED_STALE_MS; }
function range(lower: number, upper: number) { return `${dollars(lower, 0)}–${dollars(upper, 0)}`; }
function latest() { return ticks.at(-1); }
function receive(tick: Tick, source: string) {
  const previous = latest();
  if (previous && tick.time < previous.time) return;
  const bucket = Math.floor(tick.time / 75);
  if (previous && Math.floor(previous.time / 75) === bucket) ticks[ticks.length - 1] = tick;
  else ticks.push(tick);
  if (ticks.length > 6000) ticks.splice(0, ticks.length - 6000);
  receivedAt = Date.now(); transport = source;
  // Anchor the moving timeline to source time, not an assumed-correct device clock.
  const offset = tick.time - receivedAt;
  clockOffset = clockSet ? Math.max(clockOffset, offset) : offset;
  clockSet = true;
  $('headline-price').textContent = dollars(tick.price);
  if (!center) center = tick.price;
  $('chart-empty').hidden = true;
}

function updateInterface(now: number) {
  const last = latest();
  const connected = fresh();
  $('headline-price').textContent = last ? dollars(last.price) : '—';
  $('feed-status').textContent = mode === 'demo' ? 'Simulated prices' :
    connected ? `Binance · ${transport === 'poll' ? '1s polling' : 'live stream'}` :
    receivedAt ? 'Feed paused · reconnecting' : 'Connecting to Binance';
  $('feed-dot').className = 'feed-dot ' + (connected ? 'live' : 'stale');
  $('feed-age').textContent = receivedAt && !connected ? `${Math.floor((Date.now() - receivedAt) / 1000)}s` : '';
  $('demo-mode').classList.toggle('active', mode === 'demo');
  $('live-mode').classList.toggle('active', mode === 'live');
  document.querySelector('.odds-note strong')!.textContent = mode === 'demo'
    ? 'Simulated price. Imaginary money.' : 'Real price. Imaginary money.';
  if (!ticks.length && mode === 'live' && Date.now() - startedAt > 7000) {
    $('chart-empty').querySelector('strong')!.textContent = 'Live feed isn’t reaching this browser.';
    $('chart-empty').querySelector('p')!.textContent = 'You can still explore with the simulated feed.';
  }
  for (let i = 0; i < trades.length; i++) {
    const old = trades[i]!, resolved = resolveTrade(old, ticks, now);
    if (old.status === 'open' && resolved.status !== 'open') {
      trades[i] = resolved;
      if (resolved.status === 'won') balance += resolved.payoutCents;
      if (resolved.status === 'void') balance += resolved.stakeCents;
      const result = resolved.status === 'won' ? `Won · ${dollars(resolved.payoutCents / 100)} returned` :
        resolved.status === 'void' ? 'Missing expiry price · paper stake returned' : 'Outside your range · paper trade lost';
      toast(result); announce(result);
    }
  }
  const open = trades.filter(t => t.status === 'open');
  $('balance').textContent = dollars(balance / 100);
  const pnl = balance + open.reduce((sum, t) => sum + t.stakeCents, 0) - 10_000;
  $('session-pnl').textContent = trades.length ? `${pnl >= 0 ? '+' : '−'}${dollars(Math.abs(pnl) / 100)} session` : 'A fresh canvas.';
  $('open-count').textContent = `${open.length} OPEN`;
  const positions = $('positions');
  if (trades.length) {
    positions.replaceChildren(...trades.slice(-12).reverse().map(trade => {
      const item = document.createElement('article'); item.className = `position ${trade.status}`;
      const remaining = Math.max(0, Math.ceil((trade.expiry - now) / 1000));
      const outcome = trade.status === 'open' ? (remaining ? `${remaining}s` : 'Checking…') :
        trade.status === 'won' ? `WON ${dollars(trade.payoutCents / 100)}` : trade.status === 'void' ? 'VOID · REFUNDED' : 'MISSED';
      item.innerHTML = `<strong>${range(trade.lower, trade.upper)}</strong><strong class="trade-result">${outcome}</strong><span>${clock(trade.expiry)} · ${dollars(trade.stakeCents / 100)} stake</span><span>${trade.multiplier.toFixed(2)}× locked</span>`;
      return item;
    }));
  } else if (!positions.querySelector('.position-empty')) {
    positions.innerHTML = '<p class="position-empty">Your first prediction starts with a cell. Hover or focus to explore, tap to lock it in.</p>';
  }
  // Estimate one-second variability from observed data only; floor keeps the visual grid usable.
  if (ticks.length > 15 && last) {
    const closes = new Map<number, number>();
    for (const tick of ticks.slice(-600)) closes.set(Math.floor(tick.time / 1000), tick.price);
    const values = [...closes.values()];
    const variance = values.slice(1).reduce((sum, price, i) => sum + (price - values[i]!) ** 2, 0) / Math.max(1, values.length - 1);
    sigma = Math.max(last.price * 0.000025, Math.min(last.price * 0.0003, Math.sqrt(variance)));
  }
}

function showTooltip(key: string) {
  const cell = cells.get(key); if (!cell) return;
  hoverKey = key;
  const existing = trades.find(t => t.lower === cell.lower && t.upper === cell.lower + band && t.expiry === cell.expiry);
  const multiplier = existing?.multiplier ?? cell.multiplier;
  const tooltip = $('trade-tooltip');
  tooltip.hidden = false;
  tooltip.innerHTML = `<b>${range(cell.lower, cell.lower + band)}</b> at ${clock(cell.expiry)}<br>` +
    (existing ? `Locked · ${dollars(existing.stakeCents / 100)} stake · ${existing.multiplier.toFixed(2)}×` :
      multiplier ? `Pay ${dollars(stake / 100)} · return <b>${dollars(Math.floor(stake * multiplier) / 100)}</b> if correct<br>Max loss ${dollars(stake / 100)} · illustrative payout` : 'No illustrative quote for this cell');
}
function place(key: string) {
  const cell = cells.get(key), now = marketNow();
  if (!cell || cell.multiplier === null) return;
  if (!fresh()) { toast('Price feed paused. Wait for live data or choose simulated feed.'); return; }
  if (cell.expiry - now < 2000) { toast('That expiry is too close. Pick a later column.'); return; }
  if (balance < stake) { toast('Not enough paper balance. Reset the session to start fresh.'); return; }
  if (trades.filter(t => t.status === 'open').length >= 8) { toast('Eight moments at once. Let one finish first.'); return; }
  if (trades.some(t => t.lower === cell.lower && t.upper === cell.lower + band && t.expiry === cell.expiry)) return;
  const trade: PaperTrade = { id: ++id, lower: cell.lower, upper: cell.lower + band, expiry: cell.expiry,
    placedAt: now, stakeCents: stake, multiplier: cell.multiplier,
    payoutCents: Math.floor(stake * cell.multiplier), status: 'open' };
  trades.push(trade); balance -= stake;
  announce(`Paper trade locked: ${range(trade.lower, trade.upper)} at ${clock(trade.expiry)}. ${dollars(trade.stakeCents / 100)} stake.`);
  showTooltip(key); updateInterface(now);
}

function updateCells(now: number, price: number, labels: boolean) {
  const active = new Set<string>();
  const horizon = width < 700 ? 30_000 : 60_000;
  const centerRow = Math.floor(center / band);
  for (const expiry of expiryColumns(now, horizon)) {
    const left = nowX + (expiry - STEP_MS - now) * pixelsPerMs;
    const right = nowX + (expiry - now) * pixelsPerMs;
    if (right < nowX + 10 || left > plotRight - 8) continue;
    for (let row = centerRow - 6; row <= centerRow + 6; row++) {
      const lower = row * band, top = y(lower + band) + 3;
      if (top < 25 || top + rowHeight > height - 48) continue;
      const key = `${lower}:${band}:${expiry}`; active.add(key);
      let cell = cells.get(key);
      if (!cell) {
        const button = document.createElement('button'); button.className = 'cell';
        button.addEventListener('click', () => place(key));
        button.addEventListener('mouseenter', () => showTooltip(key));
        button.addEventListener('focus', () => showTooltip(key));
        button.addEventListener('mouseleave', () => { if (document.activeElement !== button) { hoverKey = null; $('trade-tooltip').hidden = true; } });
        button.addEventListener('blur', () => { hoverKey = null; $('trade-tooltip').hidden = true; });
        cell = { button, lower, expiry, multiplier: null }; cells.set(key, cell); cellLayer.append(button);
      }
      const x = Math.max(nowX + 8, left + 3), w = Math.max(0, right - 3 - x);
      cell.button.style.transform = `translate(${x}px,${top}px)`;
      cell.button.style.width = `${w}px`; cell.button.style.height = `${rowHeight - 6}px`;
      const existing = trades.find(t => t.lower === lower && t.upper === lower + band && t.expiry === expiry);
      if (labels || !cell.button.textContent) {
        cell.multiplier = illustrativeMultiplier(price, lower, lower + band, (expiry - now) / 1000, sigma);
        const waiting = expiry - now < 2000;
        cell.button.className = `cell${existing ? ' selected' : !fresh() || waiting ? ' waiting' : cell.multiplier === null ? ' unavailable' : ''}`;
        cell.button.innerHTML = existing ? `<span class="cell-stake">${dollars(existing.stakeCents / 100, existing.stakeCents % 100 ? 2 : 0)}</span><span>${existing.multiplier.toFixed(2)}×</span>` :
          cell.multiplier === null ? '<span>·</span>' : `<span>${cell.multiplier.toFixed(2)}×</span>`;
        cell.button.disabled = Boolean(existing) || waiting || !fresh() || cell.multiplier === null || w < 20;
        cell.button.setAttribute('aria-label', `${range(lower, lower + band)} at ${clock(expiry)}. ${existing ? 'Paper trade locked' : `${cell.multiplier?.toFixed(2) ?? 'No'} times total payout, ${dollars(stake / 100)} paper stake`}`);
      }
    }
  }
  for (const [key, cell] of cells) if (!active.has(key)) { cell.button.remove(); cells.delete(key); if (hoverKey === key) { hoverKey = null; $('trade-tooltip').hidden = true; } }
}

function y(price: number) { return height * 0.49 - (price - center) / band * rowHeight; }
function x(time: number, now: number) { return nowX + (time - now) * pixelsPerMs; }
let previousFrame = performance.now();
function frame(timestamp: number) {
  const now = marketNow(), dt = Math.min(100, timestamp - previousFrame); previousFrame = timestamp;
  const last = latest();
  ctx.clearRect(0, 0, width, height);
  if (last) {
    const target = last.price;
    // Keep price bins fixed in value. Only the viewport follows; selected terms never change.
    if (!pointerInside && !cellLayer.contains(document.activeElement)) center += (target - center) * (reducedMotion ? 1 : Math.min(1, dt / 1500));
    const compact = width < 700;
    plotRight = width - (compact ? 67 : 80);
    nowX = plotRight * (compact ? 0.28 : 0.39);
    pixelsPerMs = (plotRight - nowX) / (compact ? 30_000 : 60_000);
    rowHeight = Math.max(43, Math.min(55, (height - 75) / 7));
    $('now-label').style.left = `${nowX}px`;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 24, plotRight, height - 64); ctx.clip();
    const startRow = Math.floor(center / band) - 7;
    ctx.lineWidth = 1;
    for (let row = startRow; row < startRow + 16; row++) {
      const cy = y(row * band);
      ctx.strokeStyle = '#29382666'; ctx.setLineDash([2, 6]); ctx.beginPath();ctx.moveTo(0, cy);ctx.lineTo(plotRight, cy);ctx.stroke();
    }
    ctx.setLineDash([]);
    for (let time = Math.floor((now - nowX / pixelsPerMs) / STEP_MS) * STEP_MS; x(time, now) < plotRight; time += STEP_MS) {
      const cx = x(time, now); ctx.strokeStyle = time > now ? '#36432d45' : '#29352640'; ctx.beginPath();ctx.moveTo(cx,24);ctx.lineTo(cx,height - 39);ctx.stroke();
    }
    ctx.fillStyle = '#94bc5710'; ctx.fillRect(nowX, 24, plotRight - nowX, height - 64);
    for (const trade of trades) {
      if (trade.status !== 'open' || trade.upper - trade.lower === band) continue;
      const left = Math.max(nowX + 8, x(trade.expiry - STEP_MS, now) + 3);
      const right = x(trade.expiry, now) - 3;
      if (right <= left) continue;
      ctx.fillStyle = '#c7f36a35'; ctx.strokeStyle = '#c7f36a';
      ctx.fillRect(left, y(trade.upper) + 3, right - left, y(trade.lower) - y(trade.upper) - 6);
      ctx.strokeRect(left, y(trade.upper) + 3, right - left, y(trade.lower) - y(trade.upper) - 6);
    }
    const visible = ticks.filter(t => x(t.time, now) > -10 && t.time <= now);
    if (visible.length) {
      const gradient = ctx.createLinearGradient(0, 0, 0, height); gradient.addColorStop(0, '#c7f36a20');gradient.addColorStop(1,'#c7f36a00');
      ctx.beginPath(); visible.forEach((tick, i) => i ? ctx.lineTo(x(tick.time,now),y(tick.price)) : ctx.moveTo(x(tick.time,now),y(tick.price)));
      const head = visible.at(-1)!;
      const hx = Math.min(nowX, x(head.time, now)), hy = y(head.price);
      ctx.lineTo(hx,height - 40);ctx.lineTo(x(visible[0]!.time,now),height - 40);ctx.closePath();ctx.fillStyle=gradient;ctx.fill();
      ctx.beginPath();visible.forEach((tick,i)=>i?ctx.lineTo(x(tick.time,now),y(tick.price)):ctx.moveTo(x(tick.time,now),y(tick.price)));
      ctx.strokeStyle=fresh()?'#c7f36a':'#7f8c78';ctx.lineWidth=2;ctx.lineJoin='round';ctx.lineCap='round';ctx.shadowColor='#c7f36a44';ctx.shadowBlur=8;ctx.stroke();ctx.shadowBlur=0;
      ctx.fillStyle='#c7f36a12';ctx.beginPath();ctx.arc(hx,hy,11,0,Math.PI*2);ctx.fill();ctx.fillStyle=fresh()?'#e6ffc2':'#8c9985';ctx.beginPath();ctx.arc(hx,hy,3.5,0,Math.PI*2);ctx.fill();
    }
    ctx.strokeStyle='#8faa6577';ctx.setLineDash([2,5]);ctx.beginPath();ctx.moveTo(nowX,26);ctx.lineTo(nowX,height-40);ctx.stroke();ctx.setLineDash([]);
    ctx.restore();
    ctx.font='10px "DM Sans",system-ui';ctx.fillStyle='#819477';ctx.textAlign='left';
    for(let row=startRow;row<startRow+16;row++){const cy=y(row*band);if(cy>30&&cy<height-46)ctx.fillText(dollars(row*band,0),plotRight+10,cy+3);}
    const py = Math.max(36, Math.min(height-58,y(last.price)));
    ctx.fillStyle='#c7f36a';ctx.beginPath();ctx.roundRect(plotRight+3,py-12,width-plotRight-3,24,5);ctx.fill();ctx.fillStyle='#1d2b15';ctx.font='600 10px "DM Sans",system-ui';ctx.fillText(last.price.toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1}),plotRight+8,py+3);
    ctx.fillStyle='#6c805f';ctx.font='9px "DM Sans",system-ui';ctx.textAlign='center';
    for (const time of expiryColumns(now, compact?30_000:60_000)){const cx=x(time,now);if(cx<plotRight-12&&cx>nowX+18){ctx.fillText(`+${Math.ceil((time-now)/1000)}s`,cx,height-25);}}
    ctx.textAlign='left';ctx.fillStyle='#506348';ctx.fillText(clock(now),5,height-25);
    const labels = timestamp-lastLabel>220;
    updateCells(now,last.price,labels);
    if(labels){lastLabel=timestamp;updateInterface(now);if(hoverKey)showTooltip(hoverKey);}
  }
  requestAnimationFrame(frame);
}

function resize(){const rect=chart.getBoundingClientRect();width=rect.width;height=rect.height;const dpr=Math.min(2,devicePixelRatio||1);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);}
new ResizeObserver(resize).observe(chart);
chart.addEventListener('pointerenter',()=>{pointerInside=true;});chart.addEventListener('pointerleave',()=>{pointerInside=false;hoverKey=null;$('trade-tooltip').hidden=true;});

async function poll(version: number) {
  if (polling || version !== generation || mode !== 'live') return;
  if (transport==='stream'&&fresh())return;
  polling=true;
  try{const response=await fetch(`${API}/aggTrades?symbol=BTCUSDT&limit=1`,{signal:AbortSignal.timeout(4500),cache:'no-store'});if(!response.ok)throw Error('Price request failed');const raw=await response.json();const tick=parseTrade(Array.isArray(raw)?raw[0]:null,marketNow());if(version===generation&&tick)receive(tick,'poll');}
  catch{/* Keep the last real price and show stale state; never manufacture live ticks. */}
  finally{polling=false;lastPoll=Date.now();}
}
function connect(version: number) {
  if(version!==generation||mode!=='live')return;
  websocket=new WebSocket('wss://data-stream.binance.vision/ws/btcusdt@aggTrade');
  const ws=websocket;
  ws.onmessage=event=>{if(version!==generation)return;try{const tick=parseTrade(JSON.parse(String(event.data)),marketNow());if(tick){retryCount=0;receive(tick,'stream');}}catch{/* Ignore malformed events. */}};
  ws.onerror=()=>ws.close();
  ws.onclose=()=>{if(version!==generation||mode!=='live')return;retryTimer=window.setTimeout(()=>connect(version),Math.min(15_000,1000*2**Math.min(4,retryCount++)));};
}
let startedAt=Date.now();
async function startLive(version: number){
  connect(version);
  pollTimer=window.setInterval(()=>{if(Date.now()-lastPoll>900)void poll(version);},1000);
  void poll(version);
  try{const response=await fetch(`${API}/klines?symbol=BTCUSDT&interval=1s&limit=180`,{signal:AbortSignal.timeout(6000)});if(!response.ok)return;const raw=await response.json();if(version!==generation||!Array.isArray(raw))return;const history:Tick[]=raw.flatMap((v:unknown)=>{if(!Array.isArray(v))return[];const time=Number(v[6]),price=Number(v[4]);return Number.isFinite(time)&&time<=Date.now()&&Number.isFinite(price)&&price>0?[{time,price}]:[];});const firstLive=ticks[0]?.time??Infinity;ticks=[...history.filter(t=>t.time<firstLive),...ticks].sort((a,b)=>a.time-b.time);if(ticks.length&&!center)center=ticks.at(-1)!.price;if(ticks.length)$('chart-empty').hidden=true;}
  catch{/* The stream can operate without historical backfill. */}
}
function demoPrice(step:number){return 82_420+16*Math.sin(step*.017)+7*Math.sin(step*.061)+3*Math.sin(step*.143)+1.8*Math.sin(step*.43);}
function switchMode(next:'live'|'demo'){
  generation++;mode=next;startedAt=Date.now();
  clearInterval(pollTimer);clearTimeout(retryTimer);clearInterval(demoTimer);websocket?.close();websocket=null;
  ticks=[];trades=[];balance=10_000;center=0;receivedAt=0;retryCount=0;lastPoll=0;transport='none';polling=false;hoverKey=null;clockOffset=0;clockSet=false;$('trade-tooltip').hidden=true;
  for(const cell of cells.values())cell.button.remove();cells.clear();
  $('chart-empty').hidden=false;$('chart-empty').querySelector('strong')!.textContent='Finding the pulse…';$('chart-empty').querySelector('p')!.textContent='Connecting to public BTC/USDT prices.';
  if(next==='demo'){
    demoIndex=900;const now=Date.now();for(let i=0;i<=900;i++)ticks.push({time:now-(900-i)*100,price:demoPrice(i)});
    receive(ticks.at(-1)!,'demo');
    demoTimer=window.setInterval(()=>receive({time:Date.now(),price:demoPrice(++demoIndex)},'demo'),100);
  }else void startLive(generation);
  updateInterface(marketNow());
}
document.querySelectorAll<HTMLButtonElement>('[data-band]').forEach(button=>button.addEventListener('click',()=>{band=Number(button.dataset.band);document.querySelectorAll('[data-band]').forEach(b=>b.classList.toggle('active',b===button));hoverKey=null;$('trade-tooltip').hidden=true;}));
document.querySelectorAll<HTMLButtonElement>('[data-stake]').forEach(button=>button.addEventListener('click',()=>{stake=Number(button.dataset.stake);document.querySelectorAll('[data-stake]').forEach(b=>b.classList.toggle('active',b===button));announce(`${dollars(stake/100)} per paper trade`);}));
$('demo-mode').addEventListener('click',()=>{if(mode!=='demo'){switchMode('demo');toast('New paper session · simulated prices');}});
$('live-mode').addEventListener('click',()=>{if(mode!=='live'){switchMode('live');toast('New paper session · connecting to Binance');}});
$('empty-demo').addEventListener('click',()=>switchMode('demo'));
$('reset').addEventListener('click',()=>{trades=[];balance=10_000;updateInterface(marketNow());toast('Paper balance reset to $100');});
window.addEventListener('pagehide',()=>{generation++;websocket?.close();clearInterval(pollTimer);clearInterval(demoTimer);clearTimeout(retryTimer);});
window.setInterval(()=>updateInterface(marketNow()),1000);
switchMode(new URLSearchParams(location.search).get('feed')==='demo'?'demo':'live');resize();requestAnimationFrame(frame);
