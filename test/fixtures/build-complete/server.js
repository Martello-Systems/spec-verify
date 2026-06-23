import http from 'node:http';

/** Create a widget object. */
export function createWidget(name) {
  return { name, kind: 'widget' };
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end('not a widget route');
});

export { server };
