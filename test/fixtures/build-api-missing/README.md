# Orders API

A small orders service. Supports an optional discount on each order.

## Authentication

Send a bearer token in the `Authorization` header on every request:

    Authorization: Bearer <token>

Unauthenticated requests receive a 401.
