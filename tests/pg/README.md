# Tests against a real Postgres

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/anything yarn test:pg
```

`DATABASE_URL` only says which server. The tests run in a database of their
own, `ecosy_orm_test`, created on first run, and its `public` schema is wiped
before every file — they create and drop tables, `_migrations` included, and
must never be pointed at an application's database. The role needs `CREATEDB`
the first time.

They test the built package in `dist/`, the thing that ships, so `test:pg`
builds first.

Why not unit tests with a mocked driver: nearly everything here is about what
Postgres does with what the ORM sends — how it rewrites a default, which
constraint a DELETE trips, what a partial index is called back as. A mock
would only repeat the ORM's own assumptions back to it.
