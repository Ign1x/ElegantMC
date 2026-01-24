import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "ElegantMC",
  description: "ElegantMC Panel · Remote Minecraft Server Manager",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const themeInitScript = `
(() => {
  try {
    var mode = localStorage.getItem("elegantmc_theme_mode") || "auto";
    var mql = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)");
    var sys = mql && mql.matches ? "light" : "dark";
    var theme = (mode === "light" || mode === "dark") ? mode : sys;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeMode = mode;
  } catch (e) {}
})();
`;
  return (
    <html lang="zh-CN">
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <a className="skipLink" href="#mainContent">
          Skip to content / 跳到内容
        </a>
        {children}
      </body>
    </html>
  );
}
