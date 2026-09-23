---------------------------- MODULE AccountReconnect ----------------------------
(***************************************************************************)
(* Model of spacemolt-lib src/account.ts connection lifecycle:             *)
(*   makeSocket / open / authExchange / handleClose / reconnectLoop /      *)
(*   reconnectOnce, plus user requests through the Correlator.             *)
(*                                                                         *)
(* Each WebSocket the Account creates is a "generation" g. A close event   *)
(* from socket g reaches Account.handleClose (Socket.markClosed only       *)
(* dedupes per socket instance). The close handshake after a local         *)
(* ws.close() completes at an arbitrary later time.                        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS MaxGen, Reqs, Fixed  \* Fixed: ignore events from a replaced socket

Gens == 1..MaxGen

VARIABLES
  sock,         \* sock[g] \in {"none","connecting","open","closing","dead"}
  delivered,    \* gens whose close event handleClose already ran for
  cur,          \* generation of Account.socket
  srvAuth,      \* gens the server has logged in
  authed,       \* Account._authenticated
  pendingAuth,  \* Account.pendingAuth # null
  loop,         \* reconnectLoop pc
  attemptClose, \* Account.attemptClose # null
  req,          \* user requests: [st, gen]
  spurious,     \* history: a request on a live socket was rejected
  killedHealthy \* history: reconnectOnce closed a live, logged-in socket

vars == <<sock, delivered, cur, srvAuth, authed, pendingAuth, loop,
          attemptClose, req, spurious, killedHealthy>>

Init ==
  /\ sock = [g \in Gens |-> IF g = 1 THEN "open" ELSE "none"]
  /\ delivered = {}
  /\ cur = 1
  /\ srvAuth = {1}
  /\ authed = TRUE
  /\ pendingAuth = FALSE
  /\ loop = "idle"
  /\ attemptClose = FALSE
  /\ req = [r \in Reqs |-> [st |-> "idle", gen |-> 0]]
  /\ spurious = FALSE
  /\ killedHealthy = FALSE

(* ---- user --------------------------------------------------------------- *)

\* A well-behaved caller: only sends while the account reports authenticated.
Send(r) ==
  /\ req[r].st = "idle"
  /\ authed
  /\ sock[cur] = "open"
  /\ req' = [req EXCEPT ![r] = [st |-> "pending", gen |-> cur]]
  /\ UNCHANGED <<sock, delivered, cur, srvAuth, authed, pendingAuth, loop,
                 attemptClose, spurious, killedHealthy>>

Reply(r) ==
  /\ req[r].st = "pending"
  /\ sock[req[r].gen] = "open"
  /\ req' = [req EXCEPT ![r].st = "ok"]
  /\ UNCHANGED <<sock, delivered, cur, srvAuth, authed, pendingAuth, loop,
                 attemptClose, spurious, killedHealthy>>

(* ---- environment -------------------------------------------------------- *)

(* ---- Account.handleClose, fired by socket g's close event --------------- *)

HandleClose(g) ==
  /\ delivered' = delivered \cup {g}
  /\ authed' = FALSE
  \* correlator.rejectAll: every in-flight request, whatever socket it used
  /\ req' = [r \in Reqs |-> IF req[r].st = "pending"
                              THEN [req[r] EXCEPT !.st = "rejected"]
                              ELSE req[r]]
  /\ spurious' = (spurious \/ \E r \in Reqs : req[r].st = "pending"
                                            /\ req[r].gen # g
                                            /\ sock[req[r].gen] = "open")
  /\ pendingAuth' = FALSE
  /\ IF loop = "idle"
       THEN /\ loop' = "backoff"          \* shouldReconnect -> reconnectLoop
            /\ attemptClose' = attemptClose
       ELSE /\ attemptClose' = TRUE        \* reconnecting: hand to the loop
            \* welcomeWaiter / pendingAuth are account-wide, so any close
            \* fails the attempt in flight; socket.connect() only for its own.
            /\ loop' = CASE loop = "welcome" -> "backoff"
                         [] loop = "auth" /\ pendingAuth -> "backoff"
                         [] loop = "connecting" /\ g = cur -> "backoff"
                         [] OTHER -> loop
  /\ UNCHANGED <<cur, killedHealthy>>

\* Network drop / server restart: the transport dies abruptly and the close
\* event fires right away.
ServerKill(g) ==
  /\ sock[g] \in {"open", "connecting"}
  /\ sock' = [sock EXCEPT ![g] = "dead"]
  /\ srvAuth' = srvAuth \ {g}
  /\ HandleClose(g)

