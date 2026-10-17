# Tikshortis

A vertical short-video library: a swipe feed, creator profiles, playlists, tags,
an import folder, an auto-poller and a duplicate scanner.

It was the `/shorts` section of [elite-v2](https://github.com/tjelite1986/elite-v2)
until 2026-08-30, when the main channel was extracted into this app. The 18+
channel deliberately stayed behind — see [The split](#the-split).

Nothing here names the machine it runs on: the hostnames, the media roots and
the address of the app it borrows its login from all come from the environment.

---

## What it is

| | |
|---|---|
| Stack | Next 15 (App Router), React 19, Tailwind, better-sqlite3 + Kysely |
| Database | one SQLite file, `DATA_DIR/tikshortis.db` |
| Media | on disk, under `SHORTS_ROOT` and `PROFILE_ROOT` — never in the database |
| Accounts | its own, made by hand (see [Sign-in](#sign-in)) |
| Dev | `npm run dev` → :3040 |

### Pages

| Path | |
|---|---|
| `/` | the immersive feed — swipe, like, comment, save, share |
| `/explore` | the whole library as a grid |
| `/profiles`, `/profile/<id>` | creators, and one creator's clips |
| `/person/<handle>` | everything one handle covers, across merged aliases |
| `/playlists`, `/playlists/<id>` | saved collections |
| `/tags`, `/tag/<tag>` | hashtags as a catalogue and as a grid |
| `/mine` | the viewer's own uploads, public and private |
| `/analysis` | vision summaries, when a model key is configured |
| `/upload` | one clip at a time |
| `/grab` | pull a clip from a URL (admin) |
| `/settings` | Sources, Import, Duplicates, Cleaning, Titles (admin) |

---

## Sign-in

The app keeps its own accounts, in `users` and `sessions` in its own database.
Until elite-v2 was shut down it borrowed that app's login; the `users` rows were
already keyed by **elite-v2's own ids** — the same integers the migrated rows
carry — so they became the real accounts in place, and the password hashes came
across unchanged (scrypt, `salt:key`, `lib/password.ts`).

A session is a random token in an HttpOnly, host-only cookie
(`tikshortis_session`, 30 days); only its SHA-256 is stored. A signed-out
visitor gets the sign-in form on whatever page they opened, and lands back on it
signed in. `POST /api/auth/login` counts failures per address and per email
(10 per 15 minutes, in memory) and answers an unknown email in the same time as
a wrong password.

**There is no sign-up page.** Accounts are made with `scripts/users.cjs`, which
runs inside the container and travels on stdin:

```bash
docker exec -i tikshortis node - list                             < scripts/users.cjs
docker exec -i -e PASSWORD=… tikshortis node - add <email> [admin] < scripts/users.cjs
docker exec -i -e PASSWORD=… tikshortis node - passwd <email>      < scripts/users.cjs
```

`remove` takes the password away and ends the sessions but keeps the row: likes,
uploads and playlists are keyed on its id.

### Writes

The session cookie is host-only, but `SameSite=lax` still sends it with a
request from any page on the parent domain — every page on that domain is the
same site. So `middleware.ts` refuses any non-GET request whose `Origin` is
not this host. Two ways past it, both deliberate: a matching Origin, or
`x-admin-token` (the host timers, which are not browsers and hold a credential
no page can read). **`ADMIN_TOKEN` unset means closed, never open.**

---

## The split

The 18+ channel stayed in elite-v2, with its PIN gate. Everything here is the
`main` channel and nothing can change that: `CHANNEL` in `lib/shorts.ts` is a
constant, the feed filters on it, and the import script no longer reads
`IMPORT_CHANNEL`. The `channel` column survives in the schema because the
storage keys and the maintenance scripts resolve paths through it.

Consequences worth knowing:

- **A clip can be handed over, one way.** "Hand over to 18+" drops the file into
  elite-v2's shorts import folder (`HANDOVER_18PLUS_DIR`) with the bracket
  naming grammar its importer parses, and soft-deletes the row here. That app's
  timer files it minutes later. Nothing comes back except through elite-v2's own
  tools. Writing into another app's database from here was the alternative, and
  it would have made two apps owners of one schema.
- **The adult category buckets are gone.** `straight/gay/lesbian/trans/solo`
  sorted the 18+ library; there is nothing to sort here.
- **Sharing is a link.** elite-v2's share sheet also listed every account, to
  send the clip as a direct message. There is no inbox here to deliver one to.
- **The person graph collapsed.** elite-v2 resolved a handle across users, post
  creators and shorts profiles through a `profile_links` table. Here a person has
  two faces, so `lib/people.ts` resolves a handle through
  `short_profile_aliases` — the merge this app already records.

### Both apps are live, on purpose

elite-v2 keeps its own `/shorts` section running against its own copy of the
rows, by choice. The two libraries diverge from the migration onward, and only
one of them is fed:

| | feeds | serves |
|---|---|---|
| Tikshortis | import, transcode, poll, dupescan, cleanup (main) | main |
| elite-v2 | import, transcode, dupescan, cleanup (18+) | 18+, **and its frozen copy of main** |

`elitev2-shorts-import-main.timer` and `elitev2-shorts-poll.timer` are
**disabled**. Both polling the same twelve profiles would have downloaded every
new clip twice, once into each database, with two copies on disk.

---

## Deploy

```bash
cd <compose dir>
docker compose build && docker compose up -d
```

An image build, not a bind mount: `better-sqlite3` and `sharp` are native and
must be compiled against the image's glibc, and the maintenance scripts run
inside this container (`docker exec`, from the timers) so they need the runtime
`node_modules` and the `ffmpeg` the image carries.

### Storage

Four bind mounts, named by the container path they land on. What they are on
the host is a deployment detail and lives in the compose file, not here.

| In the container | |
|---|---|
| `/shorts-store/main` | the library. Mount **only** the main channel — the 18+ tree is deliberately left out, so this app cannot read a library it does not serve |
| `/profile-store` | per-user uploads, shared with elite-v2: the migrated storage keys already point into that tree |
| `/import-store` | per-user drop tree |
| `/handover-18plus` | elite-v2's own shorts import folder. One-way, for the handover above |

### Timers

Installed from `deploy/systemd/`. Each runs a script inside the container.

| Unit | Every | |
|---|---|---|
| `tikshortis-import` | 5 min | sort `main/_import/` into creator folders |
| `tikshortis-transcode` | 3 min | `pending` → `.web.mp4` → `ready` |
| `tikshortis-poll` | 30 min | fetch new clips for `auto_poll` profiles |
| `tikshortis-dupescan` | nightly 05:10 | group duplicates for review; deletes nothing |
| `tikshortis-cleanup` | hourly | drop rows whose file is gone, purge emptied playlists |

The unit files ship with `User=CHANGEME` — substitute the account that may talk
to the docker socket before installing them. Left as-is, systemd refuses to
start the unit rather than quietly running it as root.

**A clip dropped in `_import` is invisible for up to eight minutes**, and that
proves nothing about whether it arrived: the importer inserts it `pending`, and
every listing query filters `status = 'ready'`, which the transcoder sets. Check
the row and the disk before concluding anything was lost.

---

## Migration

```bash
docker exec tikshortis node scripts/migrate-from-elitev2.mjs /tmp/src.db
```

Ids are preserved — a storage key, a like's `user_id` and a playlist's contents
all reference ids from the other side. It is idempotent (`INSERT OR IGNORE`) and
never deletes: a re-run is a top-up, not a mirror.

The source **must** be a snapshot taken with SQLite's `.backup()`. elite-v2 runs
in WAL mode, and a plain `cp` of the `.db` without its `-wal` produces a file
that opens fine and reports zero rows.

What came across on the first run: 4 186 clips, 701 creator profiles, 26 likes,
1 playlist (3 of its 22 items — the rest were 18+ clips), 4 170 fingerprint-cache
rows, 12 duplicate-group rows, 7 accounts.

---

## One thing that changed on the way over

**Dismissing a duplicate group now works.** In elite-v2 the button wrote to a
shared `media_dupe_dismissals` table that the shorts scanner never read, so the
group came back on the next nightly run. Here the pairs live in
`short_dupe_dismissals` and `scripts/scan-shorts-duplicates.mjs` skips them.

---

## Environment

| | |
|---|---|
| `APP_URL` | this app's own address, for links that leave it and come back |
| `ADMIN_TOKEN` | the timers' credential. Unset = the write routes refuse them |
| `SHORTS_ROOT`, `PROFILE_ROOT`, `IMPORT_ROOT` | media roots |
| `HANDOVER_18PLUS_DIR` | elite-v2's import folder. Unset = the handover row reports it is unreachable |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` | vision summaries. Neither = the Analysis page says so |
| `YT_DLP_BIN` | bind-mounted from the host, so it updates without an image rebuild |
