const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 4000;
const WEBHOOK_SECRET = process.env.PLANE_WEBHOOK_SECRET || '';
const ALLOWED_PROJECT_ID = process.env.ALLOWED_PROJECT_ID || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://tareas.orem.com.mx';

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

    if (!/^workitem\./.test(evt.event || '')) return;

    const projectId = evt.data && (evt.data.project_id || evt.data.project);
    if (ALLOWED_PROJECT_ID && projectId && projectId !== ALLOWED_PROJECT_ID) return;

    broadcast({
      event: evt.event,
      entity_id: evt.entity_id,
      project_id: projectId,
      at: Date.now(),
    });
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

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method === 'GET' && req.url === '/events') {
    handleEvents(req, res);
    return;
  }
  if (req.method === 'POST' && req.url === '/notify') {
    handleNotify(req, res);
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`plane-relay listening on ${PORT}`);
});
