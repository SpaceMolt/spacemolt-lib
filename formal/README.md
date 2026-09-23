# Formal models

TLA+ models of the library's concurrent state machines. Check one with the
TLC model checker ([tla2tools.jar](https://github.com/tlaplus/tlaplus/releases)):

```bash
java -cp tla2tools.jar tlc2.TLC -deadlock -config formal/AccountReconnect.cfg formal/AccountReconnect.tla
```

| Model | What it checks |
|---|---|
| `AccountReconnect.tla` | `Account` socket lifecycle and `reconnectLoop`. A close event from a replaced socket must not fail requests on the live socket or tear the live socket down. `AccountReconnect-bug.cfg` sets `Fixed = FALSE` and shows the 11-step counterexample. |
| `CacheSeed.tla` | `refresh()` seeding the state cache while tick deltas arrive. A `get_status` snapshot taken before a delta must not overwrite that delta. `CacheSeed-bug.cfg` shows the 6-step counterexample. |
| `ClientReconnect.tla` | `SpacemoltClient` reconnects queued on the shared rate-limited queue vs `closeAll()`/`remove()`. A closed account never logs back in, and never kicks a newer session for the same player. `ClientReconnect-bug.cfg` shows the 4-step counterexample. |
