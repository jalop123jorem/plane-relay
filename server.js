const http = require('http');
const net = require('net');
const crypto = require('crypto');

const https = require('https');

const PORT = process.env.PORT || 4000;
const WEBHOOK_SECRET = process.env.PLANE_WEBHOOK_SECRET || '';
const ALLOWED_PROJECT_ID = process.env.ALLOWED_PROJECT_ID || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://tareas.orem.com.mx';
const PLANE_ORIGIN = process.env.PLANE_ORIGIN || 'http://plane_plane-proxy-1:80';

// Reenvío al listener de dev-harness (tools/plane-tidy-hook.mjs) que desasigna la card en
// segundos cuando se cierra -- ver dev-harness/docs/METODOLOGIA.md "Limpieza de
// Done/Cancelled". URL completa CON el secreto de path incluido (mismo secreto que espera el
// listener, sembrado ahí vía Bitwarden/bws-seed.mjs -- este proceso NUNCA lo genera ni lo
// valida, solo lo reenvía tal cual se lo dieron). Sin definir, el reenvío se salta por completo
// -- esta pieza es opcional y no debe romper el proxy/SSE si no está configurada.
//   ej: http://172.18.0.1:8788/<secreto-del-listener>
const PLANE_TIDY_HOOK_URL = process.env.PLANE_TIDY_HOOK_URL || '';
const PLANE_TIDY_HOOK_TIMEOUT_MS = Number(process.env.PLANE_TIDY_HOOK_TIMEOUT_MS || 5000);

const clients = new Set();

function verifySignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(line);
}

/** Fire-and-forget al listener local de dev-harness. Un listener caído/lento NUNCA debe tumbar
 * este proceso ni retrasar la respuesta a Plane -- ya se respondió 200 antes de llamar esto
 * (ver handleNotify), y el reconciliador diario (plane-tidy.mjs --aplicar) es la red de
 * seguridad si esto se pierde. */
function forwardToTidyHook(payload) {
  if (!PLANE_TIDY_HOOK_URL) return;
  let url;
  try {
    url = new URL(PLANE_TIDY_HOOK_URL);
  } catch (e) {
    console.error('[tidy-hook] PLANE_TIDY_HOOK_URL invalida:', e.message);
    return;
  }
  const data = JSON.stringify(payload);
  const mod = url.protocol === 'https:' ? https : http;
  const q = mod.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: PLANE_TIDY_HOOK_TIMEOUT_MS,
    },
    (r) => r.resume() // no nos importa la respuesta -- ya le respondimos a Plane
  );
  q.on('timeout', () => q.destroy());
  q.on('error', (e) => console.error('[tidy-hook] error reenviando:', e.message));
  q.write(data);
  q.end();
}

function handleNotify(req, res) {
  let body = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooBig) return;
    const signature = req.headers['x-plane-signature'];
    if (!verifySignature(body, signature)) {
      res.writeHead(401).end();
      return;
    }
    // Responder rapido: Plane reintenta con backoff si no ve 2xx pronto.
    res.writeHead(200).end();

    let evt;
    try {
      evt = JSON.parse(body);
    } catch {
      return;
    }

    // Plane CE manda "issue" a secas (nombre plano V1), no "workitem.updated" como
    // documenta developers.plane.so/dev-tools/intro-webhooks -- confirmado con logging
    // temporal el 2026-08-24 contra esta instancia (v1.4.1).
    const isWorkItemEvent = /^workitem\./.test(evt.event || '') || /^issue\.?/.test(evt.event || '');
    if (!isWorkItemEvent) return;

    const projectId = evt.data && (evt.data.project_id || evt.data.project);
    if (ALLOWED_PROJECT_ID && projectId && projectId !== ALLOWED_PROJECT_ID) return;

    // `entity_id` a nivel raíz del evento no existe en esta instancia (Plane CE v1.4.1) -- el id
    // de la card viene en `data.id`. El broadcast SSE llevaba `entity_id: undefined` desde el
    // 2026-08-24 (bug encontrado 2026-09-02 al construir el reenvío de abajo, que sí necesita el
    // id correcto). Un `undefined` no rompe nada del lado del cliente (nadie lo leía todavía),
    // pero tampoco servía para nada.
    const entityId = evt.data && evt.data.id;

    console.log('[notify]', JSON.stringify({ event: evt.event, action: evt.action, entity_id: entityId, project_id: projectId }));

    broadcast({
      event: evt.event,
      entity_id: entityId,
      project_id: projectId,
      at: Date.now(),
    });

    // dev-harness/tools/plane-tidy-hook.mjs decide solo si esto amerita algo -- aquí no se
    // filtra por estado ni se intenta saber si es un cierre, sería duplicar esa política. Se
    // reenvía TODO work-item event que pasó el filtro de proyecto de arriba.
    if (entityId) forwardToTidyHook({ project_id: projectId, issue_id: entityId });
  });
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  });
  res.write('\n');
  clients.add(res);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

