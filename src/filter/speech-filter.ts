import type { AgentEvent, SpeechFilter } from '../types.ts';

const FENCE = '```';
const CODE_REPLACEMENT = " Te l'ho scritta, guarda lo schermo. ";

const EXTENSIONS: Record<string, string> = {
  ts: 'punto ti esse',
  tsx: 'punto ti esse ics',
  js: 'punto gi esse',
  jsx: 'punto gi esse ics',
  mjs: 'punto emme gi esse',
  md: 'punto emme di',
  json: 'punto geison',
  swift: 'punto swift',
  py: 'punto pi i',
  sh: 'punto esse acca',
  yml: 'punto yaml',
  yaml: 'punto yaml',
  txt: 'punto ti ics ti',
  css: 'punto ci esse esse',
  html: 'punto acca ti emme elle',
};

/**
 * Sentence end, tolerating a missing space before the next capital: streamed
 * tokens arrive without tidy spacing.
 */
const SENTENCE_END = /^([\s\S]*?[.!?…]["')\]]?)(\s+|(?=[A-ZÀ-Ý]))/;

/** `[etichetta](url)` and `![alt](url)` — say the label, never the target. */
const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;

/** A bare URL. Everything after the host is unspeakable. */
const BARE_URL = /\b(?:https?:\/\/|www\.)[^\s<>()[\]]+/gi;

/** `a/b/c.ext` — the last directory plus the file name is all the user needs. */
const PATH_WITH_EXTENSION = /([\w.@-]+\/)+([\w-]+)\.(\w+)/g;

/**
 * `a/b/c` with no extension. Three segments minimum and a letter to start each
 * one, so "km/h", "e/o" and "12/09/2026" are left alone.
 */
const PATH_WITHOUT_EXTENSION =
  /(?<![\w./-])((?:[A-Za-z_][\w-]*\/){2,})([A-Za-z_][\w-]*)(?![\w./-])/g;

/** A bare `name.ext`, shortened only when the extension is one we can say. */
const BARE_FILENAME = /\b([\w-]+)\.(\w+)\b/g;

function spokenExtension(ext: string): string {
  return EXTENSIONS[ext.toLowerCase()] ?? `punto ${ext}`;
}

function spokenPath(dirs: string, base: string, ext: string): string {
  const parent = dirs.split('/').filter(Boolean).at(-1)?.replace(/^\./, '');
  const spoken = `${base} ${spokenExtension(ext)}`;
  return parent ? `${spoken}, dentro ${parent}` : spoken;
}

function spokenUrl(url: string): string {
  // Trailing punctuation belongs to the sentence, not to the URL.
  const trail = /[.,;:!?]+$/.exec(url)?.[0] ?? '';
  const core = url.slice(0, url.length - trail.length);
  const host = /^(?:https?:\/\/)?(?:www\.)?([^/\s?#]+)/i.exec(core)?.[1] ?? '';
  return host + trail;
}

/**
 * Turn one chunk of Claude's markdown into something a person would say.
 * Order matters: link targets are removed before paths are shortened, or the
 * path rule fires inside URLs.
 */
export function toSpokenForm(text: string): string {
  return (
    text
      // Line-leading markup: headings, quotes, bullets, numbered items.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      // Horizontal rules say nothing out loud.
      .replace(/^\s*([-*_])\s*(?:\1\s*){2,}$/gm, '')
      .replace(MARKDOWN_LINK, '$1')
      .replace(BARE_URL, spokenUrl)
      // Emphasis is delivery, not words.
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      // Inline code: the content is worth saying, the backticks are not.
      .replace(/`([^`]*)`/g, '$1')
      .replace(PATH_WITH_EXTENSION, (_all, dirs: string, base: string, ext: string) =>
        spokenPath(dirs, base, ext),
      )
      .replace(PATH_WITHOUT_EXTENSION, (_all, dirs: string, base: string) => {
        const parent = dirs.split('/').filter(Boolean).at(-1)?.replace(/^\./, '');
        return parent ? `${base}, dentro ${parent}` : base;
      })
      .replace(BARE_FILENAME, (all, base: string, ext: string) =>
        EXTENSIONS[ext.toLowerCase()] ? `${base} ${EXTENSIONS[ext.toLowerCase()]}` : all,
      )
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Emits complete sentences as early as possible so TTS can start, and never
 * lets a code block reach the speakers (spec §7).
 *
 * Code stripping is a state machine, not a regex over the whole buffer: tokens
 * arrive a few characters at a time, so a fence opens in one delta and closes
 * many deltas later. A regex that treats an unterminated fence as "code so far"
 * rewrites the buffer too early and lets the rest of the block through.
 */
export class SentenceSpeechFilter implements SpeechFilter {
  async *filter(events: AsyncIterable<AgentEvent>): AsyncIterable<string> {
    /** Prose ready to be split into sentences. Never contains code. */
    let prose = '';
    /** Raw tail we cannot classify yet, because it may be a partial fence. */
    let pending = '';
    let inCode = false;
    /** True while the most recent prose is the code narration and nothing else. */
    let narrated = false;

    const addProse = (text: string): void => {
      if (!text) return;
      prose += text;
      if (text.trim()) narrated = false;
    };

    const absorb = (delta: string): void => {
      pending += delta;
      for (;;) {
        const at = pending.indexOf(FENCE);
        if (at === -1) break;
        if (inCode) {
          pending = pending.slice(at + FENCE.length);
          inCode = false;
        } else {
          addProse(pending.slice(0, at));
          // Back-to-back blocks are one interruption, not two.
          if (!narrated) {
            prose += CODE_REPLACEMENT;
            narrated = true;
          }
          pending = pending.slice(at + FENCE.length);
          inCode = true;
        }
      }
      if (inCode) {
        // Discard the code, but keep a trailing backtick run: it may be the
        // start of the closing fence.
        const keep = /`{1,2}$/.exec(pending)?.[0] ?? '';
        pending = keep;
      } else {
        // Same reasoning in reverse: a trailing backtick run may open a fence.
        const keep = /`{1,2}$/.exec(pending)?.[0] ?? '';
        addProse(pending.slice(0, pending.length - keep.length));
        pending = keep;
      }
    };

    const drain = function* (): Generator<string> {
      for (;;) {
        const match = SENTENCE_END.exec(prose);
        if (!match) break;
        prose = prose.slice(match[0].length);
        const spoken = toSpokenForm(match[1]!);
        if (spoken) yield spoken;
      }
    };

    /**
     * Release whatever is complete. A sentence that ends a text block has no
     * whitespace after it, so it never satisfies SENTENCE_END and would sit in
     * the buffer until the turn finished — which, when the next thing is a tool
     * call, was measured at 16 s (spec §4).
     */
    const flush = function* (): Generator<string> {
      const spoken = toSpokenForm(prose);
      prose = '';
      if (spoken) yield spoken;
    };

    for await (const event of events) {
      if (event.type === 'text') {
        absorb(event.delta);
        yield* drain();
        continue;
      }
      // A tool call or the end of the turn closes the text block.
      yield* flush();
    }

    if (!inCode) addProse(pending);
    pending = '';
    yield* flush();
  }
}
