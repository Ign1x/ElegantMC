"use client";

import { useMemo } from "react";

function clamp(v: number, lo: number, hi: number) {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

export default function Sparkline({
  values,
  width = 140,
  height = 30,
  stroke = "rgba(147, 197, 253, 0.95)",
  fill = "rgba(147, 197, 253, 0.14)",
  min = 0,
  max = 100,
  windowSize = 60,
}: {
  values: Array<number | null | undefined>;
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  min?: number;
  max?: number;
  windowSize?: number;
}) {
  const { d, area } = useMemo(() => {
    const nMax = Math.max(2, Math.min(600, Math.round(Number(windowSize || 60))));
    const vals = (Array.isArray(values) ? values : [])
      .slice(-nMax)
      .map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 100;
    const denom = hi - lo === 0 ? 1 : hi - lo;

    const points: Array<{ x: number; y: number }> = [];
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const innerH = Math.max(1, h - 2);

    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      const x = vals.length <= 1 ? 0 : (i * (w - 2)) / (vals.length - 1) + 1;
      const vv = v == null ? lo : clamp(v, lo, hi);
      const t = (vv - lo) / denom;
      const y = 1 + (1 - t) * innerH;
      points.push({ x, y });
    }

    const line =
      points.length >= 2
        ? `M ${points
            .map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
            .join(" L ")}`
        : "";
    const areaPath =
      points.length >= 2
        ? `${line} L ${points[points.length - 1]!.x.toFixed(2)} ${(h - 1).toFixed(2)} L ${points[0]!.x.toFixed(2)} ${(h - 1).toFixed(2)} Z`
        : "";
    return { d: line, area: areaPath };
  }, [values, width, height, min, max, windowSize]);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="sparkline">
      {area ? <path d={area} fill={fill} stroke="none" /> : null}
      {d ? <path d={d} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" /> : null}
    </svg>
  );
}

