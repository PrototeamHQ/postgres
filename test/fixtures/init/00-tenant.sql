-- The smallest init (README.md#how-a-container-runs-it), run by the bootstrap superuser
-- supabase_admin. The tenant is named postgres because the after-create scripts and pg_net.username
-- grant to that name.
create role postgres login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password 'tenant';
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
grant anon, authenticated, service_role to postgres with inherit false, set true;
alter database postgres owner to postgres;
create schema extensions authorization postgres;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter role postgres set search_path = "$user", public, extensions;
