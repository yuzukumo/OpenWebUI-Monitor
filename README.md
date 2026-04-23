<div align="center">
  
![](https://github.com/user-attachments/assets/fb90a4cc-2e54-495c-87ca-34c1a54bf2c8)

# OpenWebUI Monitor

**English** / [简体中文](./resources/tutorials/zh-cn/README_zh.md) / [Español](./resources/tutorials/es/README_es.md)

</div>

A monitoring dashboard for OpenWebUI that tracks usage and manages user balances. Simply add the bundled [function](./resources/functions/openwebui_monitor.py) to OpenWebUI to view user activity and balances in a unified panel.

> **Note**: If you are using OpenWebUI 0.5.8 or above, make sure the installed [function](./resources/functions/openwebui_monitor.py) is kept in sync with this repository.

> 💡 **Related Tool**: Auto-sync OpenAI & Claude model prices to your instance — [openwebui-monitor-sync](https://github.com/Yeraze/openwebui-monitor-sync) by [@Yeraze](https://github.com/Yeraze)

## Features

- Set prices for each model in OpenWebUI
- Charge chat and image requests based on model pricing, with end-of-chat usage notifications
- Handle newer and older OpenWebUI usage payload shapes, including `usage`, `info.usage`, and legacy token fields
- Sync the authoritative user list from OpenWebUI by stable user `id`, so renames update in place and deleted users disappear automatically
- Track both `used balance` and `remaining balance`, with an admin action to reset a user's used balance
- Keep the default user-management order aligned with the current OpenWebUI user list while preserving manual table sorting
- View user data and usage visualizations
- One-click test for all model availability
- Reproducible end-to-end validation with the official OpenWebUI slim image, PostgreSQL 18, and Chromium

## Deployment

Supports one-click deployment on Vercel [![Deploy on Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyuzukumo%2FOpenWebUI-Monitor&project-name=openwebui-monitor&repository-name=openwebui-monitor&env=OPENWEBUI_DOMAIN,OPENWEBUI_API_KEY,ACCESS_TOKEN,API_KEY) and Docker deployment.

See the [Deployment Guide](./resources/tutorials/en/deployment_guide.md) for detailed setup instructions.

### Docker Quick Start

This fork publishes its container image to GHCR:

```text
ghcr.io/yuzukumo/openwebui-monitor:latest
```

Example `docker-compose.yml`:

```yaml
services:
  openwebui-monitor:
    image: ghcr.io/yuzukumo/openwebui-monitor:latest
    ports:
      - "127.0.0.1:3003:3000"
    environment:
      - POSTGRES_HOST=${POSTGRES_HOST:-openwebui-monitor-db}
      - POSTGRES_PORT=${POSTGRES_PORT:-5432}
      - POSTGRES_USER=${POSTGRES_USER:-postgres}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-openwebui}
      - POSTGRES_DATABASE=${POSTGRES_DATABASE:-openwebui_monitor}
      - OPENWEBUI_DOMAIN=${OPENWEBUI_DOMAIN:-http://open-webui:8080}
      - OPENWEBUI_API_KEY=${OPENWEBUI_API_KEY}
      - ACCESS_TOKEN=${ACCESS_TOKEN}
      - API_KEY=${API_KEY}
      - OPENWEBUI_USERS_SYNC_INTERVAL_MS=${OPENWEBUI_USERS_SYNC_INTERVAL_MS:-30000}
    depends_on:
      openwebui-monitor-db:
        condition: service_healthy
    restart: always

  openwebui-monitor-db:
    image: postgres:18-alpine
    environment:
      - POSTGRES_USER=${POSTGRES_USER:-postgres}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-openwebui}
      - POSTGRES_DB=${POSTGRES_DATABASE:-openwebui_monitor}
    volumes:
      - postgres_data:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-postgres}"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: always

volumes:
  postgres_data:
```

> **PostgreSQL 18 note**: for fresh Postgres 18 deployments, mount `/var/lib/postgresql`, not `/var/lib/postgresql/data`.

## Updates

For this fork, every push triggers GitHub Actions to build and publish the latest GHCR image.

- Vercel: sync your fork and redeploy
- Docker: pull the latest image and restart the container

```bash
sudo docker compose pull
sudo docker compose up -d
```

## Environment Variables

### Required

| Variable Name     | Description                                                                       | Example                    |
| ----------------- | --------------------------------------------------------------------------------- | -------------------------- |
| OPENWEBUI_DOMAIN  | OpenWebUI domain                                                                  | `https://chat.example.com` |
| OPENWEBUI_API_KEY | OpenWebUI admin API key or admin JWT token, used for model fetching and user sync | `sk-xxxxxxxxxxxxxxxx`      |
| API_KEY           | For API request verification (must be less than 56 characters)                    | `your-api-key-here`        |
| ACCESS_TOKEN      | For page access verification                                                      | `your-access-token-here`   |

### Optional

| Variable Name                    | Description                                                                                                                                 | Default Value |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| POSTGRES_URL                     | PostgreSQL connection string. If set, it takes precedence over individual `POSTGRES_*` variables                                            | unset         |
| DATABASE_URL                     | Alternative PostgreSQL connection string name, used if `POSTGRES_URL` is not set                                                           | unset         |
| POSTGRES_HOST                    | PostgreSQL host                                                                                                                             | `db`          |
| POSTGRES_PORT                    | PostgreSQL port                                                                                                                             | `5432`        |
| POSTGRES_USER                    | PostgreSQL username                                                                                                                         | `postgres`    |
| POSTGRES_PASSWORD                | PostgreSQL password                                                                                                                         | unset         |
| POSTGRES_DATABASE                | PostgreSQL database name                                                                                                                    | `openwebui_monitor` |
| DEFAULT_MODEL_INPUT_PRICE        | Default model input price, in USD per million tokens                                                                                        | `60`          |
| DEFAULT_MODEL_OUTPUT_PRICE       | Default model output price, in USD per million tokens                                                                                       | `60`          |
| DEFAULT_MODEL_PER_MSG_PRICE      | Default model price for each message, in USD                                                                                                | `-1`          |
| INIT_BALANCE                     | Initial user balance                                                                                                                        | `0`           |
| COST_ON_INLET                    | Pre-deduction amount on inlet. Can be a fixed number for all models (e.g. `0.1`), or model-specific format (e.g. `gpt-4:0.32,gpt-3.5:0.01`) | `0`           |
| OPENWEBUI_USERS_SYNC_INTERVAL_MS | Interval in milliseconds for refreshing the authoritative user list from OpenWebUI on the user-management API                               | `30000`       |

## Testing

This repository includes a reproducible end-to-end test that boots PostgreSQL, the official OpenWebUI slim image, a mock OpenAI-compatible backend, and then validates the monitor with Chromium screenshots.

The E2E flow currently verifies:

- user sync from OpenWebUI by stable `id`
- rename handling without duplicate local users
- automatic removal of users deleted in OpenWebUI
- default user order matching the OpenWebUI user list
- used-balance accumulation and reset behavior
- balance editing in the user page without reloading the list
- records export and database export
- monitor UI rendering for token, home, models, users, records, and panel pages

```bash
pnpm e2e:install
pnpm e2e:owu
```

Artifacts are written to `artifacts/e2e/`, including logs, screenshots, and `summary.json`.

## Function Variable Configuration

| Variable Name | Description                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| Api Endpoint  | Fill in your deployed OpenWebUI Monitor backend domain or IP address accessible within the OpenWebUI container |
| Api Key       | Fill in the `API_KEY` environment variable set in the backend deployment                                       |
| Language      | Message display language (`en` / `zh` / `es`)                                                                  |

## FAQ

### 1. How to fill in the `OPENWEBUI_DOMAIN` environment variable?

The principle is that this address should be accessible from within the OpenWebUI Monitor container.

- It is recommended to fill in the public domain name of OpenWebUI, for example `https://chat.example.com`.
- If your OpenWebUI Monitor is deployed on the same machine, you can also fill in `http://[Docker host local ip]:[OpenWebUI backend service port]`. You can get the host's local IP through `ifconfig | grep "inet "`.
- You **cannot** fill in `http://127.0.0.1:port` or omit `http://`.

### 2. How to fill in the `Api Endpoint` function parameter?

Fill in your deployed OpenWebUI Monitor backend domain or IP address accessible within the OpenWebUI container. For example `http://[host local ip]:7878`, where `7878` is the default port for OpenWebUI Monitor.

### 3. What should I use for `OPENWEBUI_API_KEY`?

Use an **admin** OpenWebUI credential that can call the users API.

- An admin API key works
- An admin JWT token also works

If you create it from the OpenWebUI UI, use an admin account and make sure it can access the OpenWebUI users endpoints.

### 4. Why can't I see users in the user management page?

The monitor now refreshes the current OpenWebUI user list from `GET /api/v1/users/all` and matches users by stable OpenWebUI `id`, so renames update in place and users deleted in OpenWebUI disappear from the monitor automatically. If users still do not appear, check that `OPENWEBUI_API_KEY` is an admin credential that can access the OpenWebUI users API.

### 5. What is the difference between `used balance` and `remaining balance`?

- `used balance` is the cumulative amount already consumed by the user
- `remaining balance` is the current balance still available for future requests

Admins can reset a user's `used balance` to zero without changing the user's remaining balance.

<h2>Gallery</h2>

![](https://github.com/user-attachments/assets/63f23bfd-f271-41e8-a71c-2016be1d501a)
