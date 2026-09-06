'use strict';

// [LAW:decomposition] A JSON-RPC 2.0 peer over line-delimited pipes: correlate our requests with
// their responses and hand every other message to one handler. It knows nothing about codex — the
// methods, params and lifecycle are the caller's — so any engine that speaks an app-server-shaped
// protocol is driven through this one client. [LAW:composability]
//
// `io` is the session io runEngine hands a session (write on stdin, `lines` over stdout).
// `onMessage(msg)` receives every message that is not a response: server notifications (no id) and
// server requests (id + method), which the caller answers through respond/refuse. A line that is not
// JSON is the engine's own noise on stdout and is skipped, as every stream parser here skips it; the
// raw stream is in the transcript regardless.
//
// [LAW:types-are-the-program] `method` is the wire's own discriminator: a message without one is a
// RESPONSE and can only correlate with a request of ours. One whose id is not pending — a late or
// orphan reply — correlates with nothing and is dropped, never handed to the handler as if the server
// had asked something.
//
// [LAW:no-silent-failure] A response carrying `error` rejects the request with the method it
// answered and the server's message, and every request still pending when the stream closes is
// rejected with that fact — a promise that never settles would leave a session hanging on an engine
// that has already exited, when its death is the thing to report. A handler that THROWS is the
// conversation failing to parse what the server sent: the throw rejects every pending request and
// `failed`, the promise a session races beside its own completion, so a malformed notification is
// the loud cause of the session's end and never an uncaught exception inside a stream callback.
function createJsonRpcClient(io, onMessage) {
  let nextId = 1;
  const pending = new Map();
  let fail;
  const failed = new Promise((_, reject) => { fail = reject; });
  failed.catch(() => {}); // observed by the session's race; never an unhandled rejection on its own
  const send = msg => io.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const rejectPending = errorFor => {
    for (const [id, reply] of pending) {
      pending.delete(id);
      reply.reject(errorFor(reply));
    }
  };
  io.lines.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg === null || typeof msg !== 'object') return;
    if (msg.method === undefined) {
      const reply = pending.get(msg.id);
      if (!reply) return;
      pending.delete(msg.id);
      if (msg.error) reply.reject(new Error(`${reply.method} failed: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else reply.resolve(msg.result);
      return;
    }
    try {
      onMessage(msg);
    } catch (err) {
      fail(err);
      rejectPending(() => err);
    }
  });
  io.lines.on('close', () => {
    rejectPending(reply => new Error(`${reply.method} never answered: the engine's output stream closed first.`));
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
    failed,
  };
}

module.exports = { createJsonRpcClient };
