/**
 * What to say while a tool runs.
 *
 * §7 forbids reading identifiers out loud, and a tool name is an identifier.
 * Every line names the ACTION. Unknown tools fall back to something equally
 * human rather than leaking the name.
 */
const LINES: Record<string, readonly string[]> = {
  WebSearch: ['Sto cercando sul web.', 'Sto ancora cercando.', 'Ci vuole un attimo.'],
  WebFetch: ['Sto aprendo la pagina.', 'Sto ancora leggendo la pagina.'],
  Read: ['Sto leggendo.', 'Sto ancora leggendo.'],
  Grep: ['Sto cercando nel testo.', 'Ci sono quasi.'],
  Glob: ['Sto cercando il file.', 'Ci sono quasi.'],
  Bash: ['Sto eseguendo.', 'Ci vuole ancora un momento.'],
};
const FALLBACK = ['Un attimo che finisco.', 'Ci sto ancora lavorando.', 'Ci sono quasi.'];

/**
 * `index` counts the lines already said about this tool call, so a wait long
 * enough to need three of them does not repeat the same sentence three times —
 * the single most robotic thing a voice assistant does.
 */
export function progressLine(tool: string, index: number): string {
  const lines = LINES[tool] ?? FALLBACK;
  return lines[index % lines.length]!;
}
