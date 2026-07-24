// Fail-safe entry point — some hosts (like a stale Render Start Command)
// default to `node index.js`. This just hands off to the real app in
// server.js, so the app boots correctly no matter which entry Render runs.
require('./server.js');
