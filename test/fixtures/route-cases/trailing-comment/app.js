import express from 'express';

const app = express();

app.get('/widgets', (req, res) => res.json({ widgets: [] })); // trailing note: list widgets

export { app };
