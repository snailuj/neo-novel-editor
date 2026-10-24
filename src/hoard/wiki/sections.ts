// A section of a Markdown page, as an import list's `page.md#Heading` names it: the
// heading's line and every line after it up to the next heading of the same or a higher
// level. A `#` line inside a code fence is no heading; a fence closes only on a line of
// its own marker at least as long as the one that opened it, as CommonMark has it. The
// first heading that matches
// exactly wins; failing that, the first that matches without regard to case.
//
// Pure.
const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export interface Heading { line: number; level: number; text: string }

export function headings(body: string): Heading[] {
  const found: Heading[] = [];
  let open = '';
  body.split('\n').forEach((line, i) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (!open) open = marker;
      else if (marker[0] === open[0] && marker.length >= open.length && line.trim() === marker) open = '';
      return;
    }
    const m = open ? null : ATX.exec(line);
    if (m) found.push({ line: i, level: m[1]!.length, text: m[2]!.trim() });
  });
  return found;
}

/** The section under `heading`, without a trailing newline, or null when the page has no such heading. */
export function section(body: string, heading: string): string | null {
  const all = headings(body);
  const want = heading.trim();
  const at = all.findIndex((h) => h.text === want) >= 0
    ? all.findIndex((h) => h.text === want)
    : all.findIndex((h) => h.text.toLowerCase() === want.toLowerCase());
  if (at < 0) return null;
  const start = all[at]!;
  const end = all.slice(at + 1).find((h) => h.level <= start.level);
  const lines = body.split('\n').slice(start.line, end ? end.line : undefined);
  while (lines.length && lines.at(-1)!.trim() === '') lines.pop();
  return lines.join('\n');
}
