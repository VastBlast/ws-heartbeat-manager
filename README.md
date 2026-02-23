# ws-heartbeat-manager

Lightweight heartbeat manager for `ws` server connections.

## Install

```bash
npm i ws-heartbeat-manager
```

Peer dependency: `ws@^8`.

## What it does

- Tracks active clients.
- Sends periodic `ping` frames.
- Updates liveness on `pong`.
- Terminates timed-out or errored sockets.
- Cleans up listeners and timers automatically.

## Basic usage

```ts
import { WebSocketServer } from 'ws';
import { HeartbeatManager } from 'ws-heartbeat-manager';

const wss = new WebSocketServer({ port: 8080 });
const heartbeat = new HeartbeatManager();

wss.on('connection', (ws) => {
  heartbeat.addClient(ws);
});

process.on('SIGTERM', () => {
  heartbeat.shutdown();
  wss.close();
});
```

## Custom timing

```ts
const heartbeat = new HeartbeatManager({
  intervalMs: 15_000,   // send ping every 15s
  timeoutMs: 30_000,    // terminate if no pong for 30s
  tickMs: 500,          // internal sweep cadence
  startJitterMs: 15_000 // stagger start time
});
```

## API

- `new HeartbeatManager(options?)`
- `addClient(ws)`
- `removeClient(ws)`
- `shutdown()`
- `clientCount`
