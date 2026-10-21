#!/bin/sh
# Builds one extension with PGXS from a pinned commit, with its patches in /patches/<name>, and
# installs it under /out.
# Usage: build-pgxs.sh <name> <github owner/repo> <commit> [subdirectory]
set -eu
name=$1 repo=$2 commit=$3 dir=${4:-.}

git init -q "/src/$name"
cd "/src/$name"
git fetch -q --depth 1 "https://github.com/$repo.git" "$commit"
git checkout -q FETCH_HEAD
for patch in /patches/"$name"/*.patch; do
  if [ -f "$patch" ]; then git apply "$patch"; fi
done
make -C "$dir" -j"$(nproc)" USE_PGXS=1
make -C "$dir" USE_PGXS=1 install DESTDIR=/out
