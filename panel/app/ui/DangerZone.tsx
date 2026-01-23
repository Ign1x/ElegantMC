"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";

export default function DangerZone({
  title = "Danger Zone",
  hint = "",
  children,
  defaultOpen = false,
  open,
  onOpenChange,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const controlled = useMemo(() => typeof open === "boolean", [open]);
  const [internalOpen, setInternalOpen] = useState<boolean>(!!defaultOpen);
  const actualOpen = controlled ? !!open : internalOpen;

  return (
    <details
      className="dangerZone"
      open={actualOpen}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (controlled) onOpenChange?.(next);
        else setInternalOpen(next);
      }}
    >
      <summary className="dangerZoneSummary">{title}</summary>
      {hint ? <div className="hint">{hint}</div> : null}
      <div className="dangerZoneBody">{children}</div>
    </details>
  );
}
