"use strict";

const assert = require("node:assert/strict");
const WebSocket = require("ws");

const debugPort = Number(process.argv[2] || 19222);
const serverUrl = process.argv[3] || "ws://127.0.0.1:17878";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function findPage() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
            const page = pages.find(item => item.type === "page" && item.webSocketDebuggerUrl);
            if (page) return page;
        } catch {}
        await delay(200);
    }
    throw new Error("Не найден Electron DevTools endpoint");
}

async function cdpClient(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    let nextId = 1;
    const pending = new Map();
    socket.on("message", raw => {
        const message = JSON.parse(raw.toString());
        if (!message.id || !pending.has(message.id)) return;
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    });
    return {
        socket,
        call(method, params = {}) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                socket.send(JSON.stringify({ id, method, params }));
            });
        },
    };
}

async function evaluate(cdp, expression, awaitPromise = false) {
    const response = await cdp.call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Ошибка Runtime.evaluate");
    return response.result.value;
}

function messages(socket) {
    const queue = [];
    const waiters = [];
    socket.on("message", raw => {
        const message = JSON.parse(raw.toString());
        const index = waiters.findIndex(waiter => waiter.predicate(message));
        if (index >= 0) {
            const [waiter] = waiters.splice(index, 1);
            clearTimeout(waiter.timer); waiter.resolve(message);
        } else queue.push(message);
    });
    return predicate => new Promise((resolve, reject) => {
        const index = queue.findIndex(predicate);
        if (index >= 0) return resolve(queue.splice(index, 1)[0]);
        const waiter = { predicate, resolve, reject };
        waiter.timer = setTimeout(() => {
            const at = waiters.indexOf(waiter); if (at >= 0) waiters.splice(at, 1);
            reject(new Error("Таймаут игрового WebSocket-сообщения"));
        }, 10000);
        waiters.push(waiter);
    });
}

