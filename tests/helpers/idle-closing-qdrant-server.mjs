// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Minimal Qdrant REST server, run as a worker thread so it keeps serving
 * while the test thread is blocked. Serves a subset of the routes the
 * symbol-graph store uses: list collections, create a collection (any method
 * on `/collections/<name>`, DELETE included), upsert points (PUT on
 * `/collections/<name>/points`) and retrieve points by id (any other method
 * there). Every other path, point delete and scroll included, answers 404.
 *
 * workerData: { idleMs } — close a keep-alive connection idle this long.
 * Posts { port } once listening, then answers messages from the parent:
 *   { id, type: "reset", close?, reject? } — clear all state; `close`
 *     ({ method, path, count }) closes the connection without a reply for the
 *     next `count` matching requests; `reject` ({ method, path }) answers the
 *     next matching request with HTTP 400. `path` is a RegExp source.
 *     Replies { id }.
 *   { id, type: "requests" } — replies { id, requests: ["METHOD /path", …] }.
 */

import { createServer } from "node:http";
import { parentPort, workerData } from "node:worker_threads";

const collections = new Map();
let requests = [];
let close = null;
let reject = null;

const matches = (route, method, path) => route && method === route.method && new RegExp(route.path).test(path);

function reply(res, status, result) {
  const body = JSON.stringify(status === 200 ? { result, status: "ok", time: 0 } : { status: { error: result } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

// A half-close (end, not destroy) leaves the server reading, so a request the
// client then writes gets no RST and the client reads EOF: UND_ERR_SOCKET, not
// a platform-dependent ECONNRESET.
function halfClose(socket) {
  socket.halfClosed = true;
  socket.end();
}

function handle(req, res, raw) {
  const path = new URL(req.url, "http://fixture").pathname;
  requests.push(`${req.method} ${path}`);
  if (req.socket.halfClosed) {
    req.socket.destroy();
    return;
  }
  if (close?.count > 0 && matches(close, req.method, path)) {
    close.count--;
    halfClose(req.socket);
    return;
  }
  if (matches(reject, req.method, path)) {
    reject = null;
    reply(res, 400, "fixture rejection");
    return;
  }
  const body = raw.length > 0 ? JSON.parse(raw) : {};
  const [, name, points] = path.match(/^\/collections\/([^/]+)(\/points)?$/) ?? [];
  if (req.method === "GET" && path === "/collections") {
    reply(res, 200, { collections: [...collections.keys()].map((n) => ({ name: n })) });
  } else if (name && !points) {
    if (!collections.has(name)) collections.set(name, new Map());
    reply(res, 200, true);
  } else if (name && req.method === "PUT") {
    const coll = collections.get(name) ?? new Map();
    for (const point of body.points) coll.set(String(point.id), point);
    collections.set(name, coll);
    reply(res, 200, { operation_id: 0, status: "completed" });
  } else if (name) {
    const coll = collections.get(name) ?? new Map();
    reply(res, 200, body.ids.map(String).filter((id) => coll.has(id)).map((id) => coll.get(id)));
  } else {
    reply(res, 404, "not found");
  }
}

const server = createServer((req, res) => {
  clearTimeout(req.socket.idleTimer);
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    res.on("finish", () => {
      req.socket.idleTimer = setTimeout(() => halfClose(req.socket), workerData.idleMs);
    });
    handle(req, res, Buffer.concat(chunks).toString("utf8"));
  });
});
// A non-zero keepAliveTimeout makes Node send `Keep-Alive: timeout=N`, and
// undici never reuses a socket whose hint is under its 2 s threshold.
server.keepAliveTimeout = 0;

parentPort.on("message", (msg) => {
  if (msg.type === "reset") {
    collections.clear();
    requests = [];
    close = msg.close ? { ...msg.close } : null;
    reject = msg.reject ?? null;
    parentPort.postMessage({ id: msg.id });
  } else if (msg.type === "requests") {
    parentPort.postMessage({ id: msg.id, requests });
  }
});

server.listen(0, "127.0.0.1", () => parentPort.postMessage({ port: server.address().port }));
