import express from 'express';

const app = express();

// A real Express route declaration: must PASS route-exists path="/widgets".
app.get('/widgets', (req, res) => {
  res.json({ widgets: [] });
});

export { app };
