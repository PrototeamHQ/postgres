#!/bin/sh
# Prints the pgsodium and Vault root key from the mounted file. The key is never
# generated here: one in the container's filesystem would be lost when the container is recreated,
# and every secret with it. Without the file the server does not start.
set -eu
key_file=/run/secrets/pgsodium_root_key

key=$(cat "$key_file")
if [ "${#key}" -ne 64 ] || [ -n "$(printf '%s' "$key" | tr -d '0-9a-f')" ]; then
  echo "$key_file must hold the root key as 64 lowercase hex characters" >&2
  exit 1
fi
printf '%s\n' "$key"
