# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running

```bash
npm install
node copy.js
```

There is no build step, no test suite, no lint config, and no `scripts` block in `package.json`. The whole program is one file — `copy.js` — and it is run directly with `node`.

`copy.js` validates config at module top level and **throws before the bot starts** if any of these are missing: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SUPABASE_URL` + `SUPABASE_KEY`, `RPC_URLS`, `OPENSEA_API_KEY`. Additionally `PRIVATE_KEY` + `WALLET_ADDRESS` are required whenever `DRY_RUN=false`. So a "crash on startup" is usually a missing environment variable, not a code bug.

Config comes from the **process environment**. In production this is Railway-hosted variables; the `.env` in the repo directory is a local-development convenience only and is not authoritative — don't read deployment behavior out of it. The `.env` is gitignored, so it won't leak into commits, but it will drift from what's actually running.

`copy.js`'s header comment is the real reference for variable names and intent. Two stale references to ignore: the file header still calls itself `telegram-mint-bot.js` (the file was renamed to `copy.js`), and `.env.example` describes an older, different bot (`WATCHED_WALLETS`, `ETHERSCAN_API_KEY`, a `watch-and-mint` pipeline) that no longer matches the code.

## Architecture

One file, three tangled concerns: **Telegram UI**, **Supabase persistence**, and **multi-chain mint detection/copy**. They are not layered — Telegram handlers call the mint helpers directly, and mint helpers call `notify()` directly. Expect to touch all three when changing behavior.

### Config: two-tier env with per-chain overrides

Globals (`DRY_RUN`, `MAX_PRICE_ETH`, `RPC_URLS`, `OPENSEA_CHAIN_SLUG`, …) are each overridable per chain by a prefixed variant (`RH_*`, `ETH_*`, `INK_*`, `ARC_*`). The pattern is always `process.env.RH_X || process.env.X`. These all collapse into a single `chainConfigs` object (`robinhood`, `ethereum`, `arc`, `ink`), each holding `{ enabled, chainId, rpcUrls, openseaSlug, explorerApiBase, explorerApiKey, maxPriceEth, dryRun }`.

Everything downstream reads `chainConfigs[chainName]` — `copyMint` and `attemptDirectMint` both start by resolving the chain config and then picking the matching RPC pool. Adding a chain means adding an entry here and then wiring the pieces listed below.

Blank and unset are treated identically throughout (`=== undefined || String(x).trim() === ''`), and blank per-chain overrides fall through to the global. This matters because a variable defined with an empty value — easy to do in a hosted dashboard — is *not* a zero: a blank `MAX_PRICE_ETH` means "no ceiling", not "cap at 0". Note also that `MAX_PRICE_ETH` is compared against the value of a *single transaction*, which the OpenSea Drops API returns already multiplied by the requested quantity — so it bounds one mint per wallet, not aggregate spend across the wallet set.

Note that **dry-run is per-chain** (`chain.dryRun`). The global `DRY_RUN` only supplies the default, and per-chain flags default to it — but the two are not interchangeable: the `wallets` array is populated only when *global* `DRY_RUN=false` (`copy.js:1211`), while the mint path decides on `chain.dryRun`. So setting e.g. `RH_DRY_RUN=false` while leaving global `DRY_RUN=true` produces `chain.dryRun=false` with an empty `wallets` array, and every mint bails at "No minting wallets configured".

Which chains are actually enabled is a deployment question — read it from the environment, and check the `[chains] ... enabled:` lines that `copy.js` logs at startup.

### Multi-chain is copy-pasted, not abstracted

This is the single most important structural fact. There is no generic chain poller. Each chain has its own near-identical copies of the same five things:

| | Robinhood | Ethereum | Ink |
|---|---|---|---|
| pool | `rpcPool` | `ethRpcPool` | `inkRpcPool` |
| last block | `lastCheckedBlock` | `ethLastCheckedBlock` | `inkLastCheckedBlock` |
| seen tx set | `seenTxHashes` | `ethSeenTxHashes` | `inkSeenTxHashes` |
| log scan | `findMintsInRange` | `findEthMintsInRange` | `findInkMintsInRange` |
| poll loop | `pollLoop` | `ethPollLoop` | `inkPollLoop` |

Robinhood is the odd one out — it uses the *unsuffixed* names, so there is no `rhPollLoop` or `rhLastCheckedBlock`. When adding a chain, follow the `eth`/`ink` naming, and expect to also update: `mainMenu` keyboard, the `📊 Status` handler, the `/status` handler, the per-chain pause/resume `bot.hears` handlers (plus `⏸ Pause All` / `▶️ Resume All`), the pause flags at the top of `copyMint`, `getChainRpcPool`, `parseChainKey`, and `main()`.

**`chainConfigs.arc` is a stub.** It is read only by the startup `console.log` and the "Bot started" Telegram message. There is no ARC RPC pool, no poll loop, and no `arcPollLoop` — despite the pool-selection ternaries in `copyMint`/`attemptDirectMint` looking like they cover it.

The chains also differ in scan behavior: Robinhood scans up to 1000 blocks per tick with no head lag; Ethereum and Ink deliberately stay 2 blocks behind head and cap at 200 blocks per scan to survive public RPCs.

### Detection → copy pipeline

`pollLoop` → `getLogs` filtered on `Transfer` topic with `from = 0x0` (i.e. mints) → filter to addresses in `watchedWallets` → dedupe on tx hash → `copyMint` per hit.

`copyMint` then:
1. Bails immediately if globally or per-chain paused, or if a mint is already active.
2. Looks the contract up on OpenSea (`/chain/{slug}/contract/{addr}`) to get a **collection slug**.
3. Builds the tx via the OpenSea Drops API (`POST /drops/{slug}/mint` with `{minter, quantity}`), which returns `{to, data, value}`.
4. Signs and sends, checking balance against `value + gasEstimate * gasPrice` and the per-chain `maxPriceEth` ceiling first.

**Quantity ladder:** `QUANTITY_TRIES` (default `10,5,3,2,1`) plus the quantity detected from the source tx's Transfer logs, deduped and sorted descending. Each wallet walks this ladder until one succeeds, then `break`s — so a wallet that mints 3 is never retried at lower quantities, and `successCount` counts *wallets that got at least one mint*, not tokens.

**Fallback:** if the OpenSea lookup 404s/errors, or every OpenSea attempt fails, it calls `attemptDirectMint`, which fetches a verified ABI from the chain's explorer and brute-forces ~13 mint signature variants × 4 quantities. That function's comment is correct that this only works on **Blockscout**-style explorers (`/smart-contracts/{addr}`); Etherscan uses a different response shape, so the Ethereum fallback does not actually work.

### Guard state is in-memory only

`successfulMints` (contract addresses already minted, used to skip repeat collections), `seenTxHashes`, and `lastCheckedBlock` are process-lifetime only. Restarting the bot wipes them, which means a restart re-scans from the current head and can re-mint a collection it already minted. `seenTxHashes` also grows without bound.

`successfulMints` is written in exactly one place — the OpenSea success path (`copy.js:1710`). `attemptDirectMint` never records its successes, so a collection minted via the fallback is never registered and will be minted again on the next detection of that contract.

`isPaused` (global) plus `isRhPaused` / `isEthPaused` / `isInkPaused` are module-level mutable flags. `isSponsorMode` **always resets to `false` on restart** — this is deliberate, per the comment.

### Sponsor mode

When `isSponsorMode && sponsorWallet && !activeDryRun`, the sponsor wallet pays gas and mint price while the `minter` passed to OpenSea is still each target wallet's address. Two consequences: sponsor mode switches minting from `Promise.all` (parallel) to a sequential loop, and any pre-flight balance check reads the *sponsor's* balance rather than the target wallet's.

Sponsor mode is toggled only from Telegram. `SPONSOR_ENABLED` in the environment is never read — setting it does nothing.

### Telegram layer

Telegraf, with **HTML parse mode** — chosen over Markdown because unmatched `_`/`*` in dynamic strings (slugs, `DRY_RUN`, error messages) silently break Markdown. Any interpolated value must go through `escapeHtml()`.

Every handler starts with `if (!isAuthorizedChat(ctx)) return;` — auth is a string compare against `TELEGRAM_CHAT_ID`. Keep that guard on new handlers.

Two registration styles: `bot.hears('📊 Status', …)` for keyboard buttons, and `bot.command('addwallet', …)` for slash commands. Multi-step interactions (⛽ Fund Gas, 📦 Collect NFTs) are **not** conversations — they use module-level `pendingFundGas` / `pendingCollect` state machines driven by the single `bot.on('text')` handler. That handler first early-returns on any text starting with a menu emoji or `/`, then dispatches the pending flow. A new multi-step flow means a new `pending*` global, a new step chain in that handler, and clearing the other pending state on entry.

`bot.launch()` in `main()` is deliberately **not awaited** — it never resolves in long-poll mode, so awaiting it would hang all of startup. Startup checkpoints are logged around each step precisely so a silent hang is diagnosable.

### Supabase

Single table, default `watched_wallets` (override via `WALLETS_TABLE`), columns `id / address / added_at`, with `address` unique. The bot caches it in `watchedWallets` and refreshes on a `WALLET_REFRESH_MS` interval (default 5s) rather than querying in the hot poll loop. `dbAddWallet` treats Postgres `23505` as "already watched" rather than an error. This is why `/addwallet` takes effect without a restart — environment variables cannot, which is the entire reason the table exists.

## Conventions

- **Per-feature backups.** The repo root holds ~16 `copy.js.backup-*` snapshots, one per feature (`-before-multichain`, `-before-ink-chain`, `-before-Sponsored-Minting`, …). Snapshot `copy.js` to a new descriptively-named backup *before* starting a non-trivial change; don't prune the existing ones.
- **Every network call is bounded.** `fetchWithTimeout` (10s) for HTTP, `withTimeout` for promises, and `ethers.FetchRequest.timeout` on every provider. A new outbound call should get a timeout too — the file's header explains this was added to kill a silent startup hang.
- `process.on('unhandledRejection')` / `uncaughtException` handlers are global; errors are also mirrored to Telegram via `notify()`, which itself swallows send failures so notification problems never break minting. Note the flip side: an unescaped `<` or `&` in an interpolated error string makes Telegram reject the message, and `notify()` will swallow that too.
- `npm` dependencies `permissionless` and `viem` are in `package.json` but imported nowhere — dead weight, not a pattern to follow.
