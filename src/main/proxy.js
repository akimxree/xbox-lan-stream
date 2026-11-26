'use strict';

/**
 * Tiny loopback HTTP proxy for the xHome control plane.
 *
 * The renderer speaks to 127.0.0.1 only. This process adds the bearer token and
 * forwards /v5/* and /v6/* to Microsoft's regional xHome endpoint. Keeping the
 * token out of the renderer also keeps it out of DevTools/network dumps.
 */

const http = require('node:http');

const MAX_BODY = 2 * 1024 * 1024;

function cors(req, res) {
  // file:// documents send `Origin: null`. Do not use `*`: a random website
  // must not be able to drive this authenticated loopback proxy.
  const origin = req.headers.origin;
  if (!origin || origin === 'null' || origin === 'file://') {
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, X-MS-Device-Info, X-Gssv-Client');
  res.setHeader('Access-Control-Max-Age', '600');
}

function localHost(req) {
  const host = String(req.headers.host || '');
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {import('./auth').AuthManager} auth
 */
function startProxy(auth) {
  const server = http.createServer(async (req, res) => {
    cors(req, res);

    if (!localHost(req)) {
      json(res, 403, { error: 'Loopback proxy only' });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');

    try {
      if (url.pathname === '/api/health') {
        json(res, 200, { ok: true, auth: auth.snapshot() });
        return;
      }

      if (url.pathname === '/api/msal') {
        const lpt = await auth.getMsalToken();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(lpt);
        return;
      }

      if (!/^\/(v5|v6)\//.test(url.pathname)) {
        json(res, 404, { error: 'Not found' });
        return;
      }

      let { token, baseUri } = await auth.getAuth();
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);

      const headers = (bearer) => {
        const value = {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Gssv-Client': 'XboxComBrowser',
          Authorization: `Bearer ${bearer}`,
          'Cache-Control': 'no-cache',
        };
        if (req.headers['x-ms-device-info']) {
          value['X-MS-Device-Info'] = String(req.headers['x-ms-device-info']);
        }
        return value;
      };

      let upstream = await fetch(baseUri + url.pathname + url.search, {
        method: req.method,
        headers: headers(token),
        body,
        signal: AbortSignal.timeout(45_000),
      });

      // gsToken lives for about an hour. Refresh once and replay the request.
      if (upstream.status === 401) {
        await auth.refresh();
        ({ token, baseUri } = await auth.getAuth());
        upstream = await fetch(baseUri + url.pathname + url.search, {
          method: req.method,
          headers: headers(token),
          body,
          signal: AbortSignal.timeout(45_000),
        });
      }

      const responseBody = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'Content-Length': responseBody.length,
        'Cache-Control': 'no-store',
      });
      res.end(responseBody);
    } catch (err) {
      const status = /Not authenticated/.test(String(err && err.message)) ? 503 : 502;
      json(res, status, {
        error: 'xhome_proxy_error',
        message: String((err && err.message) || err),
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: address.port,
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startProxy };