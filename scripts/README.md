# scripts

| Script | What it does |
| --- | --- |
| `verify.mjs` | `npm run verify` from the repository root: installs dependencies if missing, runs every check that needs no keys (typechecks, tests, build, contract tests if Rust is installed, testnet dry runs, the four EVM payment receipts) and prints one PASS/FAIL/SKIP line each with a summary. `--quick` skips the contract tests and build |
| `deploy-factory-testnet.sh` | Builds the vault and factory, deploys the factory to `keel.testnet` and uploads the vault code. Signs as the factory account |
| `new-agent-key.mjs` | Creates Keel's agent keypair at `~/.near-credentials/keel-agent-key.json` and prints the public key for the factory |
| `setup-demo-testnet.sh` | Prepares one vault for `npm run demo`: creates the demo payees, sets the demo policy as the owner (5 per payment, 25 per day by default; `PER_PAYMENT` and `DAILY` change it), then mints Keel Test USDC for older vaults or prints where to get Circle's testnet USDC for vaults created now. Run as `OWNER=<owner>.testnet VAULT=<vault>.keel.testnet scripts/setup-demo-testnet.sh` |