// Se inyecta en cada documento HTML que sirve Plane (via handleProxy) para que
// el aviso de "hay cambios" llegue a todos los usuarios sin instalar nada del
// lado del cliente -- reemplaza al userscript de Tampermonkey.
const INJECT_CLIENT_JS = `(function () {
  'use strict';
  function currentProjectId() {
    var m = location.pathname.match(/projects\\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }
  function showBanner() {
    if (document.getElementById('plane-relay-banner')) return;
    var bar = document.createElement('div');
    bar.id = 'plane-relay-banner';
    bar.textContent = 'Hay cambios nuevos en Plane — clic para actualizar';
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
      'background:#3b82f6', 'color:#fff', 'text-align:center',
      'padding:8px', 'font:14px sans-serif', 'cursor:pointer',
    ].join(';');
    bar.onclick = function () { location.reload(); };
    document.body.appendChild(bar);
  }
  function connect() {
    var es = new EventSource('/__plane-relay/events');
    es.onmessage = function (e) {
      var payload;
      try { payload = JSON.parse(e.data); } catch (err) { return; }
      var cur = currentProjectId();
      if (!cur || payload.project_id === cur) showBanner();
    };
    es.onerror = function () {
      es.close();
      setTimeout(connect, 5000);
    };
  }
  connect();
})();`;

function injectIntoHtml(html) {
  const tag = '<script src="/__plane-relay/inject.js"></script>';
  return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag;
}

// Reverse proxy transparente hacia el proxy interno de Plane (mismo host,
// misma red overlay de Easypanel) -- solo reescribe el documento HTML para
// meter el listener de SSE. Todo lo demas (API, assets, uploads) pasa igual.
function handleProxy(req, res) {
  const target = new URL(req.url, PLANE_ORIGIN);
  // Host header SIN tocar: Plane valida ALLOWED_HOSTS/CSRF_TRUSTED_ORIGINS contra
  // tareas.orem.com.mx, igual que cuando Traefik le pega directo (PassHostHeader).
  const headers = { ...req.headers };
  delete headers['accept-encoding']; // texto plano, asi la inyeccion no tiene que degzipear

  // El nginx de Plane sirve el index.html con ETag/Last-Modified y SIN Cache-Control.
  // Si dejamos pasar la peticion condicional, contesta 304 sin cuerpo -> el navegador
  // reusa SU copia cacheada, que es la de ANTES de que existiera la inyeccion, y el
  // script nunca llega (medido el 2026-08-24: asi es como se veia "no funciona").
  // Para las navegaciones (Accept: text/html) quitamos los condicionales y forzamos
  // un 200 con cuerpo para poder inyectar. Los assets (hasheados) siguen cacheando.
  const wantsHtml = (req.headers.accept || '').includes('text/html');
  if (wantsHtml) {
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
  }

  const proxyReq = http.request(
    { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers },
    (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';
      if (!contentType.includes('text/html')) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        return;
      }
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const body = injectIntoHtml(Buffer.concat(chunks).toString('utf8'));
        const outHeaders = { ...proxyRes.headers };
        delete outHeaders['content-length'];
        delete outHeaders['transfer-encoding'];
        // El ETag/Last-Modified de arriba describen el archivo de nginx, no lo que
        // acabamos de reescribir -- dejarlos pasar revive el bug del 304. El shell
        // pesa ~6 KB y es una SPA, no vale la pena cachearlo.
        delete outHeaders['etag'];
        delete outHeaders['last-modified'];
        outHeaders['cache-control'] = 'no-store';
        outHeaders['content-length'] = Buffer.byteLength(body);
        res.writeHead(proxyRes.statusCode, outHeaders);
        res.end(body);
      });
    },
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('bad gateway');
  });
  req.pipe(proxyReq);
}

function handleUpgrade(req, socket, head) {
  const target = new URL(req.url, PLANE_ORIGIN);
  const proxySocket = net.connect(target.port || 80, target.hostname, () => {
    let rawHeaders = `${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      rawHeaders += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    rawHeaders += `\r\n`;
    proxySocket.write(rawHeaders);
    if (head && head.length) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxySocket.on('error', () => socket.destroy());
  socket.on('error', () => proxySocket.destroy());
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method === 'GET' && (req.url === '/events' || req.url === '/__plane-relay/events')) {
    handleEvents(req, res);
    return;
  }
  if (req.method === 'GET' && req.url === '/__plane-relay/inject.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' }).end(INJECT_CLIENT_JS);
    return;
  }
  if (req.method === 'POST' && req.url === '/notify') {
    handleNotify(req, res);
    return;
  }
  handleProxy(req, res);
});

server.on('upgrade', handleUpgrade);

server.listen(PORT, () => {
  console.log(`plane-relay listening on ${PORT}`);
});
