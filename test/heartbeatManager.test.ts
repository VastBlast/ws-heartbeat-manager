import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { HeartbeatManager } from '../src/heartbeatManager.ts';

type InternalClientState = {
    lastPongAt: number;
    bucket: number;
    onPong: () => void;
    onClose: () => void;
    onError: (err: Error) => void;
};

type InternalHeartbeatManager = {
    clients: Map<WebSocket, InternalClientState>;
    buckets: Array<Set<WebSocket>>;
    bucketIndex: number;
    tick: () => void;
    startTimersIfNeeded: () => void;
    stopTimers: () => void;
};

class MockWebSocket extends EventEmitter {
    readyState = 1;
    pingCount = 0;
    terminateCount = 0;
    throwOnPing = false;
    throwOnTerminate = false;

    ping(): void {
        this.pingCount += 1;
        if (this.throwOnPing) throw new Error('ping failed');
    }

    terminate(): void {
        this.terminateCount += 1;
        if (this.throwOnTerminate) throw new Error('terminate failed');
        this.readyState = 3;
    }
}

const CLOSED_STATE = 3;

const asWebSocket = (ws: MockWebSocket): WebSocket => ws as unknown as WebSocket;
const internal = (manager: HeartbeatManager): InternalHeartbeatManager =>
    manager as unknown as InternalHeartbeatManager;

const createManager = (overrides: ConstructorParameters<typeof HeartbeatManager>[0] = {}): HeartbeatManager => {
    const manager = new HeartbeatManager({
        intervalMs: 100,
        timeoutMs: 100,
        startJitterMs: 0,
        maxBuckets: 1,
        ...overrides,
    });

    vi.spyOn(internal(manager), 'startTimersIfNeeded').mockImplementation(() => { });
    return manager;
};