async function main() {
    const page = await findPage();
    const cdp = await cdpClient(page.webSocketDebuggerUrl);
    await cdp.call("Runtime.enable");
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await evaluate(cdp, "Boolean(window.shapez && shapez.MODS && shapez.MODS.initialized)")) break;
        await delay(100);
    }
    let modInfo;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        modInfo = await evaluate(cdp, `(() => {
            const mod = shapez.MODS.mods.find(item => item.metadata.id === "multiplay");
            return mod && { version: mod.metadata.version, ipc: /ipcRenderer/.test(mod.constructor.toString()), menu: [...document.querySelectorAll("button")].some(button => button.textContent === "Мультиплеер") };
        })()`);
        if (modInfo && modInfo.menu) break;
        await delay(100);
    }
    assert.deepEqual(modInfo, { version: "1.1.0", ipc: false, menu: true });

    const host = await evaluate(cdp, `(async () => {
        const mod = shapez.MODS.mods.find(item => item.metadata.id === "multiplay");
        mod.askName = async () => "E2EHost";
        mod.askText = async () => ${JSON.stringify(serverUrl)};
        window.__mpSmokeError = null;
        await mod.hostFlow({ dialogs: {
            showWarning: (...args) => { window.__mpSmokeError = args.join(" "); },
            internalShowDialog: () => {},
            showInfo: () => {}
        }});
        if (window.__mpSmokeError) throw new Error(window.__mpSmokeError);
        const savegame = mod.app.savegameMgr.createNewSavegame();
        mod.app.stateMgr.moveToState("InGameState", { savegame });
        return { role: mod.role, roomId: mod.roomId, hello: mod.makeHello("client", mod.roomId) };
    })()`, true);
    assert.equal(host.role, "host");

    let world;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        world = await evaluate(cdp, `(() => { const mod=shapez.MODS.mods.find(item=>item.metadata.id==="multiplay"); return mod.session && mod.session.root.gameInitialized ? {seed:mod.session.root.map.seed, entities:mod.session.root.entityMgr.entities.length}:null; })()`);
        if (world) break;
        await delay(100);
    }
    assert.ok(world && Number.isInteger(world.seed));

    const client = new WebSocket(serverUrl);
    const next = messages(client);
    await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    client.send(JSON.stringify(host.hello));
    const serverWelcome = await next(message => message.type === "welcome");
    const playerId = serverWelcome.playerId;
    const snapshot = await next(message => message.payload && message.payload.t === "welcome");
    assert.ok(snapshot.payload.dump.length > 100);

    let sequence = 0;
    const sendOperation = op => {
        sequence += 1;
        client.send(JSON.stringify({ type: "operation", payload: { t: "op", op: { ...op, operationId: `${playerId}:e2e:${sequence}`, senderId: playerId, sequence } } }));
    };
    sendOperation({ k: "place", intent: true, building: "belt", variant: "default", origin: { x: 30, y: 30 }, rotation: 0, originalRotation: 0 });
    const single = await next(message => message.payload && message.payload.t === "op" && message.payload.op.k === "place");
    const singleUid = single.payload.op.uid;
    assert.ok(Number.isInteger(singleUid));

    for (let index = 0; index < 20; index += 1) {
        sendOperation({ k: "place", intent: true, building: "belt", variant: "default", origin: { x: 40 + index, y: 40 }, rotation: 0, originalRotation: 0 });
    }
    const drag = await next(message => message.payload && message.payload.t === "op" && message.payload.op.k === "place-batch");
    assert.equal(drag.payload.op.items.length, 20);

    const components = single.payload.op.e.components;
    sendOperation({ k: "blueprint", intent: true, tile: { x: 70, y: 70 }, entities: [
        { b: "belt", v: "default", w: 0, x: 0, y: 0, r: 0, o: 0, c: components },
        { b: "belt", v: "default", w: 0, x: 1, y: 0, r: 0, o: 0, c: components },
    ] });
    const blueprint = await next(message => message.payload && message.payload.t === "op" && message.payload.op.k === "place-batch");
    assert.equal(blueprint.payload.op.items.length, 2);

    sendOperation({ k: "delete-batch", intent: true, uids: [singleUid] });
    const deleted = await next(message => message.payload && message.payload.t === "op" && (message.payload.op.k === "delete" || message.payload.op.k === "delete-batch"));
    assert.ok(deleted.payload.op.uids.includes(singleUid));

    client.send(JSON.stringify({ type: "chat", payload: { t: "chat", text: "e2e-chat" } }));
    client.send(JSON.stringify({ type: "ping", payload: { t: "ping", time: 12345 } }));
    const pong = await next(message => message.payload && message.payload.t === "pong");
    assert.equal(pong.payload.time, 12345);
    client.send(JSON.stringify({ type: "request-resync", payload: { t: "request-resync" } }));
    const resync = await next(message => message.payload && message.payload.t === "resync");
    assert.ok(resync.payload.dump.length > 100);

    const finalState = await evaluate(cdp, `(() => { const mod=shapez.MODS.mods.find(item=>item.metadata.id==="multiplay"); return {role:mod.role, players:mod.players.size, chat:mod.session.chatLines.some(line=>line.text==="e2e-chat"), seed:mod.session.root.map.seed, entities:mod.session.root.entityMgr.entities.length}; })()`);
    assert.equal(finalState.role, "host");
    assert.equal(finalState.chat, true);
    assert.equal(finalState.seed, world.seed);
    assert.ok(finalState.entities >= world.entities + 21);
    await evaluate(cdp, `(() => { const mod=shapez.MODS.mods.find(item=>item.metadata.id==="multiplay"); mod.leaveSession(false); return mod.role; })()`);
    const disconnected = await next(message => message.type === "disconnect");
    assert.match(disconnected.reason, /Хост/);
    client.close();
    cdp.socket.close();
    console.log("GAME_E2E_OK", JSON.stringify({ roomId: host.roomId, initial: world, final: finalState }));
}

main().catch(error => {
    console.error("GAME_E2E_FAIL", error.stack || error);
    process.exitCode = 1;
});
