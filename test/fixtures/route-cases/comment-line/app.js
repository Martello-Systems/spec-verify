import express from 'express';

const app = express();

// app.get('/widgets', handler)  <- the route is only described in this comment;
// it was never actually wired up. route-exists must report FAIL.

export { app };
