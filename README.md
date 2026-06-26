# arcana-license-server

Cloudflare Worker that validates, activates, and manages Arcana license keys.

## Docs

- [License lifecycle](docs/license-lifecycle.md) — purchase flow, expiry, renewal, architecture

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/license/validate` | None | Validate a license key + machine binding |
| POST | `/api/license/activate` | None | Bind a machine to a license key |
| GET | `/api/license/status?key=` | None | Check license status |
| POST | `/api/license/create` | Admin | Generate a new license key |
| GET | `/api/license/list` | Admin | List all stored licenses |
| POST | `/api/license/revoke` | Admin | Revoke a license + its machine bindings |
| GET | `/api/health` | None | Health check |

## Deploy

```sh
wrangler deploy
```

Requires `ARCANA_LICENSE` KV namespace binding.
