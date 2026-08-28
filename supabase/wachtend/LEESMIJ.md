# Migraties die wachten op een handeling buiten de repo

Wat hier staat is **geen migratie** zolang het hier staat: `supabase db push` kijkt alleen in
`supabase/migrations/`, en `pnpm db:status` ook. Dat is precies de bedoeling.

## Waarom dit bestaat

De pre-push-haak eist dat elke migratie in de repo ook op de database staat — met goede reden:
twee deploys strandden op een schema dat achterliep op de code. Bij een tweetrapsuitrol botst
die regel met de werkelijkheid: stap 2 kan pas ná een handeling die zelf de gepushte code
nodig heeft.

Parkeren in plaats van de haak omzeilen. Het bestand blijft in git, dus het raakt niet kwijt,
en elke poort blijft groen.

## Wat er nu wacht

### `20260828120100_workergeheim_afdwingen.sql`

Deel 2 van risico 31. Dwingt af dat elke agent-schrijfactie een geldig workergeheim meestuurt.

Verplaats hem terug naar `supabase/migrations/` zodra:

1. `20260828120000_workergeheim.sql` op de database staat
2. `node scripts/set-worker-secret.mjs` is gedraaid
3. `AGENT_WORKER_SECRET` bij de worker staat en die is uitgerold
4. de worker bij het opstarten `workergeheim: herkend` meldt

Daarna `pnpm db:push` en `git push`.

De migratie heeft zelf ook een controle: staat er geen actief workergeheim, dan breekt hij af
met de reden erbij. Die blijft staan — een toelichting is geen bewaker, en dit bestand is een
toelichting.
