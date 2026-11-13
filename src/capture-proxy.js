import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Dev capture proxy for Panda → gemini-bridge traffic.
 *
 * Usage:
 *   node src/capture-proxy.js                # listens on :8888, forwards to :3000
 *   node src/capture-proxy.js --port 9090    # custom listen port
 *   node src/capture-proxy.js --target http://host:port   # forward somewhere else
 *
 * Point the Android emulator / device HTTP proxy at 127.0.0.1:8888, then in the
 * emulator browser or app hit https://api.heypanda.org/... and the proxy will:
 *   1. log the full request (method, path, headers, body) to console + logfile
 *   2. forward to the bridge (or whatever --target you gave)
 *   3. log the response status + body preview
 *   4. return the response back to the client
 *
 * Because the app calls https://api.heypanda.org, the proxy makes an outbound
 * HTTPS request. OWNERS: this proxy trusts the upstream by default (no cert
 * verification pin). For a local dev capture that is fine; for anything real you
 * would pin cert/subject.
 */

const LOG_DIR = path.resolve(process.cwd(), 'capture-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

let listenPort = 8888;
let targetBase = 'http://127.0.0.1:3000';

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--port=')) listenPort = parseInt(arg.split('=')[1], 10);
  else if (arg.startsWith('--target=')) targetBase = arg.split('=')[1];
}

const logFile = path.join(LOG_DIR, `capture-${Date.now()}.jsonl`);
const logStream = fs.createWriteStream(logFile, { encoding: 'utf8' });

function logLine(record) {
  const line = JSON.stringify(record) + '\n';
  logStream.write(line);
  console.log('[capture]', JSON.stringify(record));
}

function headerObj(headers) {
  if (!headers) return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function bodyPreview(str) {
  if (!str) return '(no body)';
  const max = 4000;
  const json = safeJson(str);
  if (json) return JSON.stringify(json).slice(0, max);
  return str.slice(0, max);
}

function safeJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// ---- HTTP server that captures then forwards ----

const server = http.createServer(async (clientReq, clientRes) => {
  const start = Date.now();
  const method = clientReq.method;
  const incomingUrl = clientReq.url;
  const parsed = new URL(incomingUrl, `http://${clientReq.headers.host || 'localhost'}`);
  const pathOnly = parsed.pathname + parsed.search;

  // Gather request headers (lower-cased keys from node http)
  const reqHeaders = headerObj(clientReq.headers);

  // Consume the request body so we can log it and forward it
  let reqBody = '';
  try {
    for await (const chunk of clientReq) {
      reqBody += chunk.toString();
    }
  } catch {
    // client may have closed; forward empty
  }

  const reqRecord = {
    ts: new Date().toISOString(),
    direction: 'REQUEST',
    listenPort,
    targetBase,
    clientIp: clientReq.socket.remoteAddress,
    clientPort: clientReq.socket.remotePort,
    method,
    path: pathOnly,
    hostHeader: reqHeaders.host || null,
    effectiveHost: clientReq.headers.host || null,
    requestHeaders: reqHeaders,
    requestBodyPreview: bodyPreview(reqBody),
    requestBodyFull: reqBody.slice(0, 200000) || null, // cap logged full body
  };

  logLine(reqRecord);

  // Decide upstream URL and whether to use HTTPS
  const upstreamUrl = new URL(parsed.pathname + parsed.search, targetBase);
  const useHttps = upstreamUrl.protocol === 'https:';
  const opts = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (useHttps ? 443 : 80),
    path: upstreamUrl.pathname + upstreamUrl.search,
    method: clientReq.method,
    headers: {
      // Forward most client headers, but replatform Host to the upstream host.
      ...reqHeaders,
      host: upstreamUrl.host,
    },
    // If client sent a body, forward it with the right content-type
    ...(reqBody && reqBody.length > 0 ? { content: reqBody } : {}),
  };

  // Remove hop-by-hop headers that can confuse the upstream
  delete opts.headers['connection'];
  delete opts.headers['keep-alive'];
  delete opts.headers['transfer-encoding'];

  const proxyStart = Date.now();

  function forwardError(msg, code = 502) {
    logLine({
      ts: new Date().toISOString(),
      direction: 'FORWARD_ERROR',
      path: pathOnly,
      error: msg,
    });
    clientRes.writeHead(code, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ error: msg, captured: true }));
  }

  // Make the upstream request, honouring https vs http
  const doRequest = useHttps ? https.request : http.request;

  // node https.request accept `content` for body in older docs; safer to use
  // a concat approach. Build the request and write body explicitly.
  const upstreamReq = doRequest(opts, (upstreamRes) => {
    const resStatus = upstreamRes.statusCode;
    const resHeaders = headerObj(upstreamRes.headers);
    let resBody = '';

    upstreamRes.on('data', (chunk) => {
      resBody += chunk.toString();
    });

    upstreamRes.on('end', () => {
      const elapsed = Date.now() - start;
      const resRecord = {
        ts: new Date().toISOString(),
        direction: 'RESPONSE',
        path: pathOnly,
        upstreamStatus: resStatus,
        upstreamHeaders: resHeaders,
        responseBodyPreview: bodyPreview(resBody),
        responseBodyFull: resBody.slice(0, 200000) || null,
        latencyMs: elapsed,
        forwardLatencyMs: Date.now() - proxyStart,
      };
      logLine(resRecord);

      // Mirror upstream status + headers back to the client
      clientRes.writeHead(resStatus, resHeaders);
      clientRes.end(resBody);
    });

    upstreamRes.on('error', (err) => {
      forwardError(`upstream response error: ${err.message}`);
    });
  });

  upstreamReq.on('error', (err) => {
    forwardError(`upstream connect error: ${err.message}`);
  });

  // Write request body if present
  if (reqBody && reqBody.length > 0) {
    upstreamReq.write(reqBody);
  }
  upstreamReq.end();
});

server.on('error', (err) => {
  console.error('[capture] server error:', err.message);
  process.exit(1);
});

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`
Gemini bridge capture proxy
  listen  : http://127.0.0.1:${listenPort}
  forward : ${targetBase}
  logfile : ${logFile}

Steps to see exactly what Panda sends:
  1. Run the bridge:   node src/server.js
  2. Run this proxy:   node src/capture-proxy.js
  3. In Android emulator: Settings > Proxy > Manual, host=127.0.0.1, port=8888
     (or set the host's system proxy if testing on a real device on the same LAN)
  4. In the app, trigger a Gemini message.
  5. Watch this console / read ${logFile} for the REQUEST record.
     Look for the header that carries the user's Gemini key:
       x-custom-gemini-key
       x-provider-api-key
       x-provider
       x-provider-model
`);
});
