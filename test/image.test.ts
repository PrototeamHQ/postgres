import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { docker, must, probeDocker } from './docker'

// The image as the workflow built it (README.md#how-a-container-runs-it): initialised with the
// tenant `postgres`, no superuser, which creates every extension through supautils, and its login
// role `app`, which acts as it; the extensions with workers, keys and hooks work. The data sits on a volume, so the container can be
// recreated over it with the same mounted root key.
const IMAGE = process.env.TEST_POSTGRES_IMAGE
const availability = IMAGE
  ? probeDocker()
  : {
      ok: false as const,
      reason: 'TEST_POSTGRES_IMAGE is not set: point it at a built image',
    }
if (!availability.ok) console.warn(`[skip] postgres image: ${availability.reason}`)
const skip = !availability.ok

// The responder pg_net calls: busybox nc answering one request, printing it to its log.
const RESPONDER_IMAGE =
  'docker.io/library/alpine:3.21@sha256:ce64758a109eb420d874a118f87920e625e12d3634e03b4a5573fd9f6e5d3507'
const INIT = join(import.meta.dir, 'fixtures', 'init')
const ROOT_KEY = 'a1'.repeat(32)
const LOGIN = 'app'

// Each psql runs through `docker exec`, which takes a second or more on a busy runner.
setDefaultTimeout(60_000)

const id = `pgimage-${process.pid}-${Date.now()}`
const network = id
const volume = id
const responder = `${id}-responder`
let container = `${id}-1`
let keyDir: string

// Every extension the image carries, in an order that creates each one's
// dependencies first. Those with a schema of their own are created without `schema extensions`,
// as their after-create scripts expect.
const OWN_SCHEMA = new Set([
  'pg_cron',
  'pgmq',
  'pg_tle',
  'pgsodium',
  'supabase_vault',
  'pg_net',
  'postgis_tiger_geocoder',
  'postgis_topology',
  'pg_graphql',
  'wrappers',
  'pg_partman',
  'amcheck',
])
const EXTENSIONS = [
  'amcheck',
  'autoinc',
  'bloom',
  'btree_gin',
  'btree_gist',
  'citext',
  'cube',
  'dblink',
  'dict_int',
  'dict_xsyn',
  'earthdistance',
  'fuzzystrmatch',
  'hstore',
  'insert_username',
  'intarray',
  'isn',
  'lo',
  'ltree',
  'moddatetime',
  'pg_buffercache',
  'pg_prewarm',
  'pg_stat_statements',
  'pg_trgm',
  'pg_walinspect',
  'pgcrypto',
  'pgrowlocks',
  'pgstattuple',
  'postgres_fdw',
  'refint',
  'seg',
  'sslinfo',
  'tablefunc',
  'tcn',
  'tsm_system_rows',
  'tsm_system_time',
  'unaccent',
  'uuid-ossp',
  'postgis',
  'postgis_raster',
  'postgis_sfcgal',
  'postgis_topology',
  'postgis_tiger_geocoder',
  'address_standardizer',
  'address_standardizer_data_us',
  'pgrouting',
  'http',
  'hypopg',
  'index_advisor',
  'pg_cron',
  'pg_partman',
  'pg_repack',
  'pgaudit',
  'pgtap',
  'plpgsql_check',
  'rum',
  'vector',
  'pgroonga',
  'pgroonga_database',
  'pg_graphql',
  'pg_jsonschema',
  'wrappers',
  'pg_net',
  'pgsodium',
  'supabase_vault',
  'pgmq',
  'pg_tle',
  'pg_stat_monitor',
  'pg_hashids',
  'pgjwt',
]
const CREATE_ALL = EXTENSIONS.map(
  (name) =>
    `create extension if not exists "${name}"${OWN_SCHEMA.has(name) ? '' : ' schema extensions'} cascade;`,
).join('\n')

// psql in the container over TCP, as a client from outside would log in.
const psql = (sql: string, user = LOGIN, password = LOGIN) =>
  docker(
    [
      'exec',
      '-i',
      '-e',
      `PGPASSWORD=${password}`,
      container,
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-w',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-U',
      user,
      '-d',
      'postgres',
      '-f',
      '-',
    ],
    sql,
  )

const tenant = (sql: string) => {
  const result = psql(sql)
  if (result.code !== 0) throw new Error(`psql exited with ${result.code}: ${result.stderr}`)
  return result.stdout.trim()
}

const refused = (sql: string, reason?: string) => {
  const result = psql(sql)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('ERROR')
  if (reason) expect(result.stderr).toContain(reason)
}

const until = async (what: string, check: () => boolean, seconds = 30) => {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(250)
  }
  const logs = docker(['logs', container])
  throw new Error(
    `timed out waiting for ${what}; ${container}'s log:\n${logs.stdout}${logs.stderr}`,
  )
}

