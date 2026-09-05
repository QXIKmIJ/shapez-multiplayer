"use strict";

const WebSocket = require("ws");

const url = process.argv[2] || "ws://127.0.0.1:7777";
const socket = new WebSocket(url);
const timeout = setTimeout(() => {
    console.error("EXE_SMOKE_TIMEOUT");
    process.exit(1);
}, 5000);

socket.once("open", () => {
    socket.send(JSON.stringify({
        type: "hello",
        protocolVersion: 2,
        role: "host",
        name: "ExeSmoke",
        gameVersion: "1.5.7",
        modVersion: "1.1.0",
        mods: [],
    }));
});

socket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "welcome") return;
    clearTimeout(timeout);
    console.log(`EXE_SMOKE_OK room=${message.roomId} player=${message.playerId}`);
    socket.close();
});

socket.once("error", error => {
    clearTimeout(timeout);
    console.error("EXE_SMOKE_ERROR", error.message);
    process.exit(1);
});
