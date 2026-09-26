import { normalise } from './approval.ts';

export type GuiCommand = 'on' | 'off';

/**
 * Whole-utterance match, like isStopCommand: "gui" said inside an ordinary
 * sentence is not a request to toggle screen control.
 *
 * This exists to bypass `Bash(gui on:*)`, which is deny-listed in the user's
 * global settings.json specifically so that an interactive Claude Code session
 * cannot silently grant itself mouse/keyboard control. Axa's own spoken
 * yes/no confirmation (canUseTool) does not help here — a deny rule from
 * settingSources wins before canUseTool is even consulted. So this command
 * never reaches Claude's Bash tool at all: it is recognised and executed here,
 * directly, on the user's explicit spoken request.
 *
 * Word-set matching rather than exact phrases: measured, whisper never
 * transcribes "attiva la gui" verbatim — it comes back as "Attiva guion" or
 * "Gui on", merging "gui" and "on" into one token. `GUI_TOKENS` is therefore
 * an exact allow-list of the tokens actually observed, not a `startsWith`
 * check — a fuzzy prefix match would also catch "guida" (guide), and "apri la
 * guida" (open the guide) must never turn on screen control.
 */
const GUI_TOKENS = new Set(['gui', 'guion', 'guioff']);

const ON_WORDS = new Set(['on', 'attiva', 'accendi', 'apri']);
const OFF_WORDS = new Set(['off', 'disattiva', 'spegni', 'chiudi']);

const MAX_WORDS = 6;

export function interpretGuiCommand(text: string): GuiCommand | null {
  const normalised = normalise(text);
  if (!normalised) return null;
  const words = normalised.split(' ');
  if (words.length > MAX_WORDS) return null;
  if (!words.some((w) => GUI_TOKENS.has(w))) return null;

  const off = words.some((w) => OFF_WORDS.has(w) || w === 'guioff');
  const on = words.some((w) => ON_WORDS.has(w) || w === 'guion');
  // Both or neither is not a clear instruction: say nothing rather than guess
  // which way to flip a capability this sensitive.
  if (off === on) return null;
  return off ? 'off' : 'on';
}