const start = (name: string, withKey: boolean) =>
  must([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    network,
    '-e',
    'POSTGRES_USER=supabase_admin',
    '-e',
    'POSTGRES_PASSWORD=admin',
    '-e',
    'POSTGRES_DB=postgres',
    '-v',
    `${volume}:/var/lib/postgresql`,
    '-v',
    `${INIT}:/docker-entrypoint-initdb.d:ro`,
    ...(withKey ? ['-v', `${join(keyDir, 'root.key')}:/run/secrets/pgsodium_root_key:ro`] : []),
    IMAGE as string,
  ])

const startReady = async (name: string) => {
  container = name
  start(name, true)
  await until('the server to accept the tenant', () => psql('select 1').code === 0, 120)
}

describe.skipIf(skip)('postgres image', () => {
  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'pgimage-'))
    await writeFile(join(keyDir, 'root.key'), `${ROOT_KEY}\n`, { mode: 0o644 })
    must(['network', 'create', network])
    must(['volume', 'create', volume])
    must([
      'run',
      '-d',
      '--name',
      responder,
      '--network',
      network,
      RESPONDER_IMAGE,
      'sh',
      '-c',
      `printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 5\\r\\nConnection: close\\r\\n\\r\\nhello' | nc -l -p 8080`,
    ])
    await startReady(container)
  }, 180_000)

  afterAll(async () => {
    for (const name of [`${id}-1`, `${id}-2`, `${id}-3`, responder]) docker(['rm', '-f', name])
    docker(['volume', 'rm', '-f', volume])
    docker(['network', 'rm', '-f', network])
    if (keyDir) await rm(keyDir, { recursive: true, force: true })
  })

  test('the login role acts as the tenant, no superuser, and logs in only with its password', () => {
    expect(tenant('select current_user, session_user, current_setting($$is_superuser$$)')).toBe(
      'postgres|app|off',
    )
    const wrong = psql('select 1', LOGIN, 'wrong')
    expect(wrong.code).not.toBe(0)
    expect(wrong.stderr).toContain('password authentication failed')
    const socket = docker([
      'exec',
      container,
      'psql',
      '-X',
      '-w',
      '-U',
      'supabase_admin',
      '-c',
      'select 1',
    ])
    expect(socket.code).not.toBe(0)
    expect(socket.stderr).toContain('password')
  })

  test('every extension is available', () => {
    const available = tenant('select name from pg_available_extensions').split('\n')
    expect(EXTENSIONS.filter((name) => !available.includes(name))).toEqual([])
  })

  test('the tenant creates every extension in a transaction that rolls back', () => {
    tenant(`begin;\n${CREATE_ALL}\nrollback;`)
    expect(tenant(`select count(*) from pg_extension where extname <> 'plpgsql'`)).toBe('0')
  })

  test('the same transaction committed creates them all', () => {
    tenant(`begin;\n${CREATE_ALL}\ncommit;`)
    const created = tenant('select extname from pg_extension').split('\n')
    expect(EXTENSIONS.filter((name) => !created.includes(name))).toEqual([])
  })

  test('pg_cron runs a job', async () => {
    tenant(`create table ticks (at timestamptz default now());
      select cron.schedule('tick', '1 seconds', 'insert into ticks default values');`)
    // pg_cron records a run as succeeded only after the job's own transaction commits.
    await until(
      'a succeeded cron run',
      () => tenant(`select count(*) from cron.job_run_details where status = 'succeeded'`) !== '0',
    )
    expect(tenant('select count(*) > 0 from ticks')).toBe('t')
    expect(
      tenant(`select string_agg(distinct j.username, ',') from cron.job j
        join cron.job_run_details d using (jobid) where d.status = 'succeeded'`),
    ).toBe('postgres')
    tenant(`select cron.unschedule('tick')`)
  })

  test('pg_net sends a request', async () => {
    const request = tenant(`select net.http_get('http://${responder}:8080/from-pg-net')`)
    await until(
      'the response',
      () => tenant(`select count(*) from net._http_response where id = ${request}`) === '1',
    )
    expect(
      tenant(`select status_code || ' ' || content from net._http_response where id = ${request}`),
    ).toBe('200 hello')
    expect(must(['logs', responder])).toContain('GET /from-pg-net')
  })

  test('pgmq sends and reads a message', () => {
    tenant(`select pgmq.create('jobs'); select pgmq.send('jobs', '{"n": 1}')`)
    expect(tenant(`select message->>'n' from pgmq.read('jobs', 30, 1)`)).toBe('1')
  })

  test('Vault keeps a secret', () => {
    tenant(`select vault.create_secret('s3cr3t', 'api_key')`)
    expect(
      tenant(`select decrypted_secret from vault.decrypted_secrets where name = 'api_key'`),
    ).toBe('s3cr3t')
  })

  test('PostGIS measures a distance', () => {
    const metres = Number(
      tenant(
        `select round(st_distance('SRID=4326;POINT(4.90 52.37)'::geography, 'SRID=4326;POINT(4.48 51.92)'::geography))`,
      ),
    )
    expect(metres).toBeGreaterThan(55_000)
    expect(metres).toBeLessThan(65_000)
  })

  // pgRouting 3.x: 4.0 removed pgr_createTopology, which apps may call.
  test('pgRouting builds a topology and routes over it', () => {
    expect(
      tenant(`create table edges (id bigint primary key, source bigint, target bigint, cost float8, the_geom geometry(linestring));
        insert into edges (id, cost, the_geom) values (1, 1, 'LINESTRING(0 0, 1 0)'), (2, 1, 'LINESTRING(1 0, 2 0)');
        set client_min_messages = error;
        select pgr_createTopology('edges', 0.001, 'the_geom', 'id');
        select max(agg_cost) from pgr_dijkstra('select id, source, target, cost from edges', 1, 3);`),
    ).toBe('OK\n2')
  })

  // The escalation paths a tenant might try.
  describe('the tenant cannot escalate', () => {
    test('dblink to the superuser without its password', () => {
      refused(`select dblink_connect('c', 'host=127.0.0.1 dbname=postgres user=supabase_admin')`)
      refused(
        `select dblink_connect('c', 'host=/var/run/postgresql dbname=postgres user=supabase_admin')`,
      )
    })

    test('dblink_connect_u', () => {
      refused(`select dblink_connect_u('c', 'host=127.0.0.1 dbname=postgres user=supabase_admin')`)
    })

    test('postgres_fdw to the superuser, with or without SCRAM pass-through', () => {
      tenant(`create server loopback foreign data wrapper postgres_fdw options (host '127.0.0.1', dbname 'postgres');
        create user mapping for postgres server loopback options (user 'supabase_admin');
        create foreign table superuser_roles (rolname name) server loopback options (schema_name 'pg_catalog', table_name 'pg_roles');
        create server passthrough foreign data wrapper postgres_fdw options (host '127.0.0.1', dbname 'postgres', use_scram_passthrough 'true');
        create user mapping for postgres server passthrough options (user 'supabase_admin', use_scram_passthrough 'true');
        create foreign table passthrough_roles (rolname name) server passthrough options (schema_name 'pg_catalog', table_name 'pg_roles');`)
      refused('select * from superuser_roles')
      refused('select * from passthrough_roles')
    })

    test('superuser, server file access, replication role and reserved roles', () => {
      refused('alter role postgres superuser')
      refused('grant pg_read_server_files to postgres')
      refused('set session_replication_role = replica', 'permission denied to set parameter')
      refused(`alter role anon set statement_timeout = '1s'`)
      refused('create extension file_fdw')
    })

    // patches/supautils/alter-role-all.patch: unpatched, supautils crashed the backend on both, and
    // the server restarted every process. In one database it is ALTER DATABASE … SET, which the
    // tenant owns.
    test('settings for all roles, without crashing the server', () => {
      refused('alter role all set search_path = public', 'permission denied to alter setting')
      tenant(`alter role all in database postgres set work_mem = '8MB'`)
      expect(
        tenant(`select array_to_string(setconfig, ',') from pg_db_role_setting
          where setrole = 0 and setdatabase = (select oid from pg_database where datname = 'postgres')`),
      ).toContain('work_mem=8MB')
      tenant('alter role all in database postgres reset work_mem')
    })

    // The login role holds only its own role and postgres's; a password the tenant gives postgres
    // never logs in, since pg_hba.conf rejects every login as postgres.
    test('a login as postgres with a password the tenant gave it', () => {
      expect(
        tenant(`set role none; select string_agg(rolname, ',' order by rolname) from pg_roles
          where rolcanlogin and pg_has_role('app', oid, 'SET')`),
      ).toBe('app,postgres')
      tenant(`alter role postgres password 'pw'`)
      const direct = psql('select 1', 'postgres', 'pw')
      expect(direct.code).not.toBe(0)
      expect(direct.stderr).toContain('pg_hba.conf rejects')
      for (const target of [
        'host=/var/run/postgresql dbname=postgres',
        'host=127.0.0.1 dbname=postgres',
        'host=/var/run/postgresql dbname=template1',
      ]) {
        refused(
          `select dblink_connect('c', '${target} user=postgres password=pw')`,
          'pg_hba.conf rejects',
        )
      }
      tenant(`create server as_postgres_socket foreign data wrapper postgres_fdw options (host '/var/run/postgresql', dbname 'postgres');
        create user mapping for postgres server as_postgres_socket options (user 'postgres', password 'pw');
        create foreign table as_postgres_socket_roles (rolname name) server as_postgres_socket options (schema_name 'pg_catalog', table_name 'pg_roles');
        create server as_postgres_tcp foreign data wrapper postgres_fdw options (host '127.0.0.1', dbname 'postgres');
        create user mapping for postgres server as_postgres_tcp options (user 'postgres', password 'pw');
        create foreign table as_postgres_tcp_roles (rolname name) server as_postgres_tcp options (schema_name 'pg_catalog', table_name 'pg_roles');`)
      refused('select * from as_postgres_socket_roles', 'pg_hba.conf rejects')
      refused('select * from as_postgres_tcp_roles', 'pg_hba.conf rejects')
    })

    test('role attributes, connection limits, replication, databases and roles', () => {
      expect(tenant('set role none; select current_user, session_user')).toBe('app|app')
      for (const attribute of [
        'replication',
        'createdb',
        'createrole',
        'bypassrls',
        'superuser',
        'connection limit -1',
      ]) {
        refused(`alter role app ${attribute}`, 'permission denied to alter role')
      }
      refused('alter role postgres connection limit -1', 'permission denied to alter role')
      refused(
        `alter role postgres password 'pw' valid until 'infinity'`,
        'permission denied to alter role',
      )
      refused(
        'set role none; alter role app connection limit -1',
        'permission denied to alter role',
      )
      refused('grant postgres to app with inherit true', 'permission denied to grant role')
      refused('grant postgres to app with admin option', 'permission denied to grant role')
      for (const prefix of ['', 'set role none; ']) {
        refused(
          `${prefix}select pg_create_physical_replication_slot('hold', true)`,
          'permission denied to use replication slots',
        )
      }
      refused('create database other', 'permission denied to create database')
      refused('create role evil login', 'permission denied to create role')
    })

    // supabase_privileged_role does not exist, so supautils lets nobody do what it would allow.
    test('foreign-data wrappers, event triggers, publications and superuser parameters', () => {
      expect(tenant(`select to_regproc('duckdb_fdw_handler') is not null`)).toBe('t')
      refused(
        'create foreign data wrapper duckdb_test handler duckdb_fdw_handler validator duckdb_fdw_validator',
        'permission denied to create foreign-data wrapper',
      )
      refused(
        'create foreign data wrapper evil',
        'permission denied to create foreign-data wrapper',
      )
      tenant('create function noop_evt() returns event_trigger language plpgsql as $$begin end$$')
      refused(
        'create event trigger noop on ddl_command_end execute function noop_evt()',
        'permission denied to create event trigger',
      )
      refused('create publication everything for all tables', 'must be superuser')
      refused(
        `alter system set archive_command = 'touch /tmp/x'`,
        'permission denied to set parameter',
      )
      refused(
        `alter database postgres set session_replication_role = 'replica'`,
        'permission denied to set parameter',
      )
    })

    // As postgres, ALTER ROLE app fails on the role; as app itself, on the parameter.
    for (const [as, prefix, alterRoleReason] of [
      ['postgres', '', 'permission denied to alter role'],
      ['the login role', 'set role none; ', 'permission denied to set parameter'],
    ]) {
      test(`server files, programs and superuser parameters as ${as}`, () => {
        refused(`${prefix}select pg_read_file('postgresql.conf')`, 'permission denied for function')
        refused(`${prefix}copy (select 1) to program 'id'`, 'permission denied to COPY')
        refused(`${prefix}select lo_import('/etc/passwd')`, 'permission denied for function')
        refused(`${prefix}select lo_export(0, '/tmp/x')`, 'permission denied for function')
        refused(`${prefix}alter role app set session_replication_role = 'replica'`, alterRoleReason)
      })
    }
  })

  test('the root key comes from the mounted file, so a recreated container decrypts', async () => {
    must(['rm', '-f', container])
    await startReady(`${id}-2`)
    expect(
      tenant(`select decrypted_secret from vault.decrypted_secrets where name = 'api_key'`),
    ).toBe('s3cr3t')
  }, 150_000)

  test('without the key file the server does not start', async () => {
    must(['rm', '-f', container])
    container = `${id}-3`
    start(container, false)
    await until(
      'the container to stop',
      () => must(['inspect', '-f', '{{.State.Running}}', container]).trim() === 'false',
      60,
    )
    expect(must(['inspect', '-f', '{{.State.ExitCode}}', container]).trim()).not.toBe('0')
    const logs = docker(['logs', container])
    expect(logs.stdout + logs.stderr).toContain('/run/secrets/pgsodium_root_key')
  }, 90_000)
})
