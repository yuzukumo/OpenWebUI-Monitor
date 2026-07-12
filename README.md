<div align="center">

![](https://github.com/user-attachments/assets/fb90a4cc-2e54-495c-87ca-34c1a54bf2c8)

# OpenWebUI Monitor

**English** / [简体中文](./resources/tutorials/zh-cn/README_zh.md)

</div>

A usage-monitoring and balance-management dashboard for OpenWebUI. Install the bundled [filter function](./resources/functions/openwebui_monitor.py) in OpenWebUI to record model usage, calculate costs, and manage user balances from one panel.

> **Compatibility:** This fork follows the current OpenWebUI API instead of maintaining compatibility with old releases. The integration was last verified against OpenWebUI `v0.10.2`. Update the installed function whenever you update Monitor.

## Features

- Select token-based or per-request billing independently for each model
- Configure input and output prices plus a per-model multiplier for token billing
- Configure one fixed price for per-request billing; token prices and multipliers are ignored in this mode
- Store balances and costs as integer millionths and display six decimal places
- Read current OpenWebUI usage payloads and omit large image data before sending billing requests
- Synchronize the authoritative OpenWebUI user list by stable user ID, including renames, deletions, and list order
- Track used and remaining balances, adjust remaining balance, and reset used balance independently
- Synchronize billing settings from base models to derived models and proxy current model icons from OpenWebUI
- Test model availability, inspect usage records and charts, and import or export database backups
- Validate the Monitor UI and OpenWebUI API contract with PostgreSQL 18 and Chromium E2E tests

## Deployment

This fork publishes multi-architecture images for `linux/amd64` and `linux/arm64` to:

```text
ghcr.io/yuzukumo/openwebui-monitor:latest
```

### Docker Compose

The repository [docker-compose.yml](./docker-compose.yml) is the maintained Compose configuration:

```bash
git clone https://github.com/yuzukumo/OpenWebUI-Monitor.git
cd OpenWebUI-Monitor
cp .env.example .env
# Edit .env and set the required variables listed below.
docker compose pull
docker compose up -d
```

The default Monitor address on the Docker host is `http://127.0.0.1:3003`. `OPENWEBUI_DOMAIN` must be reachable from the Monitor container, while the function's `Api Endpoint` must be reachable from the OpenWebUI container. Put both services on a shared Docker network or use addresses routable between them.

For a fresh PostgreSQL 18 deployment, mount the volume at `/var/lib/postgresql`, as configured in this repository. An existing PostgreSQL 17-or-earlier data directory cannot be upgraded by only changing the image tag; migrate it with `pg_upgrade`, or remove the old volume only when its data is no longer needed.

See the [Deployment Guide](./resources/tutorials/en/deployment_guide.md) for Vercel, external PostgreSQL, function installation, and update instructions.

### Vercel

[![Deploy on Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyuzukumo%2FOpenWebUI-Monitor&project-name=openwebui-monitor&repository-name=openwebui-monitor&env=OPENWEBUI_DOMAIN,OPENWEBUI_API_KEY,ACCESS_TOKEN,API_KEY)

Vercel deployment requires a PostgreSQL provider exposed through `POSTGRES_URL` or `DATABASE_URL`. The OpenWebUI instance must also be reachable from the Vercel deployment.

## Environment Variables

### Required

| Variable            | Description                                                                         | Example                    |
| ------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| `OPENWEBUI_DOMAIN`  | OpenWebUI base URL reachable from Monitor                                           | `https://chat.example.com` |
| `OPENWEBUI_API_KEY` | OpenWebUI admin API key or admin JWT used for model, icon, test, and user APIs      | `sk-xxxxxxxxxxxxxxxx`      |
| `API_KEY`           | Shared secret used by the OpenWebUI function when calling Monitor inlet/outlet APIs | `generated-random-secret`  |
| `ACCESS_TOKEN`      | Shared secret used to sign in to Monitor and authorize dashboard APIs               | `another-random-secret`    |

OpenWebUI API keys must be enabled. If endpoint restrictions are enabled in OpenWebUI, the credential must be allowed to access the model, model-icon, chat-completions, and users endpoints. The credential must belong to an administrator because user synchronization calls `GET /api/v1/users/all`.

### Optional

| Variable                           | Description                                                                                              | Default             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------- |
| `POSTGRES_URL`                     | PostgreSQL connection string; takes precedence over individual `POSTGRES_*` variables                    | unset               |
| `DATABASE_URL`                     | Fallback PostgreSQL connection string when `POSTGRES_URL` is unset                                       | unset               |
| `POSTGRES_HOST`                    | PostgreSQL host                                                                                          | `db`                |
| `POSTGRES_PORT`                    | PostgreSQL port                                                                                          | `5432`              |
| `POSTGRES_USER`                    | PostgreSQL user                                                                                          | `postgres`          |
| `POSTGRES_PASSWORD`                | PostgreSQL password                                                                                      | unset               |
| `POSTGRES_DATABASE`                | PostgreSQL database                                                                                      | `openwebui_monitor` |
| `DEFAULT_MODEL_INPUT_PRICE`        | Default input price per 1M tokens for new models                                                         | `60`                |
| `DEFAULT_MODEL_OUTPUT_PRICE`       | Default output price per 1M tokens for new models                                                        | `60`                |
| `DEFAULT_MODEL_PER_MSG_PRICE`      | Default per-request price; a negative value makes new models use token billing                           | `-1`                |
| `INIT_BALANCE`                     | Initial remaining balance assigned to a newly synchronized user                                          | `0`                 |
| `COST_ON_INLET`                    | Optional inlet pre-deduction, either one value or model-specific values such as `gpt-4:0.32,gpt-4o:0.01` | `0`                 |
| `OPENWEBUI_USERS_SYNC_INTERVAL_MS` | Minimum interval between OpenWebUI user-list refreshes                                                   | `30000`             |

## Billing

For token billing, the configured input and output prices are the model prices per 1M tokens. The model multiplier is applied to both prices:

```text
effective price = configured price x model multiplier
```

When the multiplier is not `1`, the model page shows the calculated price as the primary value and places the configured price beneath it in smaller struck-through text. For per-request billing, Monitor charges the fixed per-request price and does not apply the multiplier.

Token billing multiplies the configured prices, model multiplier, and token counts as fixed-point integers, then rounds once when producing the final six-decimal charge. All monetary values are persisted at six-decimal precision. Changing the interface language only changes the displayed currency symbol; it does not perform currency conversion.

## Function Configuration

Create a filter function in OpenWebUI from [openwebui_monitor.py](./resources/functions/openwebui_monitor.py), then configure:

| Valve          | Description                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Api Endpoint` | Monitor base URL reachable from the OpenWebUI container, such as `http://openwebui-monitor-app:3000` on a shared Docker network |
| `Api Key`      | The same value as Monitor's `API_KEY`                                                                                           |
| `Language`     | Status-message language: `en` or `zh`                                                                                           |

Enable the function globally so normal chat requests pass through its inlet, stream, and outlet hooks. Per-request billing uses a completed outlet callback instead of completion-token count, so a valid image response is charged even when it reports zero output tokens. The function tracks explicit stream errors because some custom Pipes can route an SSE error through outlet; those failures, and cancelled responses that never reach outlet, are not charged. An explicitly configured `COST_ON_INLET` pre-charge is a separate exception.

## Updates

Every push to this fork runs GitHub Actions and publishes the multi-architecture `latest` image to GHCR. To update a Docker deployment:

```bash
docker compose pull
docker compose up -d
```

When the bundled function changes, replace the installed OpenWebUI function with the current repository version as part of the same update.

## Testing

The default E2E test first checks the filter's success/failure state handling without starting OpenWebUI, then starts PostgreSQL 18, a mock OpenWebUI server, the real Monitor application, and Chromium in desktop and mobile viewports. It validates zero-token request billing, the Monitor UI, current OpenWebUI API calls, user synchronization, model pricing, billing precision, model icons, database migration, and balance operations.

```bash
pnpm e2e:install
pnpm e2e:owu
```

The slower full test starts the official `ghcr.io/open-webui/open-webui:latest-slim` image:

```bash
pnpm e2e:owu:full
```

Artifacts are written to the ignored `artifacts/e2e/` directory.

## FAQ

### Why are no users shown?

Monitor synchronizes users from `GET /api/v1/users/all`. Confirm that `OPENWEBUI_DOMAIN` is reachable and that `OPENWEBUI_API_KEY` is an administrator credential allowed to call that endpoint. Users are matched by their OpenWebUI ID, so renaming a user does not create a duplicate and deleting a user removes it from the Monitor list on the next synchronization.

### What is the difference between used and remaining balance?

Used balance is the cumulative amount already consumed. Remaining balance is the amount available for future requests. Resetting used balance does not change remaining balance.

### Where are model icons stored?

Monitor does not persist model icons. It proxies the current icon from OpenWebUI with a short HTTP cache, so removed models do not leave image files in Monitor storage.
