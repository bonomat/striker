import { useState } from "react";

const PRESETS = [10, 50, 100];

/** Max slippage in basis points: presets plus a custom percentage up to 5%. */
export function SlippagePicker({ value, onChange, disabled }: { value: number; onChange: (bps: number) => void; disabled?: boolean }) {
  const [custom, setCustom] = useState(PRESETS.includes(value) ? "" : String(value / 100));
  return (
    <span className="slippage-picker" role="group" aria-label="Maximum slippage">
      {PRESETS.map(bps => (
        <button key={bps} type="button" aria-pressed={value === bps && !custom} disabled={disabled}
          onClick={() => { setCustom(""); onChange(bps); }}>{bps / 100}%</button>
      ))}
      <input aria-label="Custom slippage percent" inputMode="decimal" placeholder="Custom" value={custom} disabled={disabled}
        onChange={event => {
          const text = event.target.value;
          setCustom(text);
          const bps = Math.round(Number(text) * 100);
          if (/^\d{0,2}(\.\d{0,2})?$/.test(text) && bps >= 1 && bps <= 500) onChange(bps);
        }} />
    </span>
  );
}
