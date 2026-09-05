# Development

1. Copy `.env.example` to `.env` and provide a local PostgreSQL connection string.
2. Install dependencies with a supported npm version.
3. Run `npm run db:generate`, `npm run db:validate`, and `npm run typecheck`.

No production provider credentials belong in this repository. The schema is intentionally migration-ready; create Prisma migrations against the target PostgreSQL environment once dependencies are installed.
