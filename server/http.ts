// The HTTP face of the tree, under `/v1`. Each route maps to one tree call; this layer
// parses the request, reports errors as `{ code, message, ...extra }`, and logs the request.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError } from './errors.ts';
import type { Log } from './log.ts';
import { checkPath } from './paths.ts';
import type { Tree } from './tree.ts';

export interface HttpOptions { log: Log; bodyLimit?: number }

interface Reply { status: number; json?: unknown; bytes?: Buffer; headers?: Record<string, string> }

const tooLarge = (limit: number) => new ApiError('too_large', 413, `the body is over the ${limit} byte limit`);
const methodNotAllowed = () => new ApiError('method_not_allowed', 405, 'method not allowed for this route');

/** Reads the whole body, or stops reading and refuses once it passes `limit`. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const refuse = () => {
      req.removeListener('data', onData);
      req.resume(); // discard what is still coming instead of buffering it
      reject(tooLarge(limit));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) refuse(); else chunks.push(chunk);
    };
    if (Number(req.headers['content-length']) > limit) { refuse(); return; }
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** `"abc"`, `W/"abc"` and `abc` all mean the version abc. */
function etag(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

function preconditions(req: IncomingMessage): { ifMatch?: string; ifNoneMatch?: string } {
  const none = req.headers['if-none-match'];
  if (none !== undefined && none !== '*') throw new ApiError('bad_header', 400, 'If-None-Match accepts only *');
  return { ifMatch: etag(req.headers['if-match']), ifNoneMatch: none };
}

function decodePath(rest: string): string {
  try {
    return checkPath(decodeURIComponent(rest));
  } catch (e) {
    if (e instanceof URIError) throw new ApiError('bad_path', 400, 'the path is not valid percent-encoding');
    throw e;
  }
}

function intParam(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) throw new ApiError('bad_query', 400, `${name} must be an integer from ${min} to ${max}`);
  return n;
}

async function route(tree: Tree, req: IncomingMessage, limit: number): Promise<Reply> {
  const url = req.url ?? '/';
  // Not `new URL(...)`: that would resolve `..` segments before the path check sees them.
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  const params = new URLSearchParams(q === -1 ? '' : url.slice(q + 1));
  const method = req.method ?? 'GET';

  if (pathname === '/v1/state') {
    if (method !== 'GET') throw methodNotAllowed();
    return { status: 200, json: await tree.state() };
  }
  if (pathname === '/v1/changes') {
    if (method !== 'GET') throw methodNotAllowed();
    const since = intParam(params, 'since', 0, 0, Number.MAX_SAFE_INTEGER);
    return { status: 200, json: tree.changes(since, intParam(params, 'limit', 500, 1, 5000)) };
  }
  if (pathname === '/v1/moves') {
    if (method !== 'POST') throw methodNotAllowed();
    let body: { from?: unknown; to?: unknown; ifMatch?: unknown };
    try {
      body = JSON.parse((await readBody(req, limit)).toString('utf8'));
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('bad_json', 400, 'the body is not valid JSON');
    }
    const { from, to, ifMatch } = body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string' || (ifMatch !== undefined && typeof ifMatch !== 'string')) {
      throw new ApiError('bad_json', 400, 'the body must be { "from": string, "to": string, "ifMatch": string }');
    }
    return { status: 200, json: await tree.move(from, to, etag(ifMatch)) };
  }
  if (pathname.startsWith('/v1/files/')) {
    const p = decodePath(pathname.slice('/v1/files/'.length));
    if (method === 'GET') {
      const { bytes, version } = await tree.read(p);
      return { status: 200, bytes, headers: { ETag: `"${version}"` } };
    }
    if (method === 'PUT') {
      const pre = preconditions(req);
      const result = await tree.put(p, await readBody(req, limit), pre);
      return { status: 200, json: result, headers: { ETag: `"${result.version}"` } };
    }
    if (method === 'DELETE') return { status: 200, json: await tree.remove(p, etag(req.headers['if-match'])) };
    throw methodNotAllowed();
  }
  throw new ApiError('not_found', 404, `no route ${method} ${pathname}`);
}

function send(res: ServerResponse, reply: Reply): void {
  const body = reply.bytes ?? Buffer.from(JSON.stringify(reply.json));
  res.writeHead(reply.status, {
    'Content-Type': reply.bytes ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...(reply.status === 413 ? { Connection: 'close' } : {}),
    ...reply.headers,
  });
  res.end(body);
}

export function createServer(tree: Tree, { log, bodyLimit = 50 * 1024 * 1024 }: HttpOptions): Server {
  return createHttpServer((req, res) => {
    const start = performance.now();
    const seqBefore = tree.currentSeq();
    route(tree, req, bodyLimit).then((reply) => reply, (e: unknown) => {
      if (e instanceof ApiError) return { status: e.status, json: { code: e.code, message: e.message, ...e.extra } };
      log('error', 'request.failed', { method: req.method, url: req.url, stack: e instanceof Error ? e.stack : String(e) });
      return { status: 500, json: { code: 'internal', message: 'internal error' } };
    }).then((reply) => {
      send(res, reply);
      const url = req.url ?? '';
      const device = req.headers['x-neo-device'];
      log('info', 'request', {
        method: req.method, path: url.split('?')[0], device: typeof device === 'string' && device !== '' ? device : null,
        seqBefore, seqAfter: tree.currentSeq(), status: reply.status, ms: Math.round(performance.now() - start),
      });
    }).catch((e: unknown) => {
      // The client went away mid-response; there is nobody left to tell.
      log('error', 'request.respond_failed', { method: req.method, url: req.url, stack: e instanceof Error ? e.stack : String(e) });
    });
  });
}
