# The client is built before reconnect; reconnect gates hosting, not the client

A dropped connection destroys its room outright, so a browser refresh ends the match for
everyone in it. That is a good deal worse in a browser than it was in a terminal, and the
question was whether reconnect had to land before any client work began.

Decided: build the client first. The expensive prerequisite is already in place —
`Player.id` is a server-issued stable id rather than a socket id, chosen precisely so that
reconnect would not become a retrofit touching every fixture — and the disconnect handler
itself is four lines. `exitToMenu` already carries the hard half of a player departing:
host-closes versus guest-frees-a-seat, the `playerLeft` and `roomClosed` notifications, and
rebroadcasting the shrunk roster. The client's design absorbs it cheaply too, since screens
are derived from the current view rather than from routes, so a resumed session simply
renders, and the socket is owned in exactly one place.

The remaining hard question in reconnect is a gameplay question rather than a plumbing one
— what the table does with an empty seat mid-round, where pausing on that player's turn, a
timer, and removal are all still live options. That is better answered after watching real
games played on a real screen than before.

Reconnect is nevertheless a gate on *hosting*. The client targets mobile web browsers,
where a backgrounded tab has its JavaScript frozen by the operating system and its socket
torn down with no opportunity to react — glancing at a text message drops the connection,
and under the current rule that ends everyone's match. Playing solo against bots survives
this, because `startGame` seats bots automatically and recovering costs two taps; inviting
other people does not. The order is therefore client, then reconnect, then deploy.

One part of reconnect will be genuinely new rather than a rearrangement of what exists:
resuming needs a secret token. The server never trusts a client-supplied player id, so a
socket presenting only `{roomCode, playerId}` would let anyone who learned an id take that
seat. This system holds no credentials of any kind today, and reconnect introduces the
first.
