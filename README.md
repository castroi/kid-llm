# kid-llm

A simple, private AI chat for one 10-year-old on her iPhone, in Hebrew.

- Static web app (PWA). No server and no database: nothing is saved on the website.
- Chats are saved only on her iPhone.
- She picks a mode (שיחה, חיפוש, חשבון, ציור); the parent decides which model is behind each mode.
- The parent area (behind a PIN) holds the AI provider, the API key, the system prompt and the limits. The first provider is Venice AI.

Working name of the app: בינלי (not final).

## Checks and deployment

- `npm run lint`, `npm run typecheck`, `npm run test:coverage`, `npm run test:e2e`. CI runs all of them on every pull request, plus an audit of the shipped libraries.
- Dependabot opens weekly pull requests for library and GitHub Actions updates.
- Deployment: import this repository once in Vercel (framework: Vite). After that every pull request gets a preview URL and every merge to `main` goes to production. Turn on Vercel's "Deployment Protection" for previews, so only you can open them.

Project rules are in `CLAUDE.md`.
