export type Locale = "zh" | "en";

const dict = {
  en: {
    "tab.nodes": "Nodes",
    "tab.games": "Games",
    "tab.frp": "FRP",
    "tab.files": "Files",
    "tab.panel": "Panel",
    "tab.advanced": "Advanced",
  },
  zh: {
    "tab.nodes": "节点",
    "tab.games": "游戏",
    "tab.frp": "FRP",
    "tab.files": "文件",
    "tab.panel": "面板",
    "tab.advanced": "高级",
  },
} as const;

export type I18nKey = keyof (typeof dict)["en"];

export type TFunc = ((key: I18nKey) => string) & {
  tr: (en: string, zh: string) => string;
};

export function normalizeLocale(v: unknown): Locale {
  const s = String(v || "").toLowerCase().trim();
  if (s === "zh" || s === "zh-cn" || s === "zh_hans") return "zh";
  if (s === "en" || s === "en-us" || s === "en_us") return "en";
  return "en";
}

export function createT(locale: Locale): TFunc {
  const loc: Locale = locale === "zh" ? "zh" : "en";
  const fn = ((key: I18nKey) => dict[loc][key] || dict.en[key] || key) as TFunc;
  fn.tr = (en: string, zh: string) => (loc === "zh" ? zh : en);
  return fn;
}
