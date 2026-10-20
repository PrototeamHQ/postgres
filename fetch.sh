#!/bin/sh
# Downloads a file into the current directory and stops unless it has the pinned sha256.
# Usage: fetch.sh <url> <sha256>
set -eu
url=$1 sha256=$2

file=${url##*/}
curl -fsSLo "$file" "$url"
echo "$sha256  $file" | sha256sum -c -
