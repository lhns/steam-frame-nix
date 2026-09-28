# Rootless Docker

`docker.*`, module `docker`. Options:
[README, Options](../README.md#options).

## Problem

SteamOS has no Docker, and Home Manager can't install the usual root
daemon. Rootless Docker's default socket is in `$XDG_RUNTIME_DIR`, which
differs between the Frame's [two sessions](../README.md#two-sessions), and
the nested desktop can't reach the user service manager.

## What you get

- `dockerd` in rootless mode as the systemd user service `docker.service`
  of the Steam session's user manager, started at login and on switch
  (never restarted by a switch, which would stop running containers).
- The `docker` CLI on `PATH`, whose default `DOCKER_HOST` is the socket in
  the outer runtime dir (`docker.host`,
  `unix:///run/user/1000/docker.sock`): it works in both sessions. A
  `DOCKER_HOST` you set yourself wins.

SteamOS already has what rootless Docker needs: `newuidmap`/`newgidmap`
with their capabilities, `/etc/subuid` and `/etc/subgid` entries for the
user, user namespaces and cgroup v2 delegation.

## Configuration

```nix
steamFrame.docker.enable = true;
```

Then `docker run --rm hello-world`. `docker.package` replaces the Docker
package (daemon and CLI).

## Caveats

- Rootless limits apply: no ports below 1024 without extra setup,
  `--network host` is the rootless network namespace, containers can't
  gain real root.
- Images, containers and volumes are app data in `~/.local/share/docker`,
  see [App data you create](../README.md#app-data-you-create) for how to
  remove them.
- Disabling the module removes the unit but doesn't stop a running daemon:
  run `systemctl --user stop docker` first (or add `docker.service` to
  `session.services.stop` for that switch).
- Another `docker` package in `home.packages` collides with the wrapped
  CLI.

## How it works

The user unit runs `dockerd-rootless` (RootlessKit) with `PATH=/usr/bin`,
for SteamOS's `newuidmap`/`newgidmap`, and `Delegate=yes`. The unit is
added to `session.services.start`, so each switch starts it if it isn't
running. The CLI is the package's `docker` wrapped with a default
`DOCKER_HOST`; nothing is written outside the store (no `daemon.json`, no
Docker context).
