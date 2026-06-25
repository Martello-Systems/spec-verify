// Config-driven (Fastify-style) route objects: the path lives in a `url:` key.
// Must PASS route-exists path="/widgets".
export const routes = [
  { method: 'GET', url: '/widgets', handler: () => ({ widgets: [] }) },
];
