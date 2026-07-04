# Licensing API Reference

The PDM licensing backend is a small AWS serverless service. All endpoints accept and return
JSON. The current live deployment is in **ap-south-1**.

**Base URL** (from `LicensingConfig.ApiBaseUrl` — update if you redeploy):
```
https://pgwoailzqa.execute-api.ap-south-1.amazonaws.com
```

All responses include:
- `content-type: application/json`
- `cache-control: no-store`
- `x-content-type-options: nosniff`

Requests are rate-limited at the API Gateway (10 rps sustained, 20 burst) to blunt brute-force.

## Common concepts

**Machine fingerprint** — a 64-character hexadecimal SHA-256 of stable Windows identifiers. The
client computes it via `MachineFingerprint.Compute()`; the server treats it as an opaque value.

**Signed token** — a compact `base64url(payload).base64url(signature)` where the signature is
ECDSA over the P-256 curve (SHA-256, DER encoding). The **private signing key** lives in AWS
SSM Parameter Store (SecureString); only the **public key** ships in the client, so only the
server can mint tokens the client will accept.

**License key format** — `PDM-XXXX-XXXX-XXXX-XXXX` (uppercase hex groups).

## Endpoints

### `POST /trial` — get / refresh the trial anchor

Anchors a fresh trial to a machine, or returns the existing anchor if the machine already had
one. This is what makes trials **reset-proof**: the server remembers the first-seen time per
fingerprint.

**Request**
```json
{ "fingerprint": "00112233445566778899AABBCCDDEEFF" }
```

**Response**
```json
{
  "ok": true,
  "token": "eyJ2Ijox...",
  "trialStartUtc": "2026-07-04T14:19:31.959Z",
  "trialDays": 14
}
```

The `token` is a signed anchor. The client stores it and uses `trialStartUtc + trialDays` to
compute how much of the trial remains, regardless of local timestamps.

**Example**
```bash
curl -X POST "$BASE/trial" \
  -H "content-type: application/json" \
  -d '{"fingerprint":"00112233445566778899AABBCCDDEEFF"}'
```

Errors: `400 invalid_fingerprint` when the fingerprint doesn't match the expected hex format.

### `POST /activate` — activate a license key on a machine

Records the machine as an activation of the license (up to the license's `maxActivations`), and
returns a signed license token.

**Request**
```json
{
  "licenseKey": "PDM-6A30-961C-D32A-9F0E",
  "fingerprint": "00112233445566778899AABBCCDDEEFF"
}
```

**Response (success)**
```json
{
  "valid": true,
  "token": "eyJ2Ijox...",
  "owner": "Test User",
  "plan": "standard",
  "features": ["pro"],
  "subscriptionExpiresAt": null,
  "tokenExpiresAt": "2026-07-18T13:06:31.625Z"
}
```

**Response (failure)**
```json
{ "valid": false, "message": "Activation limit reached for this license. Deactivate another device first." }
```

Failure `message` values you can rely on:
- `"License key not found."`
- `"This license has been revoked."`
- `"This license is suspended."`
- `"This license has expired."`
- `"Activation limit reached for this license. Deactivate another device first."`

**Example**
```bash
curl -X POST "$BASE/activate" \
  -H "content-type: application/json" \
  -d '{"licenseKey":"PDM-6A30-961C-D32A-9F0E","fingerprint":"00112233445566778899AABBCCDDEEFF"}'
```

### `POST /validate` — heartbeat / re-validate an activation

Called periodically by the client after activation. Returns a fresh signed token when the
license is still valid; returns `revoked: true` when the license has been revoked/suspended so
the client can clear it locally.

**Request**
```json
{
  "licenseKey": "PDM-6A30-961C-D32A-9F0E",
  "fingerprint": "00112233445566778899AABBCCDDEEFF"
}
```

**Response (success)**
```json
{
  "valid": true,
  "token": "eyJ2Ijox...",
  "owner": "Test User",
  "plan": "standard",
  "features": ["pro"],
  "subscriptionExpiresAt": null,
  "tokenExpiresAt": "2026-07-18T13:06:31.625Z"
}
```

**Response (device not activated)**
```json
{ "valid": false, "message": "This device is not activated for the license." }
```

**Response (revoked)**
```json
{ "valid": false, "revoked": true, "message": "This license has been revoked." }
```

## Server data model

DynamoDB table `pdm-licenses`. Two record types share the partition key `licenseKey`:

**License record** (created by `admin/create-license.mjs`)
| Attribute | Type | Notes |
| --- | --- | --- |
| `licenseKey` | S | Partition key. `PDM-XXXX-XXXX-XXXX-XXXX` |
| `status` | S | `active` \| `revoked` \| `suspended` |
| `plan` | S | e.g. `standard` |
| `owner` | S | Customer name/email (optional) |
| `features` | L | List of feature strings |
| `maxActivations` | N | How many machines may activate |
| `expiresAt` | S | ISO 8601, or absent for perpetual |
| `activations` | M | Map: fingerprint → `{ activatedAt, lastSeenAt }` |
| `createdAt` | S | ISO 8601 |

**Trial anchor** (created by the `/trial` Lambda)
| Attribute | Type | Notes |
| --- | --- | --- |
| `licenseKey` | S | `TRIAL#<fingerprint>` |
| `type` | S | `"trial"` |
| `trialStartUtc` | S | ISO 8601 — the first time this fingerprint hit `/trial` |
| `createdAt` | S | ISO 8601 |

## Admin operations

See [COMMANDS.md](COMMANDS.md) for the full command cheat sheet. The most common:

- **Mint a license**: `node backend/licensing/admin/create-license.mjs --region ap-south-1 --owner "Name" --max-activations 1 --expires 2027-07-01`
- **Revoke a license**:
  ```
  aws dynamodb update-item --table-name pdm-licenses --region ap-south-1 \
    --key '{"licenseKey":{"S":"PDM-XXXX-XXXX-XXXX-XXXX"}}' \
    --update-expression "SET #s = :r" \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values '{":r":{"S":"revoked"}}'
  ```
- **Rotate signing key**: `./backend/licensing/deploy.ps1 -RotateKeys` (then update the client's
  `LicensingConfig.PublicKeyBase64` + `PublicKeyHash` and ship a new build).
- **Tear down**: `aws cloudformation delete-stack --stack-name pdm-licensing --region ap-south-1`.

## Security posture

- The signing private key is never in the repo or on the client — only in AWS SSM SecureString.
- Client verifies every token's signature against the embedded public key on every launch.
- The client also pins the public key's SHA-256 (`LicensingConfig.PublicKeyHash`); a swapped
  key is detected at startup and disables activation entirely.
- Tokens carry the machine fingerprint in the signed payload; a token minted for one machine
  will not verify on another.
- Full threat model in [SECURITY.md](SECURITY.md).
