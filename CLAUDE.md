# kid-llm — project rules

A private AI chat for one 10-year-old on her iPhone, in Hebrew. Static PWA on Vercel; no server, no database.

## Git workflow

- Every change gets its own branch from `main`, named `<type>/<short-description>` (`feat`, `fix`, `chore`, `docs`, `test`). Why: `main` is what gets deployed.
- Never commit directly to `main`; push the branch and open a pull request. Only the owner merges, after CI is green. (The only exception was the first commit, which created `main`.)
- Run `npm run lint`, `npm run typecheck` and `npm run test` before pushing. If `npm install` can't run locally, push anyway and let CI check.
- Commit `package-lock.json` with every dependency change. If `npm install` can't run locally, push the `package.json` change to the branch: the "Update lockfile" workflow commits the lockfile there and reruns CI (never on `main`).
- Open pull requests as drafts. A review agent reviews each one on the pull request itself. Fix findings as new commits; never force-push.

## Platform decisions

| Rule | Why |
|---|---|
| No server. The phone calls the AI provider directly | Nothing is saved on the website; the parent's key and her chats never pass through us |
| Chats are saved only on the phone | Privacy is the reason this app exists |
| The API key is kept apart from chats and is never in a backup | A backup gets shared; a key costs money |
| Hebrew, right to left; text ≥ 15 px, body 17 px; touch targets ≥ 48 px; inputs ≥ 16 px | It's for the kid; smaller inputs make Safari zoom |
| Maths, code, links and numbers with units are always left to right inside Hebrew text | Otherwise "3 + 5 = 8" and minus signs change order |
| She sees modes (שיחה, חיפוש, חשבון, ציור), never model names; the parent maps each mode to a model | She shouldn't have to know what a model is |
| The kid never sees provider messages or error codes; the parent area does | "משהו לא עובד" is enough for her |
| Parent area behind a PIN: provider, key, model per mode, system prompt, limits, backup, delete all | She can't change what keeps her safe |
| Image requests always go with the provider's safe mode on | It's a kid's app |
| Provider calls go through one module that applies the timeout, redacts the key from errors and maps failures to reasons | One place enforces privacy and limits; a new provider only describes its request and response |
| Security headers live in `vercel.json`; the CSP's `connect-src` lists exactly the provider endpoints the app calls | Even a compromised dependency can't send her chats anywhere else |
| `.npmrc` sets `ignore-scripts=true`; libraries that ship inside the app are pinned to exact versions; GitHub Actions are pinned to commit SHAs | A hijacked package or a moved tag can't change what runs |
| Colours only through the tokens in `src/styles.css` | One place to keep contrast readable |
