# kid-llm — project rules

A private AI chat for one 10-year-old on her iPhone, in Hebrew. Static PWA on Vercel; no server, no database.

## Git workflow

- Every change gets its own branch from `main`, named `<type>/<short-description>` (`feat`, `fix`, `chore`, `docs`, `test`). Why: `main` is what gets deployed.
- Never commit directly to `main`; push the branch and open a pull request. Only the owner merges, after CI is green. (The only exception was the first commit, which created `main`.)
- Run `npm run lint`, `npm run typecheck` and `npm run test:coverage` before pushing. If `npm install` can't run locally, push anyway and let CI check.
- CI must be green: audit of the shipped libraries, lint, typecheck, unit tests with coverage (thresholds in `vite.config.ts`: 80% lines, statements and functions, 75% branches; 90% and 80% for `src/ai/`), build, and Playwright tests in WebKit at iPhone sizes (`e2e/`). New code arrives with its tests.
- Commit `package-lock.json` with every dependency change. If `npm install` can't run locally, push the `package.json` change to the branch: the "Update lockfile" workflow commits the lockfile there and reruns CI (never on `main`).
- Open pull requests as drafts. After every push of a pull request, a code review agent reviews it for security and for personal data (PII): where her chats, her name and the API key are stored, sent or logged. It posts its verdict and findings as a review on the pull request itself. Fix findings as new commits; never force-push. Then post one comment that lists every finding with the commit that fixed it, or why it is left to the owner.
- Deployment is Vercel's Git integration: every pull request gets a preview deployment, and `main` is production. `vercel.json` holds the build settings and the security headers; there is no deploy workflow and no deploy secret in this repository.

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
| She can't delete a chat: only "delete all" in the parent area removes chats. Her own messages are always kept; "try again" still replaces the last answer | A parent can always see what she asked (#15, #22) |
| Image requests always go with the provider's safe mode on and the fixed child-safety line. A picture is shown only when the provider's two safety headers both say it is fine; marked, or with a header missing, it is a refusal and is never shown | It's a kid's app, so a check that can't be made counts as failed |
| A picture request carries only what she wrote for that picture. Pictures are kept as bytes with their chat, on the phone only, and are left out of what chat models are sent | The provider learns no more than it needs, and a picture can't be sent as text |
| Search mode asks the provider to search the web (`enable_web_search: on`); no other mode does. A search call carries only what she wrote in search mode, and the search lines of `src/ai/baseline.ts`. "Try again" asks in the mode her message was written in. The parent area says that what she writes in search mode also reaches a search engine | She gets what she picked, what she said elsewhere stays out of a search engine, and the parent knows what leaves the phone |
| Under a search answer the app shows up to 5 links to the sites it came from, taken from the provider's list of sources: https only on the usual port, an ordinary site name (never a number address), one per site, shown by the site's name, never the page's title or text. They open outside the app with no referrer; the parent area says that nothing but the iPhone's Screen Time filters those sites. The model's own text still gives no web addresses and never becomes a link | The owner chose links (#21); a page's title and text pass no child-safety check, and a link the model wrote could point anywhere |
| Every chat call starts with the built-in instructions in `src/ai/baseline.ts`; the parent's system prompt is added after them, never instead | Her messages never reach a model with no instructions |
| An `AiError`'s `detail` is for the parent area's screen only: never stored, backed up or logged | A provider may quote part of her message in it |
| Provider calls go through one module that applies the timeout, redacts the key from errors and maps failures to reasons | One place enforces privacy and limits; a new provider only describes its request and response |
| Security headers live in `vercel.json`; the CSP's `connect-src` lists exactly the provider endpoints the app calls | Even a compromised dependency can't send her chats anywhere else |
| `.npmrc` sets `ignore-scripts=true`; libraries that ship inside the app are pinned to exact versions; GitHub Actions are pinned to commit SHAs | A hijacked package or a moved tag can't change what runs |
| Colours only through the tokens in `src/styles.css` | One place to keep contrast readable |
