"use client";

import type { ReactNode } from "react";
import { createContext, useContext } from "react";

export const AppCtx = createContext<any>(null);

export function AppCtxProvider({ value, children }: { value: any; children: ReactNode }) {
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useAppCtx() {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("AppCtxProvider missing");
  return ctx;
}
