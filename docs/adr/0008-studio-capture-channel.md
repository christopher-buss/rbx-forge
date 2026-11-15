---
status: accepted
---

# Studio captures use an authenticated loopback HTTP channel

The forge plugin cannot connect to the named pipe or Unix socket that carries
session control. Captures use a separate HTTP listener bound to `127.0.0.1`, on
a random port with a random secret route. This is a limited exception to
[ADR 0003](./0003-ipc-security.md): the listener accepts capture data and plugin
capture failures, and exposes no session control commands.

The plugin long-polls for a request and posts its serialized model with service
metadata. The listener accepts a response only for its pending request and
matching secret, project, and session. A new session creates a new secret and
closes the old listener. The capture URL travels through the session's Rojo
wrapper, and the plugin verifies its identity against the connected Rojo project
and session before polling. This also serves a found Studio when its Rojo
reconnects.

The initial wrapper declares the capture instance before Rojo serves it. Its
empty endpoint keeps the plugin inert until the listener binds. Rojo hydrates
the existing service and instance before their capture attributes change; a
later patch cannot create a service and its descendants with `Instance.new`.

Snapshots keep their port and secret beside the place. Their non-Archivable
launch marker identifies the capture without a Rojo connection. Each save binds
the recorded endpoint for its own duration; an occupied port fails the save.
Pruning a snapshot removes its credentials and launch script too.

The wrapper's capture instance is non-Archivable: Rojo supports setting
`Archivable` to `false`. The plugin excludes it from every capture too. Base
places come from the original project, so the capture instance and its secret do
not enter syncback or a saved place.

Under WSL, listeners bind IPv4 loopback and rely on localhost forwarding or
mirrored networking. Before Rojo reports ready, the Windows helper verifies its
identity through `127.0.0.1`. Before publishing a capture URL and on every
snapshot save bind, it verifies a separate nonce route on that listener. Probes
never request the readiness route, whose GET acknowledges Studio
synchronization. A failed probe is `wsl_network_unreachable`, with a hint to
check localhost forwarding, networking mode, and the firewall. There is no
relay.

## Consequences

HTTP does not provide the control endpoint's OS user isolation. Possession of
the secret grants access to the capture channel, so it remains separate from
control authentication. Loopback binding, request identity checks, session
rotation, and excluding the secret from saved content bound that exposure.
