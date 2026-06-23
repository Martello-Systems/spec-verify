import http from 'node:http';

/** Create a widget object. */
export function createWidget(name) {
  return { name, kind: 'widget' };
}

// NOTE: the /health endpoint required by the spec is missing here.
const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end('not found');
});

export { server };
