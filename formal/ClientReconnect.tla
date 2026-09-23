---------------------------- MODULE ClientReconnect ----------------------------
(***************************************************************************)
(* spacemolt-lib SpacemoltClient-managed reconnect for one account id.     *)
(*                                                                         *)
(*  handleAccountDisconnected enqueues reconnectOnce() on the shared       *)
(*  rate-limited queue; the task may run much later (batch waits of 65 s). *)
(*  remove()/closeAll() close the Account and drop it from `connected`;    *)
(*  connect(id) then creates a fresh Account for the same player.          *)
(*  The server keeps one session per player: a new login replaces the old *)
(*  one with close 4001 (terminal for the client).                         *)
(*                                                                         *)
(* Fixed: reconnectOnce refuses to run on an Account that was closed.      *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT Fixed

Accts == {"old", "new"}

VARIABLES
  sock,     \* sock[a]: "none", "open", "dead"
  closed,   \* closed[a]: close() was called (Account.userClosing)
  queued,   \* a reconnect task for "old" waits in the queue
  current,  \* the Account in client.connected, or "none"
  replaced  \* history: a live, wanted Account was kicked by session_replaced

vars == <<sock, closed, queued, current, replaced>>

Init == /\ sock = [a \in Accts |-> IF a = "old" THEN "open" ELSE "none"]
        /\ closed = [a \in Accts |-> FALSE]
        /\ queued = FALSE /\ current = "old" /\ replaced = FALSE

\* The server logs a socket in; any other live session for the player is
\* closed with 4001.
Login(a) ==
  /\ sock' = [b \in Accts |-> IF b = a THEN "open"
                              ELSE IF sock[b] = "open" THEN "dead" ELSE sock[b]]
  /\ replaced' = (replaced \/ \E b \in Accts : b # a /\ sock[b] = "open" /\ b = current)

\* Server restart / network drop on the old account: reconnect is queued.
Drop ==
  /\ sock["old"] = "open" /\ current = "old" /\ ~queued
  /\ sock' = [sock EXCEPT !["old"] = "dead"] /\ queued' = TRUE
  /\ UNCHANGED <<closed, current, replaced>>

\* The user calls closeAll() (or remove(id)).
CloseAll ==
  /\ current = "old"
  /\ closed' = [closed EXCEPT !["old"] = TRUE]
  /\ sock' = [sock EXCEPT !["old"] = IF @ = "open" THEN "dead" ELSE @]
  /\ current' = "none"
  /\ UNCHANGED <<queued, replaced>>

\* ... and later connect(id) again: a fresh Account logs the player in.
Reconnect ==
  /\ current = "none" /\ sock["new"] = "none"
  /\ current' = "new"
  /\ Login("new")
  /\ UNCHANGED <<closed, queued>>

\* The queued task finally runs reconnectOnce() on the old Account.
RunQueued ==
  /\ queued
  /\ queued' = FALSE
  /\ IF Fixed /\ closed["old"]
       THEN UNCHANGED <<sock, replaced>>
       ELSE Login("old")
  /\ UNCHANGED <<closed, current>>

Next == Drop \/ CloseAll \/ Reconnect \/ RunQueued

Spec == Init /\ [][Next]_vars

\* An Account the user closed never holds a live session again.
ClosedStaysClosed == \A a \in Accts : closed[a] => sock[a] # "open"

\* A connection the client is tracking is never kicked by a zombie.
NoZombieKick == ~replaced
=============================================================================
