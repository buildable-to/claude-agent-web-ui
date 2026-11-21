import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

/** Passing a request to the copy that owns its account (copies.ts). A passed
 *  request carries HOP, and a copy never passes such a request on again. */
export const HOP = 'x-agent-hop';
/** An answer with this header means: I do not hold that account (any more). */
export const NOT_MINE = 'x-agent-not-mine';

export function isHop(req: IncomingMessage): boolean {
  return req.headers[HOP] !== undefined;
}

/** Send the request to the copy on `port` and stream its answer back.
 *  `onNotMine` is called instead of answering when that copy says the account
 *  is not its own; only requests without a body can be tried again. */
export function passHttp(req: IncomingMessage, res: ServerResponse, port: number, onNotMine?: () => void) {
  // inside a mounted router req.url has lost its prefix; the other copy needs the whole path
  const path = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url;
  // an answer and a later socket error must not both hand the request on
  let handedBack = false;
  const notMine = onNotMine
    ? () => {
        if (handedBack) return;
        handedBack = true;
        onNotMine();
      }
    : undefined;
  const upstream = request(
    { host: '127.0.0.1', port, method: req.method, path, headers: { ...req.headers, [HOP]: '1' } },
    (answer) => {
      if (answer.headers[NOT_MINE] !== undefined && notMine) {
        answer.resume();
        notMine();
        return;
      }
      handedBack = true;
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (handedBack) return;
    if (notMine) notMine();
    else res.writeHead(503, { 'retry-after': '2' }).end('{"error":"The agent is moving to a new version. Try again."}');
  });
  req.pipe(upstream);
}

/** Splice a WebSocket handshake through to the copy on `port`. */
export function passUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number) {
  const upstream = connect(port, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    lines.push(`${HOP}: 1`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const end = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on('error', end);
  socket.on('error', end);
  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}