describe('HeartbeatManager', () => {
    let nowMs = 0;

    beforeEach(() => {
        nowMs = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('validates constructor options', () => {
        expect(() => new HeartbeatManager({ intervalMs: 0 })).toThrow('intervalMs');
        expect(() => new HeartbeatManager({ intervalMs: Number.NaN })).toThrow('intervalMs');
        expect(() => new HeartbeatManager({ intervalMs: 100, timeoutMs: 99 })).toThrow('timeoutMs');
        expect(() => new HeartbeatManager({ intervalMs: 100, timeoutMs: Number.POSITIVE_INFINITY })).toThrow('timeoutMs');
        expect(() => new HeartbeatManager({ tickMs: 0 })).toThrow('tickMs');
        expect(() => new HeartbeatManager({ tickMs: Number.NaN })).toThrow('tickMs');
        expect(() => new HeartbeatManager({ maxBuckets: 0 })).toThrow('maxBuckets');
        expect(() => new HeartbeatManager({ maxBuckets: 2.5 })).toThrow('maxBuckets');
        expect(() => new HeartbeatManager({ maxBuckets: Number.NaN })).toThrow('maxBuckets');
        expect(() => new HeartbeatManager({ startJitterMs: -1 })).toThrow('startJitterMs');
        expect(() => new HeartbeatManager({ startJitterMs: Number.NaN })).toThrow('startJitterMs');
    });

    it('ignores duplicate addClient calls and does not duplicate listeners', () => {
        const manager = createManager();
        const ws = new MockWebSocket();
        const socket = asWebSocket(ws);

        manager.addClient(socket);
        manager.addClient(socket);

        expect(manager.clientCount).toBe(1);
        expect(ws.listenerCount('pong')).toBe(1);
        expect(ws.listenerCount('close')).toBe(1);
        expect(ws.listenerCount('error')).toBe(1);
    });

    it('removes listeners and stops timers when the final client is removed', () => {
        const manager = createManager();
        const managerInternal = internal(manager);
        const stopSpy = vi.spyOn(managerInternal, 'stopTimers');
        const ws = new MockWebSocket();
        const socket = asWebSocket(ws);

        manager.addClient(socket);
        manager.removeClient(socket);

        expect(manager.clientCount).toBe(0);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(ws.listenerCount('pong')).toBe(0);
        expect(ws.listenerCount('close')).toBe(0);
        expect(ws.listenerCount('error')).toBe(0);

        expect(() => manager.removeClient(socket)).not.toThrow();
    });

    it('removes a client on close event', () => {
        const manager = createManager();
        const ws = new MockWebSocket();
        const socket = asWebSocket(ws);

        manager.addClient(socket);
        ws.emit('close');

        expect(manager.clientCount).toBe(0);
    });

    it('terminates and removes a client on error event, even if terminate throws', () => {
        const manager = createManager();
        const ws = new MockWebSocket();
        ws.throwOnTerminate = true;
        const socket = asWebSocket(ws);

        manager.addClient(socket);
        ws.emit('error', new Error('boom'));

        expect(ws.terminateCount).toBe(1);
        expect(manager.clientCount).toBe(0);
    });

    it('pings open clients during tick', () => {
        const manager = createManager();
        const ws = new MockWebSocket();
        const socket = asWebSocket(ws);

        manager.addClient(socket);
        nowMs = 10;
        internal(manager).tick();

        expect(ws.pingCount).toBe(1);
        expect(ws.terminateCount).toBe(0);
        expect(manager.clientCount).toBe(1);
    });

    it('removes clients that are no longer open without pinging', () => {
        const manager = createManager();
        const ws = new MockWebSocket();
        const socket = asWebSocket(ws);

        manager.addClient(socket);
        ws.readyState = CLOSED_STATE;
        internal(manager).tick();

        expect(ws.pingCount).toBe(0);
        expect(manager.clientCount).toBe(0);
    });

    it('respects timeout boundary: equal is allowed, greater triggers termination', () => {
        const manager = createManager({ intervalMs: 100, timeoutMs: 100 });
        const ws = new MockWebSocket();
        const socket = asWebSocket(ws);

        manager.addClient(socket);

        nowMs = 100;
        internal(manager).tick();
        expect(ws.terminateCount).toBe(0);
        expect(manager.clientCount).toBe(1);

        nowMs = 101;
        internal(manager).tick();
        expect(ws.terminateCount).toBe(1);
        expect(manager.clientCount).toBe(0);
    });

    it('refreshes heartbeat deadline on pong', () => {
        const manager = createManager({ intervalMs: 100, timeoutMs: 100 });
        const ws = new MockWebSocket();
        const socket = asWebSocket(ws);

        manager.addClient(socket);

        nowMs = 120;
        ws.emit('pong');

        nowMs = 210;
        internal(manager).tick();

        expect(ws.terminateCount).toBe(0);
        expect(ws.pingCount).toBe(1);
        expect(manager.clientCount).toBe(1);
    });

    it('terminates and removes clients when ping throws', () => {
        const manager = createManager();
        const ws = new MockWebSocket();
        ws.throwOnPing = true;
        const socket = asWebSocket(ws);

        manager.addClient(socket);
        internal(manager).tick();

        expect(ws.pingCount).toBe(1);
        expect(ws.terminateCount).toBe(1);
        expect(manager.clientCount).toBe(0);
    });

    it('drops stray sockets from buckets when no client state exists', () => {
        const manager = createManager();
        const managerInternal = internal(manager);
        const straySocket = asWebSocket(new MockWebSocket());

        const firstBucket = managerInternal.buckets[0];
        expect(firstBucket).toBeDefined();
        firstBucket?.add(straySocket);

        managerInternal.tick();

        expect(firstBucket?.has(straySocket)).toBe(false);
    });

    it('wraps bucket index after reaching the end', () => {
        const manager = createManager({ intervalMs: 400, timeoutMs: 400, tickMs: 100, maxBuckets: 4 });
        const managerInternal = internal(manager);

        managerInternal.bucketIndex = managerInternal.buckets.length - 1;
        managerInternal.tick();

        expect(managerInternal.bucketIndex).toBe(0);
    });

    it('shutdown terminates all clients and clears listeners', () => {
        const manager = createManager();
        const first = new MockWebSocket();
        const second = new MockWebSocket();
        second.throwOnTerminate = true;
        const firstSocket = asWebSocket(first);
        const secondSocket = asWebSocket(second);

        manager.addClient(firstSocket);
        manager.addClient(secondSocket);

        manager.shutdown();

        expect(first.terminateCount).toBe(1);
        expect(second.terminateCount).toBe(1);
        expect(manager.clientCount).toBe(0);
        expect(first.listenerCount('pong')).toBe(0);
        expect(first.listenerCount('close')).toBe(0);
        expect(first.listenerCount('error')).toBe(0);
        expect(second.listenerCount('pong')).toBe(0);
        expect(second.listenerCount('close')).toBe(0);
        expect(second.listenerCount('error')).toBe(0);
    });
});
