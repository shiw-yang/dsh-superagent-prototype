# Multi-repository implementation contract

Approved scope: one Router; many GitHub sources; one immutable target repository per Ticket; reusable executor profiles; legacy data compatibility; management forms. No container/remote backend or cross-tenant isolation claim.

## Implementation outcome

Implementation is integrated with the local DSH backend. Its shell environment extension does not support complete per-Session PATH/Git credential overrides, so different execution identities or blocked-command policies fail closed against the installed baseline. Different prepare scripts, models and workspace roots are supported. The built-in Feishu listener remains the singleton `feishu` source with multi-repository routing. Persisted repository/source identities are disabled, not deleted/reused; repository creation and Source creation are separate explicit UI steps. Execution plans additionally pin an optional defaultBranch, exposed to preparation as DSH_SUPERAGENT_BRANCH. Operational details and migration limitations are in [multi-repository operation](<docs/009-multi-repository.md>).

## Shared contract (agents must follow)

Definitions owned by model task in `src/policy.ts`:

- Keep existing `settings.executor` for legacy compatibility (and existing settings editor); new managed repositories use profiles.
- Add `settings.repositories: Record<string, RepositoryConfig>` default `{}`. Value: `{ name: string, provider: 'github', fullName: string, defaultBranch?: string, accessProfileId: string, executorProfileId: string, enabled: boolean }`. Keys are stable IDs `/^[a-z][a-z0-9-]*$/`.
- Add `settings.executorProfiles: Record<string, ExecutorProfile>` default `{}`. Value: `{ name: string, model: RoleModel|null, directory: string, prepare: string, blockedCommands: string[] }` (no per-profile maxWorkers).
- Add `settings.accessProfiles: Record<string, AccessProfile>` default `{}`. Value: `{ name: string, kind: 'github-cli', cli: string }`.
- Add `settings.scheduler: { maxWorkers: number, maxWorkersPerRepository?: number }` with default maxWorkers 3. Preserve legacy executor maxWorkers behavior when registry empty.
- Extend root `settings.sources[id]` with optional `kind`, `repositoryId`, `routing: { defaultRepositoryId?: string, allowedRepositoryIds: string[], chats?: Record<string,string> }`, alongside existing enabled/config. Legacy kind defaults to id at resolution, NOT globally github.
- Add settings block `'topology'` whose value is `{ repositories, executorProfiles, accessProfiles, scheduler, sources }`. Save atomically with full cross-reference validation and panel-only mutation. Existing source:<id> saves preserve identity/bindings if omitted. GET settings view exposes topology `{ revision, value }`. Existing executor editor remains legacy editor. New UI uses topology to administer all multi-repo objects together.
- New source instances have unique ids, e.g. github-api; kind=github. Source kind registration remains single. `SourceRegistry.kind(id)` may resolve instance id to kind for compatibility; `instance(id)` resolves config and repository binding. Preserve all stored fields. Default legacy source IDs github/feishu remain usable.

Definitions owned by model task in `src/core/model.ts`:

- Ticket `repository?: string` (optional ONLY for legacy/unconfigured test fixtures). New registry-backed work must resolve it before creation. `routing?: { sourceInstanceId: string; basis: 'source'|'explicit'|'default'|'manual'; configurationRevision?: number }`.
- Mandate `repository?: string` used for revalidation; never change target silently.
- Execution existing name/directory/assignment retained; add `plan?: ExecutionPlan`.
- ExecutionPlan: `{ repositoryId: string; repository: string; executorProfileId: string; accessProfileId: string; configurationRevision?: number; model: {provider:string;model:string;reasoningEffort?:string}|null; directory: string; prepare: string; blockedCommands: string[]; createdAt: string; preparedAt?: string }`. Snapshot resolved execution config; no credentials. Repository remains fixed; current disable/access revocation still checked.
- Accept AssessmentOutcome optional `repository?: string` (explicit candidate). Model task owns deterministic `resolveTarget` in `src/repositories.ts` and hooks it into acceptance/assessment. Reject ambiguity and outside allowed repositories; do not create runnable ticket or acknowledge accepted work on unresolved target. GitHub binds to source repository; IM explicit/default/chat mappings. Existing follow-ups retain target and cannot expand execution authorization.

Source task owns src/sources/**, src/app/source-context.ts, src/infra/commands.ts, src/deployment.ts, src/app/setup.ts, tests/multirepo-sources.spec.ts.
- SourceHost.context accepts optional `id` alongside kind/health; SourceContext exposes optional id/repositoryId; context is bound to one deployment/commands/state/health namespace. Preserve default github identifiers and state for migrated data. New instances have disjoint Trigger IDs and Thread keys. Read/write commands, outbox and URL lookup must resolve source instance, never global repository. Setup must isolate per-repository failures. Expose Setup.deploymentFor(repositoryId?: string): Deployment and Setup.problemFor(repositoryId: string): SetupProblem|undefined where feasible; deployment remains legacy/default compatibility. Lead integrates Runtime.

Executor task owns src/executor/**, src/infra/environment.ts, src/app/sessions.ts, src/app/execution-environment.ts, src/app/tools/executor.ts, tests/multirepo-executor.spec.ts.
- Consume settings contract above, store execution.plan before launching, pin model/prepare/blockedCommands/directory. Keep persistent Session per ticket. Runtime integration lead will supply selected repository deployment/context hooks as requested.
- Verify supported Session-scoped environment injection in installed DSH modules. Do not mutate global process.env to switch between profiles/accounts. If unsupported, fail closed for differing credentials/command policies and report precise limitation; per-ticket prepare env alone is insufficient.
- Maintain global + repository slot counts, disabled repo start/wake guard, validate ready workspace state. Preserve old directories/sessions.

Model task owns src/policy.ts, src/repositories.ts, src/core/**, src/app/store.ts, src/app/migration.ts, src/app/settings.ts, src/app/assessment.ts, src/app/tools/main.ts, src/app/views/settings.ts, src/app/http.ts, tests/multirepo-model.spec.ts.
- schema 12 migration from 11, chain from 10. Migrate legacy configured github into repository 'default', source id 'github', executor/access profile 'default'. Preserve history and old directories. Do not fabricate provenance for ambiguous legacy tickets. Ensure latest settings reads/new schemas are compatible with old versions.

UI task owns src/client/** and tests/multirepo-panel.spec.tsx.
- New topology section on Sources and reusable profiles on Execution (can share topology editor). CRUD repository/source/profile/access rows; enable/disable, validate errors and CAS revision. No raw JSON-only UI. Surface target on tickets where view allows. Preserve existing edits and legacy forms.

Lead owns Runtime integration, remaining app views/resources/context/links, cross-feature tests/docs and full validation. Do not edit another task's files; report needed changes. All agents may read any files. No commits, no installing packages, no deployments or live server restarts. Existing uncommitted changes must remain intact. Use bundled or installed Node >=22.19 for tests (node:sqlite). Run focused tests where possible; lead runs final suite.
