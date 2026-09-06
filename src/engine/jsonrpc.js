'use strict';

// [LAW:decomposition] A JSON-RPC 2.0 peer over line-delimited pipes: correlate our requests with
// their responses and hand every other message to one handler. It knows nothing about codex — the
// methods, params and lifecycle are the caller's — so any engine that speaks an app-server-shaped
// protocol is driven through this one client. [LAW:composability]
//
// `io` is the session io runEngine hands a session (write on stdin, `lines` over stdout).
// `onMessage(msg)` receives every message that is not a response to one of OUR requests: server
// notifications (no id) and server requests (id + method), which the caller answers through
// respond/refuse. A line that is not JSON is the engine's own noise on stdout and is skipped, as
// every stream parser here skips it; the raw stream is in the transcript regardless.
//
// [LAW:no-silent-failure] A response carrying `error` rejects the request with the method it
// answered and the server's message, and every request still pending when the stream closes is
// rejected with that fact — a promise that never settles would leave a session hanging on an engine
// that has already exited, when its death is the thing to report.
function createJsonRpcClient(io, onMessage) {
  let nextId = 1;
  const pending = new Map();
  const send = msg => io.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  io.lines.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg === null || typeof msg !== 'object') return;
    const reply = msg.method === undefined ? pending.get(msg.id) : undefined;
    if (!reply) { onMessage(msg); return; }
    pending.delete(msg.id);
    if (msg.error) reply.reject(new Error(`${reply.method} failed: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else reply.resolve(msg.result);
  });
  io.lines.on('close', () => {
    for (const [id, reply] of pending) {
      pending.delete(id);
      reply.reject(new Error(`${reply.method} never answered: the engine's output stream closed first.`));
    }
  });
  return {
    request: (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { method, resolve, reject });
      send({ id, method, params });
    }),
    notify: (method, params) => send({ method, params }),
    respond: (id, result) => send({ id, result }),
    refuse: (id, message) => send({ id, error: { code: -32601, message } }),
  };
}

module.exports = { createJsonRpcClient };
