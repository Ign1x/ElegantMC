"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { useAppCtx } from "../appCtx";
import Icon from "./Icon";
import Tooltip from "./Tooltip";

export default function CopyButton({
  text,
  label,
  tooltip,
  ariaLabel,
  iconOnly,
  className,
  style,
  disabled,
}: {
  text: string;
  label?: ReactNode;
  tooltip?: ReactNode;
  ariaLabel?: string;
  iconOnly?: boolean;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  const { copyText, t } = useAppCtx();
  const [copied, setCopied] = useState<boolean>(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const canCopy = !disabled && String(text || "").length > 0;
  const tooltipBase = tooltip ?? t.tr("Copy", "复制");
  const content = copied ? t.tr("Copied", "已复制") : tooltipBase;

  return (
    <Tooltip content={content} instant>
      <button
        type="button"
        className={["iconBtn", iconOnly ? "iconOnly" : "", className || ""].filter(Boolean).join(" ")}
        style={style}
        aria-label={ariaLabel || (typeof tooltipBase === "string" ? tooltipBase : t.tr("Copy", "复制"))}
        title={typeof tooltipBase === "string" ? tooltipBase : undefined}
        onClick={async () => {
          if (!canCopy) return;
          await copyText(text);
          setCopied(true);
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setCopied(false), 900);
        }}
        disabled={!canCopy}
      >
        <Icon name="copy" />
        {iconOnly ? null : label ?? t.tr("Copy", "复制")}
      </button>
    </Tooltip>
  );
}
