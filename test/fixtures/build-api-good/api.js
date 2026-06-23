import express from 'express';

const app = express();

// POST /orders — create an order. (declared via the Express router form)
app.post('/orders', (req, res) => {
  res.status(201).json({ ok: true });
});

/** Calculate the order total, applying any discount. */
export function calculateTotal(items, discount = 0) {
  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  return subtotal - discount;
}

export { app };
