# Formal models

TLA+ models of the library's concurrent state machines. Check one with the
TLC model checker ([tla2tools.jar](https://github.com/tlaplus/tlaplus/releases)):

```bash
java -cp tla2tools.jar tlc2.TLC -deadlock -config formal/AccountReconnect.cfg formal/AccountReconnect.tla
```

| Model | What it checks |
|---|---|
| `AccountReconnect.tla` | `Account` socket lifecycle and `reconnectLoop`. A close event from a replaced socket must not fail requests on the live socket or tear the live socket down. `AccountReconnect-bug.cfg` sets `Fixed = FALSE` and shows the 11-step counterexample. |
