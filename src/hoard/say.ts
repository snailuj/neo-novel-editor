// Words the writer sees, in NEO's language (i18n.js, window.NeoI18n): the English text is the
// key, so a string with no translation shows as written. scripts/i18n.js finds the t('…')
// calls in the files it lists, for locales/_template.json; the text must be a literal there.
declare const NeoI18n: { t(text: string, vars?: Record<string, string>): string } | undefined;

export const t = (text: string, vars: Record<string, string> = {}): string => (typeof NeoI18n !== 'undefined'
  ? NeoI18n.t(text, vars)
  : text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole));
