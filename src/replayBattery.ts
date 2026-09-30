export interface BatterySeries { times: Float64Array; values: Float64Array }
export interface ReplayBattery {
  name: string;
  remaining: BatterySeries | undefined;
  voltage: BatterySeries | undefined;
  current: BatterySeries | undefined;
  connected: BatterySeries | undefined;
}

/** Latest reading at the replay time; never borrow a future sample. */
export function batteryValueAt(series: BatterySeries | undefined, time: number): number {
  if (!series || !series.times.length || time < series.times[0]!) return NaN;
  let lo = 0, hi = series.times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series.times[mid]! <= time) lo = mid;
    else hi = mid - 1;
  }
  return series.values[lo] ?? NaN;
}

export function batteryReadingsAt(battery: ReplayBattery, time: number): { remaining: string; voltage: string; current: string } {
  const unavailable = { remaining: "—", voltage: "—", current: "—" };
  if (battery.connected && batteryValueAt(battery.connected, time) !== 1) return unavailable;
  const remaining = batteryValueAt(battery.remaining, time);
  const voltage = batteryValueAt(battery.voltage, time);
  const current = batteryValueAt(battery.current, time);
  return {
    remaining: Number.isFinite(remaining) && remaining >= 0 && remaining <= 1 ? `${Math.round(remaining * 100)} %` : "—",
    voltage: Number.isFinite(voltage) && voltage > 0 ? `${voltage.toFixed(1)} V` : "—",
    current: Number.isFinite(current) && current >= 0 ? `${current.toFixed(1)} A` : "—",
  };
}
