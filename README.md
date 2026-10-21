# Postgres with extensions

The image of [Protobase](https://github.com/PrototeamHQ/protobase)'s dedicated databases:
Postgres 18 with a broad set of extensions (pg_graphql, pg_net, pgsodium, Vault, pgmq, PostGIS,
pgRouting, pgvector and more), so an app keeps its extensions when it moves. A non-superuser tenant
named `postgres` creates them through supautils, with its config and after-create scripts. It is a
plain Postgres with extensions: every app's roles, passwords, root key and settings come from
whoever runs it.

It is published as `ghcr.io/prototeamhq/postgres:<postgres minor>-<build number>`. Pin it by
digest, `ghcr.io/prototeamhq/postgres@sha256:…`, taken from the publishing run's summary, rather
than by tag.

## What it holds

The `Dockerfile`, on docker-library's `postgres:18.6-trixie`, pinned by digest:

| From | What |
|---|---|
| Postgres | The contrib modules |
| PGDG apt, versions pinned | PostGIS 3.6, pg_cron, http, hypopg, pg_partman, pg_repack, pgaudit, pgTAP, pgvector, plpgsql_check, RUM, wal2json, and pgBackRest |
| Groonga's apt, versions pinned | PGroonga |
| Upstream pg18 `.deb`s, sha256 checked | pg_graphql, pg_jsonschema, wrappers |
| Source at a pinned commit, PGXS | supautils, pg_net, Vault, pgsodium, pgmq, pg_tle, pg_stat_monitor, pg_hashids, index_advisor, pgjwt, plan_filter |
| Source at a pinned commit, cmake | pgRouting 3.8 |

`supautils/` holds `supautils.conf` and the extension scripts, copied from the
[`supabase/postgres`](https://github.com/supabase/postgres) repository at e2770ca
(`ansible/files/postgresql_config/supautils.conf.j2` and
`ansible/files/postgresql_extension_custom_scripts/`), under its PostgreSQL License
(`supautils/LICENSE`). One line differs: `postgis_tiger_geocoder/after-create.sql` creates
`tiger_data`, which PostGIS 3.6 no longer does.

Left out on purpose:
- **pgRouting 4.** PGDG ships only 4.0 for 18, and it removed functions that 3.x has,
  such as `pgr_createTopology` and `pgr_analyzeGraph`. 3.8 still has them. 3.x has no Postgres 19
  path, so at 19 the image takes 4.x.
- **timescaledb.** PGDG's Apache build would be one package plus a preload library, which runs a
  scheduler per database.
- **plv8, plls, plcoffee and old_snapshot.** plv8 would need a V8 build; the others have no
  Postgres 18 version.

## How a container runs it

The server reads `/etc/postgresql/postgresql.conf`, outside `PGDATA`, run as
`postgres -D /etc/postgresql`: initdb must not load supautils. Then:

- **Initialisation.** The image has no init scripts of its own. Start it with docker-library's
  variables, `POSTGRES_USER=supabase_admin` (supautils' superuser) and `POSTGRES_DB=postgres`, and
  your own SQL in `/docker-entrypoint-initdb.d`. That SQL creates the tenant `postgres`
  (`NOSUPERUSER NOINHERIT`), `anon`, `authenticated` and `service_role`, an `extensions`
  schema, and the login roles the tenant logs in as: `NOINHERIT`, with a connection limit, a
  `SET` grant of `postgres` and `ALTER ROLE … SET role = 'postgres'`. `test/fixtures/init` is the
  smallest such init.
- **The root key.** pgsodium and Vault read it with `getkey.sh` from
  `/run/secrets/pgsodium_root_key`, which you mount: 64 lowercase hex characters. The image never
  generates one: a key inside the container would be lost when the container is recreated, and
  every secret with it. Without the file the server does not start.
- **Logins.** `pg_hba.conf` refuses every login as `postgres`, the socket and loopback too. Acting
  as `postgres`, the tenant can give it a password, and `postgres` has no connection limit, so a
  login as it, directly or through dblink or postgres_fdw, would get round its login role's limit.
  pg_cron and pg_net run as `postgres` in background workers, which never read `pg_hba.conf`. Every
  other connection logs in with its password.
- **No privileged role.** `supautils/supautils.conf` names `supabase_privileged_role`, which the
  init never creates or grants, so supautils treats nobody as privileged. The tenant creates no
  foreign-data wrapper of wrappers, no event trigger and no publication of every table, sets none
  of `privileged_role_allowed_configs`, cannot `ALTER ROLE … SET` them for its login roles, and
  cannot `COMMENT ON EXTENSION` on an extension it does not own, which is every privileged one,
  created as `supabase_admin`. Restoring a backup with such comments can fail.
- **One app per instance.** pg_cron and pg_net serve only the `postgres` database.
- **Settings.** The extensions' preload libraries. plpgsql_check's profiler gets
  1 MB of shared memory rather than the 20 MB it takes by default. Add your own settings in
  `/etc/postgresql-custom/conf.d`, which is read last.

## Building and publishing

`.github/workflows/image.yml` builds the image and runs `test/image.test.ts` on it for every push
and pull request. On `main` it pushes `ghcr.io/prototeamhq/postgres:<postgres minor>-<build number>`,
and the run's summary shows the digest. The build takes about 4 minutes at 4 CPUs, and the image is
about 1 GB.

The test initialises the image as above and checks that, logged in as the login role `app`:
- every extension is created inside a transaction that rolls back, and inside the same transaction committed;
- pg_cron runs a job;
- pg_net gets a response;
- pgmq, Vault, PostGIS and pgRouting 3's `pgr_createTopology` work;
- every escalation path is refused, as `postgres` and as the login role, including a login as
  `postgres` with a password the tenant gave it;
- a container recreated over the same data, with the same key, still decrypts.

To run it locally, on Linux with Docker and [Bun](https://bun.sh):

```sh
docker build -t postgres-image:dev .
TEST_POSTGRES_IMAGE=postgres-image:dev bun test
```

## Bumping

- **A Postgres minor.** Change `BASE` to the new `postgres:18.x-trixie` digest. PGDG builds its
  extension packages per major, so their pins stay. A minor needs no `ALTER EXTENSION`.
- **A PGDG or Groonga package.** Change its pinned version. A rebuild never takes a new release
  unasked. When PGDG drops an old version from its pool, the build fails until the pin moves.
- **A source-built extension.** Change its commit, and the tag in its comment.
- **An upstream `.deb`.** Change its URL and sha256 together.
- **The supautils config.** Diff `supautils.conf.j2` and `postgresql_extension_custom_scripts/`
  in `supabase/postgres` against `supautils/`, and keep the tiger fix.

A database moved onto a new build takes its extensions' new versions with
`ALTER EXTENSION … UPDATE`.

## License

Apache-2.0 (`LICENSE`), except `supautils/`, which keeps its upstream PostgreSQL License.
