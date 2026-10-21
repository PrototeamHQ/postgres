-- The tenant's login role, as protobase-cloud's instanceLoginRole creates it: it acts as postgres
-- without inheriting its privileges, within a connection limit of its own.
create role app login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 5 password 'app';
grant postgres to app with inherit false, set true;
alter role app set role = 'postgres';
