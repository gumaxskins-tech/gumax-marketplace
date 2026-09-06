# Database
PostgreSQL is the authoritative datastore. Prisma schema changes are applied through reviewed migrations, never `db push` in production. Financial and audit history are append-only; user deletion must be a status/soft-delete workflow rather than cascaded deletion.
