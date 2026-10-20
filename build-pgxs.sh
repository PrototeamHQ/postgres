#!/bin/sh
# Builds one extension with PGXS from a pinned commit and installs it under /out.
# Usage: build-pgxs.sh <name> <github owner/repo> <commit> [subdirectory]
set -eu
name=$1 repo=$2 commit=$3 dir=${4:-.}

git init -q "/src/$name"
cd "/src/$name"
git fetch -q --depth 1 "https://github.com/$repo.git" "$commit"
git checkout -q FETCH_HEAD
make -C "$dir" -j"$(nproc)" USE_PGXS=1
make -C "$dir" USE_PGXS=1 install DESTDIR=/out
