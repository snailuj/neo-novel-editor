// Entry point: `node server/main.ts --repo <hoard clone> --state <folder> --host <tailnet address>`.
import { parseConfig } from './config.ts';
import { createServer } from './http.ts';
import { createLogger } from './log.ts';
import { openTree } from './tree.ts';

const log = createLogger();

async function main(): Promise<void> {
  const config = await parseConfig(process.argv.slice(2), process.env);
  const tree = await openTree({ repo: config.repo, library: config.library, state: config.state, log });
  const server = createServer(tree, { log });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  log('info', 'listening', { address, repo: config.repo, library: config.library, state: config.state, seq: tree.currentSeq() });

  let closing = false;
  const close = (signal: string) => {
    if (closing) return;
    closing = true;
    log('info', 'closing', { signal });
    server.close();
    server.closeIdleConnections();
    tree.close().then(() => process.exit(0), (e: unknown) => {
      log('error', 'close.failed', { stack: e instanceof Error ? e.stack : String(e) });
      process.exit(1);
    });
  };
  process.on('SIGINT', () => close('SIGINT'));
  process.on('SIGTERM', () => close('SIGTERM'));
}

main().catch((e: unknown) => {
  log('error', 'startup.failed', { message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