\* A locally initiated ws.close() finishes its close handshake at an
\* arbitrary later time (an unresponsive peer can take tens of seconds),
\* and only then does the close event fire.
DeliverClose(g) ==
  /\ sock[g] = "closing"
  /\ sock' = [sock EXCEPT ![g] = "dead"]
  /\ srvAuth' = srvAuth \ {g}
  /\ IF Fixed /\ g # cur
       THEN UNCHANGED <<delivered, cur, authed, pendingAuth, loop, attemptClose,
                        req, spurious, killedHealthy>>
       ELSE HandleClose(g)

(* ---- reconnectLoop / reconnectOnce -------------------------------------- *)

\* After backoff: reconnectOnce() closes the current socket and makes a new one.
StartAttempt ==
  /\ loop = "backoff"
  /\ cur < MaxGen
  /\ attemptClose' = FALSE
  /\ killedHealthy' = (killedHealthy \/ (sock[cur] = "open" /\ cur \in srvAuth))
  /\ sock' = [sock EXCEPT ![cur] = IF @ \in {"open", "connecting"} THEN "closing" ELSE @,
                          ![cur + 1] = "connecting"]
  /\ cur' = cur + 1
  /\ loop' = "connecting"
  /\ UNCHANGED <<delivered, srvAuth, authed, pendingAuth, req, spurious>>

Opened ==
  /\ loop = "connecting"
  /\ sock[cur] = "connecting"
  /\ sock' = [sock EXCEPT ![cur] = "open"]
  /\ loop' = "welcome"
  /\ UNCHANGED <<delivered, cur, srvAuth, authed, pendingAuth, attemptClose,
                 req, spurious, killedHealthy>>

\* welcome arrives; authExchange sends login.
Welcome ==
  /\ loop = "welcome"
  /\ sock[cur] = "open"
  /\ pendingAuth' = TRUE
  /\ loop' = "auth"
  /\ UNCHANGED <<sock, delivered, cur, srvAuth, authed, attemptClose, req,
                 spurious, killedHealthy>>

\* open(): no welcome within connectTimeoutMs -> socket.close(), throw.
WelcomeTimeout ==
  /\ loop = "welcome"
  /\ sock' = [sock EXCEPT ![cur] = IF @ = "open" THEN "closing" ELSE @]
  /\ loop' = "backoff"
  /\ UNCHANGED <<delivered, cur, srvAuth, authed, pendingAuth, attemptClose,
                 req, spurious, killedHealthy>>

LoggedIn ==
  /\ loop = "auth"
  /\ pendingAuth
  /\ sock[cur] = "open"
  /\ srvAuth' = srvAuth \cup {cur}
  /\ authed' = TRUE
  /\ pendingAuth' = FALSE
  /\ loop' = "check"
  /\ UNCHANGED <<sock, delivered, cur, attemptClose, req, spurious, killedHealthy>>

AuthTimeout ==
  /\ loop = "auth"
  /\ pendingAuth
  /\ pendingAuth' = FALSE
  /\ loop' = "backoff"
  /\ UNCHANGED <<sock, delivered, cur, srvAuth, authed, attemptClose, req,
                 spurious, killedHealthy>>

\* if (!this.attemptClose) { reconnecting = false; onReconnected }
Check ==
  /\ loop = "check"
  /\ loop' = IF attemptClose THEN "backoff" ELSE "idle"
  /\ UNCHANGED <<sock, delivered, cur, srvAuth, authed, pendingAuth,
                 attemptClose, req, spurious, killedHealthy>>

Next ==
  \/ \E r \in Reqs : Send(r) \/ Reply(r)
  \/ \E g \in Gens : ServerKill(g) \/ DeliverClose(g)
  \/ StartAttempt \/ Opened \/ Welcome \/ WelcomeTimeout
  \/ LoggedIn \/ AuthTimeout \/ Check

Spec == Init /\ [][Next]_vars

(* ---- properties ---------------------------------------------------------- *)

TypeOK == loop \in {"idle", "backoff", "connecting", "welcome", "auth", "check"}

\* A request on a healthy socket is never failed by some other socket's close.
NoSpuriousReject == ~spurious

\* The loop never tears down a connection that is open and logged in.
NoHealthyTeardown == ~killedHealthy

\* When no reconnect is running and the live socket is logged in, the
\* account agrees it is authenticated.
AuthAgrees == (loop = "idle" /\ sock[cur] = "open" /\ cur \in srvAuth) => authed
=============================================================================
