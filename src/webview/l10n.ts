/**
 * Webview-side localization. Webviews cannot use vscode.l10n (that API only
 * exists in the extension host), so each webview bundle carries its own
 * dictionaries and learns the UI language from the `<html lang>` value the
 * host injects when generating the page (see either provider's getHtml).
 * Keys are the English source strings; a miss simply returns the key, so
 * anything untranslated keeps rendering in English.
 */
import { zhCN } from "./locales/zh-cn";

const DICTS: Record<string, Record<string, string>> = {
  "zh-cn": zhCN,
};

/** Same {placeholder} substitution as vscode.l10n.t(). */
export function t(key: string, params?: Record<string, string | number>): string {
  const lang = document.documentElement.lang.toLowerCase();
  // Bare "zh" maps to Simplified Chinese; zh-tw/zh-hk have no dictionary yet
  // and fall back to English rather than showing the wrong script.
  const dict = DICTS[lang] ?? (lang === "zh" ? zhCN : undefined);
  const template = dict?.[key] ?? key;
  if (params == undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match: string, name: string) =>
    params[name] != undefined ? String(params[name]) : match,
  );
}
