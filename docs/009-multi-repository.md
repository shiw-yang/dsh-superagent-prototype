# 009 Multi-repository operation

This extends the Router/Worker model described in [007 Architecture](<007-architecture.md>). One Router coordinates multiple repositories; each Ticket and its persistent Worker Session have one target repository. It does not implement a single Ticket modifying several repositories, containers, remote executors, or isolation between mutually untrusted tenants.

## Configure the topology

The Sources and Execution settings include a shared **Multi-repository configuration** form. Its changes save atomically as the `topology` block, with optimistic concurrency protection.

1. Add an access profile naming a configured agent GitHub CLI or account wrapper. Do not put tokens in forms or prepare commands.
2. Add an executor profile: worker model, optional absolute workspace root, prepare command, and blocked command names.
3. Add a repository with a stable ID, `owner/name`, and references to those profiles.
4. Add a Source route with a unique ID, kind `github`, and the repository binding. Enable it and save. Creating a repository alone does not create a listener. At most one enabled GitHub Source may listen to each repository.
5. In the Policy settings, configure the new Source instance's allowed senders and admission rules. An existing GitHub Source's permissions are not inherited by another instance.
6. For Feishu, reuse the built-in `feishu` Source and set its allowed repository IDs, an optional default repository, and optional chat-to-repository mappings. Multiple Feishu bot instances are not supported by this backend. These route targets do not bypass the Source's sender/admission rules.
7. Set the global worker limit and, optionally, the per-repository limit. Managed repositories use these scheduler limits rather than the legacy executor limit.

Stable repository and Source IDs are namespaces for historical events, Threads, cursors and Tickets. Saved repositories cannot be repointed to another `owner/name`; saved Sources cannot change kind or an existing repository binding. Disable existing entries instead of deleting and reusing their identities. To listen to a different repository, create new IDs. Verified GitHub rename/transfer handling is not implemented.

Runtime account checks happen at startup/restart, per repository. One failed repository is left unavailable while healthy repositories continue. Its Source health reports the problem. If none are usable, processing waits for setup. Use the setup check action after fixing access; connection checks do not submit real work or PRs.

## Routing and authorization

- A new GitHub request targets its Source's registered repository. A proposed conflicting repository is refused.
- A new IM request may name a stable repository ID, or use its chat/default mapping. The selected target must be in that Source's allowlist.
- Missing, conflicting or unauthorized targets produce an unavailable decision, not an accepted Ticket, acknowledgement or worker.
- A Ticket stores its target and routing basis. Its Mandate includes the repository. Follow-ups cannot change that target; a request for another repository needs a separate Ticket.
- Two repositories may each have Issue or PR `42`. Their Thread keys are different, such as `github-web:42` and `github-api:42`. Non-default instances also have distinct Trigger IDs and polling state.

The Router's bounded GitHub resource reads use `github/<source-instance-id>/issues/<number>` or `github/<source-instance-id>/pulls/<number>` when repositories are plural. A worker's unqualified `github/issues/42` reads its own repository. An explicit resource pointing outside its Ticket is refused; pagination retains the selected Source.

## Execution plans and recovery

Before launch, managed Tickets retain an execution plan: repository identity/address, profile references, configuration revision where available, model, directory, prepare command, blocked commands and creation time. No credential contents are stored in the plan.

New directories are grouped by repository below the profile root (or the default state-directory work root). The existing prepare-command environment variables remain available, including `DSH_SUPERAGENT_GITHUB_REPOSITORY`, `DSH_SUPERAGENT_NAME` and `DSH_SUPERAGENT_DIR`. The optional repository default-branch override is pinned as `DSH_SUPERAGENT_BRANCH`; an empty value means the remote default branch. Prepare scripts must explicitly use this value when selecting a branch; saving it does not run a checkout. Quote variable expansions in shell commands. Variables are execution facts, not a mechanism for accepting arbitrary shell commands from Issue text.

Ordinary retry and host restart retain the Ticket's directory, Session and plan. Editing a profile affects future plans, not the command/model of an already planned Ticket. Current repository availability and access-profile validity are still checked before launch, wake, message delivery and worker/subagent tools; a snapshot is not a permanent authorization grant.

Prepared directories are recorded as prepared only after preparation and directory verification succeed. A partial directory left by a failed new prepare is not silently reused as ready. Existing historical directories are retained; directory verification does not independently certify their Git remote identity.

Changing a repository's access-profile binding stops an old plan from resuming under a different identity. Changing execution-account or blocked-command requirements may require an installation restart and may leave older incompatible plans held. The Ticket detail displays execution problems. There is no automatic plan rebinding or destructive workspace reset action: investigate the retained directory before recovery, and create a new authorized Ticket when the intended execution target/configuration must change.

## Important local-executor limitation

The installed DSH shell environment extension accepts `DSH_*` facts, not a complete Session-scoped `PATH` or Git credential configuration override inherited by every shell job and subagent. Therefore this backend uses **one process-wide execution identity and blocked-command baseline**. It never switches those global values per Ticket.

- Different repositories can use different worker models, prepare commands and workspace roots.
- GitHub listeners and host-side repository reads use their own resolved access profiles.
- Workers requiring a different GitHub CLI/account wrapper or blocked-command set are **held with an explicit incompatibility reason**. Only changing prepare-command variables would not isolate their later tools, so that fallback is not used.
- Baseline CLI comparison uses the exact configured wrapper name/path captured when the environment was installed. Different aliases for the same executable may conservatively be refused.
- The baseline is the healthy `default` repository when present, otherwise the first healthy registered repository at startup. Account/profile changes that alter the installed baseline require restart.

Use a common agent account wrapper and blocked-command policy for repositories executed by one instance. For genuinely distinct execution identities, use separate instances/process environments until a backend with end-to-end Session environment binding exists. This is not OS-level or multi-tenant security isolation: workers continue to use the installation's operating-system user and existing DSH permission policy.

## Upgrade and compatibility

Database schema 12 adds managed repository configuration. Supported schema-10 databases first migrate to 11, then to 12 in the startup transaction. Back up the database/state directory before upgrading; an older binary cannot open a newer schema.

A legacy GitHub configuration with an explicit repository and CLI becomes repository/profile `default`, retaining Source ID `github`, existing Thread keys, cursors, directories and Session IDs. Existing Feishu routing without a mapping receives the sole legacy default. No CLI credential identity is guessed when the old configuration omitted one.

Historical Tickets are backfilled only when their retained origin evidence establishes the repository. Incomplete or ambiguous evidence leaves them unbound and prevents automatic execution once the registry is active. Review the old work and create a fresh authorized Ticket rather than assigning an arbitrary default.

The legacy executor editor remains for compatibility. Where the migrated default profile exists it stays synchronized with that default; topology and legacy source/executor saves invalidate each other's affected revision tokens so stale drafts cannot silently overwrite changes.

## Verification scope

Automated tests cover routing denial, identity immutability, migration, same-number events in different repositories, per-source state and commands, partial setup failure, pinned execution configuration, worker limits, execution-environment refusal, resource access, PR Source selection, and management form/CAS behavior. Running the test suite uses mock GitHub/DSH dependencies; it does not verify credentials against real private repositories or deploy the plugin to the running GUI.
