"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const modPath = path.resolve(__dirname, "..", "..", "shapez.io_mods", "multiplay.js");
const modCode = fs.readFileSync(modPath, "utf8");

function loadModClass() {
    const context = vm.createContext({
        console,
        URL,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        shapez: { Mod: class {}, BaseHUDPart: class {} },
    });
    vm.runInContext(modCode + ";globalThis.ModUnderTest=Mod;globalThis.protocolType=mpProtocolType;", context, { filename: modPath });
    return context;
}

test("Steam-совместимый мод не зависит от Electron IPC", () => {
    assert.doesNotMatch(modCode, /\bipcRenderer\b/);
    assert.match(modCode, /new WebSocket\(this\.url\)/);
    assert.match(modCode, /class MpTransportHost extends MpWebSocketTransport/);
});

test("типы place, place-batch, delete, blueprint и служебные сообщения отображаются в протокол", () => {
    const context = loadModClass();
    for (const kind of ["place", "place-batch", "delete", "delete-batch", "blueprint", "lever", "constant-signal", "upgrade"]) {
        assert.equal(context.protocolType({ t: "op", op: { k: kind } }), "operation");
    }
    assert.equal(context.protocolType({ t: "cursor" }), "cursor");
    assert.equal(context.protocolType({ t: "chat" }), "chat");
    assert.equal(context.protocolType({ t: "resync" }), "resync");
});

test("operationId и sequence обеспечивают идемпотентность", () => {
    const { ModUnderTest } = loadModClass();
    const mod = Object.create(ModUnderTest.prototype);
    mod.operationSequence = 0;
    mod.seenOperationIds = new Set();
    mod.lastOperationSequence = new Map();
    const first = mod.decorateOperation({ k: "place" }, 2);
    assert.equal(first.senderId, 2);
    assert.equal(first.sequence, 1);
    assert.equal(mod.rememberOperation(first), true);
    assert.equal(mod.rememberOperation(first), false);
    assert.equal(mod.rememberOperation({ ...first, operationId: "other" }), false);
    const second = mod.decorateOperation({ k: "delete" }, 2);
    assert.equal(mod.rememberOperation(second), true);
});

test("полная синхронизация сбрасывает чанки и агрегаты старого seed", () => {
    const { ModUnderTest } = loadModClass();
    const mod = Object.create(ModUnderTest.prototype);
    const root = { map: { chunksById: new Map([["0|0", { seed: 1 }]]), aggregatesById: new Map([["0|0", {}]]) } };
    mod.resetMapChunkCache(root);
    assert.equal(root.map.chunksById.size, 0);
    assert.equal(root.map.aggregatesById.size, 0);
});
