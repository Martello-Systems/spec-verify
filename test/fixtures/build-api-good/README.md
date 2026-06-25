# Orders API

A small orders service.

## Authentication

Send a bearer token in the `Authorization` header on every request:

    Authorization: Bearer <token>

Unauthenticated requests receive a 401.

## Endpoints

- `POST /orders`: create an order
