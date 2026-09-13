# The public stats service

Optional. The app works without it, and by default it is not there at all.

- **Without it** — the Stats screen and `/stats/` both work, on whatever is
  saved in that browser. Nothing is uploaded, nothing is public, and the app is
  exactly what it was before this existed.
- **With it** — a pilot can choose to publish, gets a page anyone with the link
  can open, and appears on a leaderboard.

A Cloudflare Worker and a D1 database. Both fit inside the free tier for any
club-sized use.

## What it stores, and what it does not

| Stored | Not stored |
|---|---|
| A uuid the browser generated | Any email address |
| The display name the pilot typed | Any password |
| Lap times, channel, finishing position | Any IP address of a pilot |
| SHA-256 of a secret the browser keeps | The secret itself |

There are no accounts. The browser generates a uuid and a 256-bit secret when
somebody agrees to publish, keeps both, and sends the secret with each request.
Only its hash is stored, so this database cannot be used to impersonate anyone
in it.

**That is also the limit of the model.** The secret is the only proof of
ownership, so a pilot who clears their browser storage can no longer rename or
delete their own page. The app says so, in those words, before anyone agrees to
anything. As the operator you can always delete a row by hand.

## Deploy it

You need a Cloudflare account and `npx wrangler`.

```bash
cd stats-service

# 1. Create the database, and paste the id it prints into wrangler.toml
npx wrangler d1 create whooptimer-stats

# 2. Create the tables
npx wrangler d1 execute whooptimer-stats --file=./schema.sql --remote

# 3. Deploy
npx wrangler deploy
```

Then tell the app where it lives. In `static/js/publish.js`:

```js
export const SERVICE_URL = 'https://whooptimer-stats.<your-subdomain>.workers.dev';
```

Commit that and the site picks it up on the next deploy. Until you do, the
constant is empty and publishing is off for everybody — which is the correct
default, because publishing to a service that does not exist should not be
offered.

### Testing against a local worker first

```bash
npx wrangler dev --local
```

Then, in the browser console on the app, point that one browser at it without
editing anything:

```js
localStorage.setItem('wt.statsService', JSON.stringify('http://127.0.0.1:8787'))
```

That override only affects the browser you type it in, which is what makes it
safe to leave the shipped constant empty.

## The API

| | |
|---|---|
| `GET /v1/pilots` | The leaderboard. Public. |
| `GET /v1/pilots/:id` | One pilot's full record. Public. |
| `POST /v1/sessions` | Publish one session. Needs the secret. |
| `POST /v1/pilots/rename` | Change the display name. Needs the secret. |
| `POST /v1/pilots/delete` | Remove the pilot and every lap. Needs the secret. |

Aggregation is not reimplemented here. The worker imports `aggregate()` from
`static/js/aggregate.js` — the same function the app runs — because two
implementations of "which laps count" would eventually disagree, and the
disagreement would be a pilot's public page contradicting their own phone.

## Tests

```bash
node stats-service/test/test_worker.mjs
```

Runs the real handler against a D1 that lives in an array. It covers the parts
that matter for an endpoint open to the internet: that a secret actually gates a
rename and a delete, that somebody else's uuid is refused rather than absorbed,
that a delete removes the lap times and not just the name on them, that a name
means the same thing on the server as it did in the browser, and that the
validation refuses futures, negatives, five hundred laps and a session dated
next week.

## Moderation

There is no report button and no automated filtering. A display name is free
text from the internet, and if somebody publishes something you do not want on
your leaderboard, remove it:

```bash
npx wrangler d1 execute whooptimer-stats --remote \
  --command "DELETE FROM sessions WHERE pilot_id = 'the-uuid';
             DELETE FROM pilots   WHERE id       = 'the-uuid';"
```

Run a public leaderboard knowing that is the whole of the tooling.

## Costs

A session row is a few hundred bytes. A club of twenty pilots flying weekly for
a year is on the order of twenty thousand rows and a few megabytes — far inside
the D1 free tier. The leaderboard and pilot pages are cached for sixty seconds
at the edge, so reads do not scale with viewers.
