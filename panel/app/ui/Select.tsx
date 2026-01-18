"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type SelectOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
};

function findFirstEnabled(options: SelectOption[]) {
  for (let i = 0; i < options.length; i++) {
    if (!options[i]?.disabled) return i;
  }
  return -1;
}

function findNextEnabled(options: SelectOption[], from: number, dir: 1 | -1) {
  if (!options.length) return -1;
  let i = from;
  for (let step = 0; step < options.length; step++) {
    i = (i + dir + options.length) % options.length;
    if (!options[i]?.disabled) return i;
  }
  return -1;
}

export default function Select({
  value,
  onChange,
  options,
  disabled,
  placeholder = "Select…",
  menuPlacement = "auto",
  menuMaxHeight = 320,
  style,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  placeholder?: string;
  menuPlacement?: "auto" | "top" | "bottom";
  menuMaxHeight?: number;
  style?: any;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState<boolean>(false);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [menuPos, setMenuPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

  const selected = useMemo(() => options.find((o) => String(o.value) === String(value)) || null, [options, value]);
  const selectedLabel = selected ? selected.label : placeholder;

  function computeMenuPos() {
    const btn = btnRef.current;
    if (!btn || typeof window === "undefined") return null;
    const rect = btn.getBoundingClientRect();
    const vw = Math.max(0, window.innerWidth || 0);
    const vh = Math.max(0, window.innerHeight || 0);
    const offset = 6;
    const padding = 8;

    const desiredMax = Math.max(120, Math.min(720, Math.round(Number(menuMaxHeight || 320))));
    const approx = Math.min(desiredMax, 12 + Math.max(1, options.length) * 34);

    const below = Math.max(0, vh - rect.bottom);
    const above = Math.max(0, rect.top);

    let placement: "top" | "bottom" = "bottom";
    if (menuPlacement === "top") placement = "top";
    else if (menuPlacement === "bottom") placement = "bottom";
    else placement = below < approx && above > below ? "top" : "bottom";

    const available = placement === "bottom" ? below : above;
    const maxH = Math.max(120, Math.min(desiredMax, available - offset - 6));

    let width = Math.max(160, Math.round(rect.width || 0));
    width = Math.min(width, Math.max(160, vw - padding * 2));

    let left = Math.round(rect.left || 0);
    left = Math.max(padding, Math.min(left, vw - padding - width));

    if (placement === "top") {
      const bottom = Math.round(vh - rect.top + offset);
      return { left, width, bottom, maxHeight: maxH };
    }
    const top = Math.round(rect.bottom + offset);
    return { left, width, top, maxHeight: maxH };
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as any;
      const root = rootRef.current;
      const menu = menuRef.current;
      if (root && root.contains(target)) return;
      if (menu && menu.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => String(o.value) === String(value) && !o.disabled);
    setActiveIdx(idx >= 0 ? idx : findFirstEnabled(options));
  }, [open, options, value]);

  useEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const update = () => setMenuPos(computeMenuPos());
    update();

    const onResize = () => update();
    const onScroll = (e: any) => {
      const t = e?.target as any;
      const menu = menuRef.current;
      if (menu && t && menu.contains(t)) return;
      update();
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options.length, value, menuPlacement, menuMaxHeight]);

  function commit(idx: number) {
    const opt = options[idx];
    if (!opt || opt.disabled) return;
    onChange(String(opt.value));
    setOpen(false);
    btnRef.current?.focus();
  }

  function onButtonKeyDown(e: any) {
    if (disabled) return;
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) return setOpen(true);
      const next = findNextEnabled(options, activeIdx >= 0 ? activeIdx : findFirstEnabled(options), 1);
      if (next >= 0) setActiveIdx(next);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      const next = findNextEnabled(options, activeIdx >= 0 ? activeIdx : findFirstEnabled(options), -1);
      if (next >= 0) setActiveIdx(next);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!open) return setOpen(true);
      if (activeIdx >= 0) commit(activeIdx);
    }
  }

  const menu =
    open && menuPos && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            className="uiSelectMenu"
            role="listbox"
            style={{
              left: menuPos.left,
              width: menuPos.width,
              top: menuPos.top,
              bottom: menuPos.bottom,
              maxHeight: menuPos.maxHeight,
            }}
          >
            {options.map((o, idx) => {
              const selected = String(o.value) === String(value);
              const active = idx === activeIdx;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`uiSelectOption ${selected ? "selected" : ""} ${active ? "active" : ""}`}
                  disabled={!!o.disabled}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => commit(idx)}
                >
                  {o.label}
                </button>
              );
            })}
          </div>,
          document.body
        )
      : null;

  return (
    <div ref={rootRef} className={`uiSelect ${open ? "open" : ""} ${disabled ? "disabled" : ""}`} style={style}>
      <button
        ref={btnRef}
        type="button"
        className="uiSelectButton"
        onClick={() => (!disabled ? setOpen((v) => !v) : null)}
        onKeyDown={onButtonKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!!disabled}
      >
        <span className="uiSelectValue">{selectedLabel}</span>
        <span className="uiSelectChevron" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {menu}
    </div>
  );
}
