------------------------------- MODULE CacheSeed -------------------------------
(***************************************************************************)
(* spacemolt-lib StateCache freshness under Account.refresh().             *)
(*                                                                         *)
(* Server: the tick goroutine applies actions and pushes each action_result*)
(* delta; the readPump goroutine answers get_status by taking a snapshot   *)
(* and writing it later. Both write into one ordered socket.               *)
(* Client: refresh() sends get_status and seeds the cache from the reply;  *)
(* routeFrame applies each delta as it arrives.                            *)
(*                                                                         *)
(* State is abstracted to a version number; a delta or a snapshot carries  *)
(* the server version it describes.                                        *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS MaxActions, Fixed  \* Fixed: drop a snapshot if a delta landed meanwhile

VARIABLES
  srv,      \* server state version
  wire,     \* frames in flight, in order
  cache,    \* client cache version
  rev,      \* client stateRevision
  pcQ,      \* refresh(): "idle","sent","snap","done"
  snap,     \* version the server snapshot captured
  revAtSend \* stateRevision when refresh() sent get_status

vars == <<srv, wire, cache, rev, pcQ, snap, revAtSend>>

Init == srv = 0 /\ wire = <<>> /\ cache = 0 /\ rev = 0
        /\ pcQ = "idle" /\ snap = 0 /\ revAtSend = 0

\* Tick goroutine: execute an action, push its delta.
ServerAction ==
  /\ srv < MaxActions
  /\ srv' = srv + 1
  /\ wire' = Append(wire, [kind |-> "delta", v |-> srv + 1])
  /\ UNCHANGED <<cache, rev, pcQ, snap, revAtSend>>

ClientRefresh ==
  /\ pcQ = "idle"
  /\ pcQ' = "sent" /\ revAtSend' = rev
  /\ UNCHANGED <<srv, wire, cache, rev, snap>>

\* readPump goroutine: build the get_status reply ...
ServerSnapshot ==
  /\ pcQ = "sent"
  /\ snap' = srv /\ pcQ' = "snap"
  /\ UNCHANGED <<srv, wire, cache, rev, revAtSend>>

\* ... and write it, possibly after deltas the tick pushed in between.
ServerReply ==
  /\ pcQ = "snap"
  /\ wire' = Append(wire, [kind |-> "snapshot", v |-> snap])
  /\ pcQ' = "replied"
  /\ UNCHANGED <<srv, cache, rev, snap, revAtSend>>

ClientReceive ==
  /\ wire # <<>>
  /\ LET f == Head(wire) IN
       IF f.kind = "delta"
         THEN cache' = f.v /\ rev' = rev + 1 /\ pcQ' = pcQ
         ELSE /\ cache' = IF Fixed /\ rev # revAtSend THEN cache ELSE f.v
              /\ rev' = rev
              /\ pcQ' = "done"
  /\ wire' = Tail(wire)
  /\ UNCHANGED <<srv, snap, revAtSend>>

Next == ServerAction \/ ClientRefresh \/ ServerSnapshot \/ ServerReply
        \/ ClientReceive

Spec == Init /\ [][Next]_vars

\* Once the wire is drained, the cache matches the server.
Converges == wire = <<>> /\ pcQ \in {"idle", "done"} => cache = srv

\* The cache never moves backwards.
Monotonic == [][cache' >= cache]_cache
=============================================================================
