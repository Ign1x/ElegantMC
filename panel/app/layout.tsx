import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "ElegantMC",
  description: "ElegantMC Panel · Remote Minecraft Server Manager",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
