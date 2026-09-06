# Local development

Use npm workspaces with a supported Node.js installation. Copy `.env.example` to `.env`, set a local PostgreSQL `DATABASE_URL`, then run `npm install`, `npm run prisma:format`, `npm run prisma:validate`, `npm run prisma:generate`, `npm run typecheck`, `npm test`, and `npm run build`.

The repository intentionally contains provider abstractions only; no credentials belong in `.env.example` or source control.
