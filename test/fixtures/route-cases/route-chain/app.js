import express from 'express';

const app = express();

// Express route-chain form: the path is on .route(), methods are chained.
// route-exists path="/widgets" must PASS.
app
  .route('/widgets')
  .get((req, res) => res.json({ widgets: [] }))
  .post((req, res) => res.status(201).json({ ok: true }));

export { app };
