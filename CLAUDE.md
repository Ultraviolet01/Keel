# Keel: notes for coding agents

- The user is Ultraviolet. Address them as Ultraviolet.
- Keel is an entry for NEAR HACKATHON. Rules: https://nearhackathon.com/HACKATHON.md (re-read before submitting; rules can change).
- Deadline: repo public and demo post on X by 2026-11-14 23:59 UTC. One submission per project; it cannot be edited.
- Tracks: `business`, `security`, `realworld`.

## Rules for this repo

- Never commit secrets. `.env` is ignored; the owner's full-access key never goes in it.
- The agent signs only with a function-call key scoped to the Keel Vault (`execute_payment`, `propose_payment`).
- NEAR Intents has no testnet. Use testnet for everything else; the mainnet Intents leg runs on a separate vault with a 5 USDC budget and `dry: true` quotes while developing.
- Never deploy to mainnet, sign mainnet transactions or spend tokens without Ultraviolet's explicit OK.
- Keep README.md in "do X, see Y" steps with no marketing copy. AI judges (Claude Code, Codex) run it first. Update script names in the README whenever they change.
- List new libraries and templates in the README's "Libraries and AI-generated code" section.
- Commits are authored as `ultraviolet01 <ultravioletadewale@gmail.com>`. Set `git config user.name` and `user.email` to that before committing. Never add Co-Authored-By, Claude-Session or any other Claude attribution lines to commits or PRs.
