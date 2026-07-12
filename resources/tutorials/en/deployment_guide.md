# OpenWebUI Monitor Deployment Guide

OpenWebUI Monitor requires:

- a current OpenWebUI instance
- PostgreSQL
- network access from Monitor to OpenWebUI
- network access from OpenWebUI to Monitor
- the current [OpenWebUI Monitor filter function](../../functions/openwebui_monitor.py)

The integration was last verified against OpenWebUI `v0.10.2`. This fork follows the current OpenWebUI API and does not target older OpenWebUI releases.

## 1. Docker Compose Deployment

Docker Compose is the recommended deployment method. The maintained configuration uses the public multi-architecture image at `ghcr.io/yuzukumo/openwebui-monitor:latest` and PostgreSQL 18.

### 1.1 Prepare the configuration

```bash
git clone https://github.com/yuzukumo/OpenWebUI-Monitor.git
cd OpenWebUI-Monitor
cp .env.example .env
```

Set at least these values in `.env`:

```dotenv
OPENWEBUI_DOMAIN=https://chat.example.com
OPENWEBUI_API_KEY=your-openwebui-admin-api-key-or-jwt
ACCESS_TOKEN=your-monitor-login-secret
API_KEY=your-function-shared-secret
```

- `OPENWEBUI_DOMAIN` is resolved by the Monitor container. Do not use `127.0.0.1` unless OpenWebUI runs in the same container.
- `OPENWEBUI_API_KEY` must belong to an OpenWebUI administrator. OpenWebUI API keys must be enabled, and any endpoint restriction must allow `/api/models`, `/api/v1/models/model/profile/image`, `/api/chat/completions`, and `/api/v1/users/all`.
- `ACCESS_TOKEN` protects the Monitor UI and dashboard APIs.
- `API_KEY` is the shared secret used only between the OpenWebUI function and Monitor inlet/outlet APIs.

Generate independent random values for `ACCESS_TOKEN` and `API_KEY`. They do not need to be an OpenWebUI JWT or API key.

### 1.2 Start Monitor

```bash
docker compose pull
docker compose up -d
```

The default host address is `http://127.0.0.1:3003`. The container listens on port `3000` inside its Docker network.

```bash
docker compose ps
docker compose logs -f openwebui-monitor
```

### 1.3 PostgreSQL 18 data directory

The bundled database mounts its volume at `/var/lib/postgresql`, which is required by the PostgreSQL 18 image layout.

Do not point PostgreSQL 18 directly at a PostgreSQL 17-or-earlier volume previously mounted at `/var/lib/postgresql/data`. Choose one of these paths:

1. Preserve the data by performing a PostgreSQL major-version migration with `pg_upgrade` or dump/restore.
2. If the old Monitor data is intentionally disposable, stop the deployment and delete the old volume before starting PostgreSQL 18.

Deleting a volume is irreversible. Verify its name and back up anything needed before removal.

### 1.4 External PostgreSQL

The application supports `POSTGRES_URL`, `DATABASE_URL`, or individual `POSTGRES_*` variables. When adapting the repository Compose file for an external database, remove the bundled `openwebui-monitor-db` service and the app service's `depends_on` entry, then provide the external connection settings. The application creates and migrates its tables on startup.

## 2. Vercel Deployment

[![Deploy on Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyuzukumo%2FOpenWebUI-Monitor&project-name=openwebui-monitor&repository-name=openwebui-monitor&env=OPENWEBUI_DOMAIN,OPENWEBUI_API_KEY,ACCESS_TOKEN,API_KEY)

1. Deploy this fork with the button above.
2. Add `OPENWEBUI_DOMAIN`, `OPENWEBUI_API_KEY`, `ACCESS_TOKEN`, and `API_KEY` to the Vercel project environment.
3. Create or attach a PostgreSQL provider and expose its connection string as `POSTGRES_URL` or `DATABASE_URL`.
4. Redeploy after all environment variables are available.

The OpenWebUI URL must be reachable from Vercel. The Vercel Monitor URL must also be reachable from the OpenWebUI container because it becomes the function's `Api Endpoint`.

## 3. Install the OpenWebUI Function

The currently supported integration is [openwebui_monitor.py](../../functions/openwebui_monitor.py).

1. Sign in to OpenWebUI as an administrator and open the Functions page.
2. Create a function, paste the current contents of `openwebui_monitor.py`, and save it.
3. Configure the function valves:

| Valve          | Value                                                             |
| -------------- | ----------------------------------------------------------------- |
| `Api Endpoint` | Monitor URL reachable from OpenWebUI, without a trailing API path |
| `Api Key`      | The same value as Monitor's `API_KEY`                             |
| `Language`     | `en` or `zh`                                                      |

4. Enable the function globally.

On a shared Docker network, `Api Endpoint` can use the Monitor container and internal port:

```text
http://openwebui-monitor-app:3000
```

If OpenWebUI and Monitor belong to separate Compose projects, attach them to a shared external network or use an address routable from the OpenWebUI container. The host-bound `127.0.0.1:3003` address is not the OpenWebUI container's loopback address.

The function sends request metadata to `/api/v1/inlet` before a request and sends the completed message with upstream usage to `/api/v1/outlet`. Per-request billing uses a completed outlet callback instead of completion-token count, so a successful image response with zero output tokens is still charged. The stream hook marks explicit provider errors because some custom Pipes can route an SSE error through outlet; marked failures and cancelled responses that never reach outlet are not charged. The function strips large inline image data before forwarding the payload. Keep the installed function synchronized with the repository when Monitor is updated.

## 4. Configure Model Billing

Open the Monitor model-management page after signing in with `ACCESS_TOKEN`.

### Token billing

Set the input price, output price, and model multiplier. Prices are per 1M tokens:

```text
effective input price = input price x model multiplier
effective output price = output price x model multiplier
```

### Per-request billing

Set one fixed per-request price. Monitor ignores input/output prices and the model multiplier in this mode.

For an OpenWebUI derived model, the sync action copies the billing mode and all relevant pricing fields from its base model.

## 5. Update

Every push to this fork builds native `amd64` and `arm64` images and publishes a multi-architecture `latest` manifest to GHCR.

```bash
docker compose pull
docker compose up -d
```

Review changes to `resources/functions/openwebui_monitor.py` and update the installed OpenWebUI function at the same time.

## 6. Verify

1. Open Monitor at `http://127.0.0.1:3003` or its reverse-proxy URL and sign in with `ACCESS_TOKEN`.
2. Confirm that the model page loads models and icons from OpenWebUI.
3. Confirm that the user page matches the current OpenWebUI user list.
4. Configure a model price and send a completed OpenWebUI message through that model.
5. Confirm that the status line, usage record, used balance, and remaining balance show the same charge.

If a response is stopped before OpenWebUI invokes the function outlet, the request is not billed by the outlet path. Likewise, OpenWebUI auxiliary requests that bypass globally enabled function hooks cannot be observed by Monitor. An explicitly configured `COST_ON_INLET` pre-charge is applied independently.
