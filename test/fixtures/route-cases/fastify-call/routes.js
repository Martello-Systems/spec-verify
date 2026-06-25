import Fastify from 'fastify';

const fastify = Fastify();

// Fastify's route() takes a config object carrying both method and path.
// route-exists path="/widgets" must PASS.
fastify.route({ method: 'post', path: '/widgets', handler: async () => ({ ok: true }) });

export { fastify };
