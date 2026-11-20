// Shared by the server's tests: a started server and a tiny HTTP client.
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openHoardTools, type HoardTools, type HoardToolsOptions } from '../../../server/hoard.ts';
import { createServer } from '../../../server/http.ts';
import type { Tree } from '../../../server/tree.ts';
import { openTestTree, type Hoard, type LogLine } from './hoard.ts';

export { captureLog, openTestTree, tempHoard, type Hoard, type LogLine } from './hoard.ts';

interface Cleanup { after(fn: () => void): void }

export interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; json: any }

export interface Client {
  url: string;
  call(method: string, rawPath: string, options?: { body?: Buffer | string; chunks?: string[]; headers?: Record<string, string> }): Promise<Reply>;
  get(p: string): Promise<Reply>;
  put(p: string, body: Buffer | string, headers?: Record<string, string>): Promise<Reply>;
  del(p: string, ifMatch?: string): Promise<Reply>;
  move(from: string, to: string, ifMatch?: string): Promise<Reply>;
  changes(since: number, limit?: number): Promise<Reply>;
}

/** Raw node:http, so a `..` segment reaches the server as written instead of being resolved by fetch. */
export function clientFor(server: Server, device = 'test-device'): Client {
  const { port } = server.address() as AddressInfo;
  const call: Client['call'] = (method, rawPath, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path: rawPath, headers: { 'X-Neo-Device': device, ...options.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json: unknown = null;
        if (String(res.headers['content-type']).startsWith('application/json')) json = JSON.parse(body.toString('utf8'));
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    // Several writes with no Content-Length make the request chunked.
    for (const chunk of options.chunks ?? []) req.write(chunk);
    req.end(options.body);
  });
  const file = (p: string) => `/v1/files/${p.split('/').map(encodeURIComponent).join('/')}`;
  const q = (v: string | undefined): Record<string, string> => (v === undefined ? {} : { 'If-Match': `"${v}"` });
  return {
    url: `http://127.0.0.1:${port}`,
    call,
    get: (p) => call('GET', file(p)),
    put: (p, body, headers = {}) => call('PUT', file(p), { body, headers }),
    del: (p, ifMatch) => call('DELETE', file(p), { headers: q(ifMatch) }),
    move: (from, to, ifMatch) => call('POST', '/v1/moves', {
      body: JSON.stringify({ from, to, ...(ifMatch === undefined ? {} : { ifMatch }) }), headers: { 'Content-Type': 'application/json' },
    }),
    changes: (since, limit) => call('GET', `/v1/changes?since=${since}${limit === undefined ? '' : `&limit=${limit}`}`),
  };
}

export interface StartOptions { bodyLimit?: number; hoardTools?: Omit<HoardToolsOptions, 'repo' | 'state' | 'log'> }

/** `hoardTools`, when given, opens the hoard tools on the same repo and state folder, and closes them after the server. */
export async function startServer(t: Cleanup, hoard: Hoard, options: StartOptions = {}): Promise<{ tree: Tree; client: Client; server: Server; lines: LogLine[]; tools?: HoardTools }> {
  const { tree, lines } = await openTestTree(hoard);
  const log = (level: string, msg: string, data?: Record<string, unknown>) => { lines.push({ level, msg, ...data }); };
  const tools = options.hoardTools ? await openHoardTools({ repo: hoard.repo, state: hoard.state, log, ...options.hoardTools }) : undefined;
  const server = createServer(tree, { log, bodyLimit: options.bodyLimit, hoard: tools });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await tools?.close(); await tree.close(); });
  return { tree, client: clientFor(server), server, lines, tools };
}
