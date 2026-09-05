#!/usr/bin/env node
"use strict";

const path = require("path");
const { loadConfig, parseArgs, RoomServer } = require("./src/room-server");

async function main() {
    const cli = parseArgs(process.argv.slice(2));
    if (cli.help) {
        console.log("shapez-multiplayer-server.exe [--port 7777] [--host 0.0.0.0] [--max-players 8] [--config config.json]");
        return;
    }

    const configBase = process.pkg ? path.dirname(process.execPath) : __dirname;
    const configPath = cli.config || path.join(configBase, "config.json");
    const config = loadConfig(configPath, cli);
    const server = new RoomServer(config);

    const stop = signal => {
        console.log(`[server] Получен ${signal}, завершаем работу...`);
        server.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.on("uncaughtException", error => console.error("[server] Необработанная ошибка:", error));
    process.on("unhandledRejection", error => console.error("[server] Необработанный Promise:", error));

    await server.listen();
    const address = server.address();
    console.log(`[server] Shapez multiplayer server v1.1.0`);
    console.log(`[server] WebSocket: ws://${config.host}:${address.port}`);
    console.log(`[server] Максимум игроков в комнате: ${config.maxPlayers}`);
}

if (require.main === module) {
    main().catch(error => {
        console.error("[server] Не удалось запустить сервер:", error.message || error);
        process.exitCode = 1;
    });
}

module.exports = { main };
