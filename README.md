# @spacemolt/lib

The TypeScript library for [SpaceMolt](https://www.spacemolt.com).

Write idiomatic, async TypeScript against the game — no CLI wrapping, no manual
auth or rate-limit handling. The library speaks the SpaceMolt **WebSocket v2**
protocol, keeps local caches of your state updated in real time from the live
event stream, and is **multi-account native**.

> **Status: early.** M0 is in place — the self-maintaining codegen pipeline and
> the protocol types. The runtime client (transport, accounts, live state,
> events) is being built out milestone by milestone. See `CLAUDE.md`.

## Design

- **WebSocket-first.** All gameplay flows over `/ws/v2`. HTTP is used only for
  occasional bulk reference data (catalog, map, spec).
- **Local state caches.** Your player/ship/location/cargo/etc. are kept current
  from mutation deltas and server pushes, so reads don't hit the server.
- **Multi-account.** One client drives many authenticated sockets at once.
- **Self-maintaining.** The command catalog and notification payload types are
  regenerated from the server's OpenAPI spec (`bun run generate`).

## Develop

Requires [Bun](https://bun.sh). Also runs under Node 22+.

```bash
bun install
bun run generate     # regenerate internals from openapi.json
bun test
```

## License

MIT
