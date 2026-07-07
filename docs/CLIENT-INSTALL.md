# AgentX — Client Installation (macOS, Apple Silicon)

## Install

From a release folder (or checkout):

```bash
bash install.sh
```

The installer is idempotent: it checks Homebrew, installs node/pnpm/ollama/python
if missing, places AgentX at `~/AgentX`, builds it, and puts **AgentX.app** in
/Applications. First launch pulls the minimum AI models (~5GB) and starts every
service with self-healing.

Launch from /Applications → AgentX (or Spotlight). Dashboard: http://127.0.0.1:3001

## Licensing a paid install

1. Vendor (one-time): `node scripts/license-admin.mjs keygen` — keep the private key safe.
2. On the client machine, create `~/.agentx/env.client` additions in the shell
   profile or launchd env:
   ```bash
   export AGENTX_LICENSE_PUBLIC_KEY="<public key>"
   export AGENTX_LICENSE_REQUIRED=true
   ```
3. Per sale/renewal: `AGENTX_LICENSE_PRIVATE_KEY=… node scripts/license-admin.mjs issue --customer "acme" --months 1`
   → send the `AGX1.…` key; the client activates in Settings → License
   (or `POST /api/license/activate`). Expired keys get a 7-day grace period.

## Recommended client hardening

Set the client profile before first launch (see `config/client.yaml`):

```bash
export AGENTX_CONFIG_PROFILE=client
```

## Uninstall

```bash
bash ~/AgentX/uninstall.sh              # keep data
bash ~/AgentX/uninstall.sh --purge-data # remove ~/.agentx too
```
