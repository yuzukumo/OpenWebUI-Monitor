#!/bin/sh

set -eu

POSTGRES_HOST="${POSTGRES_HOST:-db}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
POSTGRES_DATABASE="${POSTGRES_DATABASE:-openwebui_monitor}"

echo "Waiting for PostgreSQL to start..."
while ! nc -z "$POSTGRES_HOST" "$POSTGRES_PORT"; do
  sleep 1
done
echo "PostgreSQL is up!"

echo "Creating database if not exists..."
if ! PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -tc "SELECT 1 FROM pg_database WHERE datname = '$POSTGRES_DATABASE'" | grep -q 1; then
  PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -c "CREATE DATABASE $POSTGRES_DATABASE"
fi
echo "Database setup completed!"

echo "Starting application..."
node server.js &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID"
  fi
}

trap cleanup INT TERM

echo "Waiting for application to accept connections..."
while ! nc -z 127.0.0.1 "${PORT:-3000}"; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SERVER_PID"
  fi
  sleep 1
done

echo "Initializing database tables..."
curl --fail --silent --show-error "http://127.0.0.1:${PORT:-3000}/api/init" >/tmp/openwebui-monitor-init.json
cat /tmp/openwebui-monitor-init.json

wait "$SERVER_PID"
