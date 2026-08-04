# One Railway service, serving the client from the game server

The client and the socket server deploy as a single service on one origin: the Node
entrypoint serves the built client's static files and Socket.io from the same port. So
`index.ts`, which until now bound a port and did nothing else, grows a static file handler
with an SPA fallback — hand-rolled rather than pulling in a web framework, so `socket.io`
remains the only runtime dependency.

The alternative was two services: a static host for the client, the Node process for the
game. That is the more conventional split and has one genuine advantage here — rooms are
held in memory, so every server restart drops every match in progress, and separating the
two would mean client redeploys stop killing live games. It was judged not to matter yet,
with no players to disturb, against the cost of a second deployment, a build-time socket
URL, and CORS configuration on the `io` server. Same-origin needs no configuration at all,
and splitting later is cheap: `cors: { origin }` plus an environment variable.

The consequence worth remembering is exactly the advantage given up. This couples client
deploys to server restarts, and while rooms are in memory that means shipping a CSS change
ends every game being played. If that becomes a real cost, splitting the services is the
fix — not adding persistence.
