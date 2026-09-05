"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const WebSocket = require("ws");
const { RoomServer, compatibilityDifference } = require("../src/room-server");

function next(socket, predicate = () => true, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Таймаут ожидания сообщения")), timeoutMs);
        const listener = raw => {
            const message = JSON.parse(raw.toString());
            if (!predicate(message)) return;
            clearTimeout(timer); socket.off("message", listener); resolve(message);
        };
        socket.on("message", listener);
    });
}

async function connect(url, hello) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const welcome = next(socket, message => message.type === "welcome" || message.type === "operation-rejected");
    socket.send(JSON.stringify(hello));
    return { socket, welcome: await welcome };
}

const hello = (role, roomId, mods = [{ id: "base-helper", version: "1.0.0" }]) => ({
    type: "hello", protocolVersion: 2, role, roomId, name: role, gameVersion: "1.5.7", modVersion: "1.1.0", mods,
});

test("разница модов показывает missing, extra и несовпадающие версии", () => {
    const diff = compatibilityDifference(
        hello("host", null, [{ id: "a", version: "1" }, { id: "b", version: "2" }]),
        hello("client", "ROOM", [{ id: "b", version: "3" }, { id: "c", version: "1" }])
    );
    assert.deepEqual(diff.missing.map(x => x.id), ["a"]);
    assert.deepEqual(diff.extra.map(x => x.id), ["c"]);
    assert.deepEqual(diff.versionMismatch, [{ id: "b", host: "2", client: "3" }]);
});

test("два клиента: hello/welcome, snapshot, operation, cursor, chat, disconnect и reconnect", async t => {
    const server = new RoomServer({ host: "127.0.0.1", port: 0, heartbeatIntervalMs: 1000, clientTimeoutMs: 5000 });
    await server.listen();
    t.after(() => server.close());
    const url = `ws://127.0.0.1:${server.address().port}`;
    const host = await connect(url, hello("host"));
    const roomId = host.welcome.roomId;
    assert.equal(host.welcome.playerId, 1);

    const hostSawHello = next(host.socket, m => m.type === "peer-message" && m.payload.t === "hello");
    const client = await connect(url, hello("client", roomId));
    assert.equal(client.welcome.playerId, 2);
    assert.equal((await hostSawHello).from, 2);

    const snapshot = { t: "welcome", yourId: 2, dump: "snapshot-data", players: [] };
    const clientSnapshot = next(client.socket, m => m.type === "resync");
    host.socket.send(JSON.stringify({ type: "resync", to: 2, payload: snapshot }));
    assert.deepEqual((await clientSnapshot).payload, snapshot);

    const operations = [
        { k: "place", operationId: "2:1", senderId: 2, sequence: 1 },
        { k: "place-batch", operationId: "2:2", senderId: 2, sequence: 2, items: [] },
        { k: "delete", operationId: "2:3", senderId: 2, sequence: 3, uids: [10] },
        { k: "delete-batch", operationId: "2:4", senderId: 2, sequence: 4, uids: [10, 11] },
        { k: "blueprint", operationId: "2:5", senderId: 2, sequence: 5, entities: [] },
        { k: "lever", operationId: "2:6", senderId: 2, sequence: 6 },
        { k: "constant-signal", operationId: "2:7", senderId: 2, sequence: 7 },
        { k: "upgrade", operationId: "2:8", senderId: 2, sequence: 8 },
    ];
    for (const operation of operations) {
        const received = next(host.socket, m => m.type === "peer-message" && m.payload.op && m.payload.op.operationId === operation.operationId);
        client.socket.send(JSON.stringify({ type: "operation", payload: { t: "op", op: operation } }));
        assert.deepEqual((await received).payload.op, operation);
    }

    for (const type of ["cursor", "chat", "request-resync", "ping"]) {
        const received = next(host.socket, m => m.type === "peer-message" && m.payload.t === type);
        client.socket.send(JSON.stringify({ type, payload: { t: type, marker: type } }));
        assert.equal((await received).payload.marker, type);
    }

    const disconnected = next(host.socket, m => m.type === "peer-disconnected");
    client.socket.close();
    assert.equal((await disconnected).playerId, 2);
    const reconnectedHello = next(host.socket, m => m.type === "peer-message" && m.payload.t === "hello");
    const client2 = await connect(url, hello("client", roomId));
    assert.equal(client2.welcome.playerId, 3);
    await reconnectedHello;
    client2.socket.close(); host.socket.close();
});

test("несовпадающие моды отклоняются до входа в комнату", async t => {
    const server = new RoomServer({ host: "127.0.0.1", port: 0 });
    await server.listen(); t.after(() => server.close());
    const url = `ws://127.0.0.1:${server.address().port}`;
    const host = await connect(url, hello("host"));
    const client = await connect(url, hello("client", host.welcome.roomId, [{ id: "other", version: "1" }]));
    assert.equal(client.welcome.type, "operation-rejected");
    assert.equal(client.welcome.details.missing[0].id, "base-helper");
    client.socket.close(); host.socket.close();
});
