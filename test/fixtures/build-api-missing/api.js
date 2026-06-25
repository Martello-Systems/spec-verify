import express from 'express';

const app = express();

// The spec required POST /orders and an exported calculateTotal helper.
// This build silently shipped only a read endpoint and an internal,
// non-exported total function: both omissions MUST be flagged.
app.get('/orders/:id', (req, res) => {
  res.json({ id: req.params.id });
});

function computeSum(items) {
  return items.reduce((sum, it) => sum + it.price * it.qty, 0);
}

export { app, computeSum };
