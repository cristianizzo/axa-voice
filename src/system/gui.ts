import { execFile } from 'node:child_process';
import type { GuiCommand } from '../director/gui-command.ts';

/**
 * Runs the user's `gui` script directly, as a plain subprocess — never through
 * Claude's Bash tool. `Bash(gui on:*)` is deny-listed in the user's global
 * settings.json on purpose (so an interactive session cannot silently grant
 * itself screen control), and a deny rule from settingSources wins before
 * canUseTool is ever consulted, so a spoken yes/no cannot get past it that way.
 * The gate that matters here is `interpretGuiCommand`: only an explicit,
 * whole-utterance request reaches this function at all.
 */
export function runGuiCommand(scriptPath: string, mode: GuiCommand): Promise<string> {
  return new Promise((resolve) => {
    execFile(scriptPath, [mode], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        resolve(`Non ci sono riuscito: ${(stderr || error.message).trim()}`);
        return;
      }
      resolve(mode === 'on' ? 'Gui attivata.' : 'Gui disattivata.');
      void stdout;
    });
  });
}
