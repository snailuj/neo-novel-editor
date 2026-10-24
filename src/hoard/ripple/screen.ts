// One small question per candidate, in place of one packet for all of them: does this
// change touch this page? The source and the question come first and are the same for
// every candidate of a case, so the model's prompt cache keeps them; the page comes last.
// Confidence only orders pages, never cuts them. Pure.

/** How much of a page's text the screen shows, after its best passage. */
export const SCREEN_BODY = 1200;

export interface Screen {
  affects: boolean;
  confidence: number;
  why: string;
}

export class ScreenError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'ScreenError';
  }
}

export function screenPrompt(source: { title: string; text: string }, candidate: { title: string; body: string; passage?: string }): string {
  const body = candidate.body.trim();
  const cut = body.length > SCREEN_BODY;
  return [
    'You are screening the pages of a writer\'s world-building wiki for one change. One page came in or changed: the source, below. After it comes one other page of the wiki, and one question about that page.',
    '',
    `## Source: ${source.title}`,
    '',
    source.text.trim() || '(The page is empty.)',
    '',
    '## The question',
    '',
    'Does this change mean the page below needs a change, or should name the source? Answer with exactly one line of JSON and nothing else:',
    '',
    '    {"affects": true or false, "confidence": <a number from 0 to 1>, "why": "<one sentence>"}',
    '',
    'Confidence is used only to order pages, never as a cut-off, so say how sure you are.',
    '',
    `## Page: ${candidate.title}`,
    '',
    ...(candidate.passage?.trim() ? ['The passage nearest the source:', '', candidate.passage.trim(), ''] : []),
    cut ? `The page's text, its first ${SCREEN_BODY} characters:` : 'The page\'s text:',
    '',
    cut ? body.slice(0, SCREEN_BODY) : body,
    '',
  ].join('\n');
}

// The end of the JSON object that opens at `from`, strings minded; -1 when it never closes.
function closing(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** The answer in a model's reply, fences or prose around it allowed. */
export function readScreen(text: string): Screen {
  for (let at = text.indexOf('{'); at !== -1; at = text.indexOf('{', at + 1)) {
    const end = closing(text, at);
    if (end === -1) continue;
    let value: unknown;
    try {
      value = JSON.parse(text.slice(at, end + 1));
    } catch {
      continue; // braces in prose; the answer may come later
    }
    if (!value || typeof value !== 'object' || !('affects' in value)) continue;
    const v = value as Record<string, unknown>;
    if (typeof v['affects'] !== 'boolean') throw new ScreenError('"affects" must be true or false');
    const c = v['confidence'];
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) throw new ScreenError('"confidence" must be a number from 0 to 1');
    if (typeof v['why'] !== 'string' || !v['why'].trim()) throw new ScreenError('"why" must be a sentence');
    return { affects: v['affects'], confidence: c, why: v['why'] };
  }
  throw new ScreenError('the reply holds no JSON object with "affects"');
}
