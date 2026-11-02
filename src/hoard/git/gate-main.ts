// The pre-commit gate in the main half: every commit of the library's history runs it
// from here on. Library Check
// Findings, from the Plugins menu, shows what the gate found; nothing is shown unasked,
// because nothing interrupts the writer.
import { BrowserWindow, dialog } from 'electron';
import { describeFindings, Gate } from './gate.ts';
import type { GitLayer } from './layer.ts';

export function startGate(host: NeoMainHost, layer: GitLayer): Gate {
  const gate = new Gate({ library: () => host.paths.library(), log: host.log.bind(host) });
  layer.useGate(gate);
  host.handle('git.findings', async () => {
    const box = describeFindings(gate.findings(), gate.held());
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.MessageBoxOptions = { type: 'info', ...box };
    await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    return { findings: gate.findings(), held: gate.held() };
  });
  return gate;
}
