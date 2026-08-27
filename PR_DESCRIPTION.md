# fix(runtime): never kill the host container during orphan residue cleanup

Fixes #1487

## Problem

When NanoClaw itself is run **inside** a Docker container (nested host), startup residue cleanup can remove that outer container and take down the whole process tree (Claude Code, the shell, everything).

Observed sequence from the issue:

```
[DEBUG] main: calling ensureContainerSystemRunning
[DEBUG] ensureContainerSystemRunning: calling ensureContainerRuntimeRunning
[DEBUG] ensureContainerSystemRunning: calling cleanupOrphans
# then hard crash — no further logs
```

Root cause: older orphan cleanup matched container **names** containing `nanoclaw` (e.g. `amux-nanoclaw-controller`) and force-removed them. The host container matched that pattern and was killed by its own child process.

## What already changed upstream

The session driver seam already replaced the old name-based `cleanupOrphans()` with label-scoped residue cleanup (`reapResidue`):

- only containers labeled with this install slug
- pre-seam leftovers without a session label
- install-owned networks with no remaining containers

That fixed the common multi-install clash. It does **not** fully protect a nested host whose outer container happens to carry the install label (or is otherwise selected for pre-seam cleanup).

## Fix

Add a hard backstop in `DockerSessionDriver.reapResidue`:

1. Detect whether **this process** is running inside a container (`/.dockerenv`, cgroup id, hostname).
2. Resolve that container’s Docker name via `docker inspect` when possible.
3. **Skip** any residue target that is the self container (by name or id prefix) before `docker rm --force`.

New helpers in `src/drivers/docker-driver.ts`:

- `resolveSelfContainerIdentity(cli)`
- `isSelfContainer(name, self)`

On a normal bare-metal / launchd / systemd host these return empty identity and behavior is unchanged.

## Tests

`src/drivers/docker-driver.test.ts`:

- residue cleanup still removes true pre-seam orphans
- nested host does **not** `rm --force amux-nanoclaw-controller`
- `isSelfContainer` matches name / short id / full id
- bare host resolves empty identity

```bash
pnpm exec vitest run src/drivers/docker-driver.test.ts
```

## Acceptance

- Nested NanoClaw (e.g. container named `*nanoclaw*`) no longer suicides on startup.
- Label-scoped orphan cleanup still reaps real dead agent containers and empty networks.
- Bare-host installs are unaffected.
