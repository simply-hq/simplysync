#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(dirname "$SCRIPT_DIR")
COMPOSE_FILE="$ROOT_DIR/relays/go/docker-compose.yml"
RELAY_PORT=${RELAY_PORT:-4100}
HEALTH_URL="http://127.0.0.1:${RELAY_PORT}/health"

if ! command -v docker >/dev/null 2>&1; then
    printf '%s\n' "Docker is required. Install Docker Desktop or Docker Engine, then run this command again."
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    printf '%s\n' "Docker Compose is required. Update Docker, then run this command again."
    exit 1
fi

printf '%s\n' "Starting the SimplySync relay on port ${RELAY_PORT}…"
RELAY_PORT="$RELAY_PORT" docker compose -f "$COMPOSE_FILE" up -d --build

if command -v curl >/dev/null 2>&1; then
    attempts=0
    until curl --fail --silent "$HEALTH_URL" >/dev/null 2>&1; do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 20 ]; then
            printf '%s\n' "The relay started, but its health check is not ready yet."
            printf '%s\n' "Inspect it with: docker compose -f relays/go/docker-compose.yml logs"
            exit 1
        fi
        sleep 1
    done
fi

printf '\n%s\n' "Your relay is running and its data is stored in a persistent Docker volume."
printf '%s\n' "Health check: ${HEALTH_URL}"
printf '%s\n' "Next: make it reachable with Tailscale or a TLS domain, then add that URL in Settings › Sync Relays."
printf '%s\n' "Guide: https://simplyfinance.app/relay#host-your-own"
