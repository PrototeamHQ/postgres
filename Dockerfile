# Postgres 18 with its extensions (README.md): docker-library's postgres image, PGDG's packages,
# Groonga's pgroonga, the upstream pg18 builds of pg_graphql, pg_jsonschema and wrappers, and source
# builds of the rest. Every source is pinned.
ARG BASE=docker.io/library/postgres:18.6-trixie@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336

# Extensions PGDG does not package for 18, built with PGXS against the base image's own server headers.
FROM ${BASE} AS pgxs
RUN apt-get update && apt-get install -y --no-install-recommends \
      "postgresql-server-dev-18=${PG_VERSION}" build-essential git ca-certificates \
      libcurl4-openssl-dev libsodium-dev libicu-dev flex bison \
    && rm -rf /var/lib/apt/lists/*
COPY build-pgxs.sh /usr/local/bin/build-pgxs
RUN build-pgxs supautils supabase/supautils 42d491cd2519d763918527760151f9e6bd5c9f23 # v3.4.4
RUN build-pgxs pg_net supabase/pg_net 698fb055f666366a78c112b0578b0a5652ddbcfa # v0.20.4
RUN build-pgxs supabase_vault supabase/vault 6e0cd916242d922a646e4d611cc215e09dd429f4 # v0.3.1
RUN build-pgxs pgsodium michelp/pgsodium 54c06acf3ad06cc5c9c77d350cf58c7c25052454 # v3.1.8
RUN build-pgxs pgmq pgmq/pgmq 7fd411d8ffd53b5313039f59167124c861d46430 pgmq-extension # v1.5.1
RUN build-pgxs pg_tle aws/pg_tle 5b953dd51161a02e4c4e22860ecaaef137649777 # v1.5.2
RUN build-pgxs pg_stat_monitor percona/pg_stat_monitor bcd345a8738c412bb0626e34cd6c34857d5a1924 # 2.3.1
RUN build-pgxs pg_hashids iCyberon/pg_hashids cd0e1b31d52b394a0df64079406a14a4f7387cd6 # no release tag
RUN build-pgxs index_advisor supabase/index_advisor d37723555e6425f18e6a45cb0956ced2250a3fe7 # v0.2.0
RUN build-pgxs pgjwt michelp/pgjwt f3d82fd30151e754e19ce5d6a06c71c20689ce3d # no release tag
RUN build-pgxs plan_filter pgexperts/pg_plan_filter 5081a7b5cb890876e67d8e7486b6a64c38c9a492 # no release tag

# pgRouting 3.8, the last 3.x: PGDG's 4.0 removed functions 3.x has, such as pgr_createTopology.
FROM ${BASE} AS pgrouting
RUN apt-get update && apt-get install -y --no-install-recommends \
      "postgresql-server-dev-18=${PG_VERSION}" build-essential cmake libboost-graph-dev git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; git init -q /src; cd /src; \
    git fetch -q --depth 1 https://github.com/pgRouting/pgrouting.git e7108597bf99fe725bb1c00b1e3125e9ba691aee; \
    git checkout -q FETCH_HEAD; mkdir build; cd build; \
    cmake .. -DPOSTGRESQL_PG_CONFIG=/usr/lib/postgresql/18/bin/pg_config; \
    make -j"$(nproc)"; make install DESTDIR=/out

# The upstream pg18 builds of the pgrx extensions, and Groonga's apt source, checked against pinned sums.
# The .debs keep their control and SQL files in /var/lib/postgresql/extension, which is a VOLUME in
# the base image, behind symlinks in the extension directory: the real files are copied instead.
FROM ${BASE} AS downloads
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY fetch.sh /usr/local/bin/fetch
WORKDIR /downloads
RUN fetch https://github.com/supabase/pg_graphql/releases/download/v1.6.2/pg_graphql-v1.6.2-pg18-amd64-linux-gnu.deb \
      271063ea2b8f99e00458473aa3b0e6dc0f88d341b2269401dc0b55a77b23970d
RUN fetch https://github.com/supabase/pg_jsonschema/releases/download/v0.3.4/pg_jsonschema-v0.3.4-pg18-amd64-linux-gnu.deb \
      5c7fe6c810835e4242fb0365b57581c0009b0155200dd4f1266cee434295732f
RUN fetch https://github.com/supabase/wrappers/releases/download/v0.6.3/wrappers-v0.6.3-pg18-amd64-linux-gnu.deb \
      d1c4024110843908a5e5152d209eec132bbd694d8b39ae3a4dd1cade117d4888
RUN set -eu; for f in *.deb; do dpkg-deb -x "$f" /deb; done; \
    mkdir -p /out/usr/lib/postgresql/18/lib /out/usr/share/postgresql/18/extension; \
    cp -L /deb/usr/lib/postgresql/18/lib/* /out/usr/lib/postgresql/18/lib/; \
    cp -L /deb/usr/share/postgresql/18/extension/* /out/usr/share/postgresql/18/extension/
RUN fetch https://packages.groonga.org/debian/pool/trixie/main/g/groonga-apt-source/groonga-apt-source_2026.04.28-1_all.deb \
      3406de4b8965c44a0e793090efbb0996a1802930159e7aa3f31c97dbef127c34

FROM ${BASE}
LABEL org.opencontainers.image.source=https://github.com/PrototeamHQ/postgres \
      org.opencontainers.image.licenses=Apache-2.0
COPY --from=downloads /downloads/groonga-apt-source_2026.04.28-1_all.deb /tmp/
# Extension packages are pinned, so a rebuild never takes a new release unasked. The libraries the
# source builds link (libsodium, libcurl) follow Debian's security updates.
RUN set -eu; apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates /tmp/groonga-apt-source_2026.04.28-1_all.deb; \
    apt-get update; \
    apt-get install -y --no-install-recommends libsodium23 libcurl4t64 \
      postgresql-18-pgdg-pgroonga=4.1.0-1 libgroonga0=16.1.4-1 \
      postgresql-18-postgis-3=3.6.4+dfsg-2.pgdg13+1 postgresql-18-postgis-3-scripts=3.6.4+dfsg-2.pgdg13+1 \
      postgresql-18-cron=1.6.8-1.pgdg13+2 \
      postgresql-18-http=1.7.2-2.pgdg13+2 \
      postgresql-18-hypopg=1.4.3-1.pgdg13+2 \
      postgresql-18-partman=5.5.0-1.pgdg13+1 \
      postgresql-18-pgaudit=18.0-3.pgdg13+1 \
      postgresql-18-pgtap=1.3.4-1.pgdg13+1 \
      postgresql-18-pgvector=0.8.7-1.pgdg13+1 \
      postgresql-18-plpgsql-check=2.10.13-1.pgdg13+1 \
      postgresql-18-repack=1.5.3-1.pgdg13+2 \
      postgresql-18-rum=1.3.15-1.pgdg13+1 \
      postgresql-18-wal2json=2.6-4.pgdg13+1 \
      pgbackrest=2.59.3-1.pgdg13+1; \
    apt-get purge -y groonga-apt-source; \
    rm -rf /var/lib/apt/lists/* /tmp/groonga-apt-source_2026.04.28-1_all.deb
COPY --from=pgxs /out/ /
COPY --from=pgrouting /out/ /
COPY --from=downloads /out/ /

# The server reads its settings from /etc/postgresql, outside PGDATA: initdb must not load supautils,
# whose before-create hook cannot run during bootstrap.
COPY postgresql.conf pg_hba.conf /etc/postgresql/
COPY supautils/supautils.conf /etc/postgresql-custom/supautils.conf
COPY supautils/extension-custom-scripts /etc/postgresql-custom/extension-custom-scripts
COPY --chmod=0755 getkey.sh /usr/lib/postgresql/bin/pgsodium_getkey.sh
RUN mkdir -p /etc/postgresql-custom/conf.d && chown -R postgres:postgres /etc/postgresql /etc/postgresql-custom
CMD ["postgres", "-D", "/etc/postgresql"]
