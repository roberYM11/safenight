#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

if ! command -v docker >/dev/null 2>&1; then
    printf '%s\n' 'Docker CLI is not installed. See docs/docker.md.' >&2
    exit 127
fi
if docker compose version >/dev/null 2>&1; then
    compose_command=docker
elif command -v docker-compose >/dev/null 2>&1; then
    compose_command=docker-compose
    docker-compose version >/dev/null
else
    printf '%s\n' 'Docker Compose 2.24 or newer is required. See docs/docker.md.' >&2
    exit 127
fi

config_dir="$repo_dir/backend/var/docker"
config_file="$config_dir/compose.env"
umask 077
mkdir -p "$config_dir"
if [ ! -f "$config_file" ]; then
    password=$(openssl rand -hex 32)
    (set -C; printf 'SAFENIGHT_DB_PASSWORD=%s\n' "$password" > "$config_file")
fi
if [ "$#" -eq 0 ]; then
    set -- up --build -d --wait api
fi
if [ "$compose_command" = docker ]; then
    exec docker compose --env-file "$config_file" "$@"
fi
exec docker-compose --env-file "$config_file" "$@"
