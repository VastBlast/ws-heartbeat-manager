import { performance } from 'node:perf_hooks';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import type { WebSocket } from 'ws';

export type HeartbeatManagerOptions = Readonly<{
    intervalMs?: number;     // default 30s
    timeoutMs?: number;      // default 2 * intervalMs
    tickMs?: number;         // default min(1000, intervalMs)
    startJitterMs?: number;  // default intervalMs
    maxBuckets?: number;     // default 60
}>;

type ClientState = {
    lastPongAt: number;
    bucket: number;
    onPong: () => void;
    onClose: () => void;
    onError: (err: Error) => void;
};

const WS_OPEN = 1 as const; // avoids value import; ws readyState OPEN is 1

export class HeartbeatManager {
    private readonly clients = new Map<WebSocket, ClientState>();
    private readonly buckets: Array<Set<WebSocket>>;
    private bucketIndex = 0;

    private startDelayTimer?: NodeJS.Timeout;
    private tickTimer?: NodeJS.Timeout;

    private readonly intervalMs: number;
    private readonly timeoutMs: number;
    private readonly tickMs: number;
    private readonly startJitterMs: number;

    constructor(opts: HeartbeatManagerOptions = {}) {
        this.intervalMs = opts.intervalMs ?? 30_000;
        this.timeoutMs = opts.timeoutMs ?? this.intervalMs * 2;

        if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
            throw new RangeError('intervalMs must be a finite number > 0');
        }
        if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < this.intervalMs) {
            throw new RangeError('timeoutMs must be a finite number >= intervalMs');
        }

        const desiredTickMs = opts.tickMs ?? Math.min(1000, this.intervalMs);
        const maxBuckets = opts.maxBuckets ?? 60;
        this.startJitterMs = opts.startJitterMs ?? this.intervalMs;

        if (!Number.isFinite(desiredTickMs) || desiredTickMs <= 0) {
            throw new RangeError('tickMs must be a finite number > 0');
        }
        if (!Number.isInteger(maxBuckets) || maxBuckets < 1) {
            throw new RangeError('maxBuckets must be an integer >= 1');
        }
        if (!Number.isFinite(this.startJitterMs) || this.startJitterMs < 0) {
            throw new RangeError('startJitterMs must be a finite number >= 0');
        }

        const bucketCount = Math.min(
            maxBuckets,
            Math.max(1, Math.round(this.intervalMs / Math.max(50, desiredTickMs)))
        );

        // Rotate through all buckets roughly once per intervalMs.
        this.tickMs = Math.max(10, Math.round(this.intervalMs / bucketCount));

        this.buckets = Array.from({ length: bucketCount }, () => new Set<WebSocket>());
    }

    get clientCount(): number {
        return this.clients.size;
    }

    addClient(ws: WebSocket): void {
        if (this.clients.has(ws)) return; // prevents duplicate listeners

        const bucket = Math.floor(Math.random() * this.buckets.length);

        const state: ClientState = {
            lastPongAt: performance.now(),
            bucket,
            onPong: () => {
                state.lastPongAt = performance.now();
            },
            onClose: () => {
                this.removeClient(ws);
            },
            onError: () => {
                this.removeClient(ws, true);
            },
        };

        this.clients.set(ws, state);
        this.bucketAt(bucket).add(ws);

        ws.on('pong', state.onPong);
        ws.once('close', state.onClose);
        ws.once('error', state.onError);

        this.startTimersIfNeeded();
    }

    removeClient(ws: WebSocket, terminate = false): void {
        if (terminate) try { ws.terminate(); } catch { }

        const state = this.clients.get(ws);
        if (!state) return;

        ws.off('pong', state.onPong);
        ws.off('close', state.onClose);
        ws.off('error', state.onError);

        this.bucketAt(state.bucket).delete(ws);
        this.clients.delete(ws);

        if (this.clients.size === 0) this.stopTimers();
    }

    shutdown(): void {
        this.stopTimers();
        for (const ws of Array.from(this.clients.keys())) {
            this.removeClient(ws, true);
        }
    }

    private bucketAt(index: number): Set<WebSocket> {
        // Satisfies `noUncheckedIndexedAccess` and defends against index drift.
        const first = this.buckets[0];
        if (!first) throw new Error('HeartbeatManager misconfigured: no buckets');
        return this.buckets[index] ?? first;
    }

    private startTimersIfNeeded(): void {
        if (this.tickTimer || this.startDelayTimer) return;

        const delay = this.startJitterMs > 0 ? Math.floor(Math.random() * this.startJitterMs) : 0;

        if (delay === 0) {
            this.startTickTimer();
            return;
        }

        this.startDelayTimer = setTimeout(() => {
            this.startDelayTimer = undefined;
            if (this.clients.size > 0) this.startTickTimer();
        }, delay);

        this.startDelayTimer.unref();
    }

    private startTickTimer(): void {
        if (this.tickTimer) return;
        this.tickTimer = setInterval(() => this.tick(), this.tickMs);
        this.tickTimer.unref();
    }

    private stopTimers(): void {
        if (this.startDelayTimer) {
            clearTimeout(this.startDelayTimer);
            this.startDelayTimer = undefined;
        }
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = undefined;
        }
    }

    private tick(): void {
        const now = performance.now();
        const bucket = this.bucketAt(this.bucketIndex);

        for (const ws of bucket) {
            const state = this.clients.get(ws);
            if (!state) {
                bucket.delete(ws);
                continue;
            }

            if (ws.readyState !== WS_OPEN) {
                this.removeClient(ws);
                continue;
            }

            if (now - state.lastPongAt > this.timeoutMs) {
                this.removeClient(ws, true);
                continue;
            }

            try {
                ws.ping();
            } catch {
                this.removeClient(ws, true);
            }
        }

        this.bucketIndex += 1;
        if (this.bucketIndex >= this.buckets.length) this.bucketIndex = 0;
    }
}
