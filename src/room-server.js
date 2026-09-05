"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PROTOCOL_VERSION = 2;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FORWARDED_TYPES = new Set([
    "operation", "cursor", "chat", "hub-state", "request-resync", "resync",
    "ping", "pong", "disconnect", "player-list", "request-state", "operation-rejected"
]);

const DEFAULT_CONFIG = Object.freeze({
    host: "0.0.0.0",
    port: 7777,
    maxPlayers: 8,
    maxMessageBytes: 1024 * 1024,
    maxSnapshotBytes: 64 * 1024 * 1024,
    messagesPerSecond: 120,
    bytesPerSecond: 2 * 1024 * 1024,
    heartbeatIntervalMs: 15000,
    clientTimeoutMs: 45000,
});

function parseArgs(args) {
    const result = {};
    const names = { "--port": "port", "--host": "host", "--max-players": "maxPlayers", "--config": "config" };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--help" || arg === "-h") result.help = true;
        else if (names[arg]) {
            if (index + 1 >= args.length) throw new Error(`Не задано значение ${arg}`);
            result[names[arg]] = args[++index];
        } else throw new Error(`Неизвестный параметр: ${arg}`);
    }
    return result;
}

function integer(value, fallback, min, max, name) {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Некорректный ${name}: ${value}`);
    return parsed;
}

function loadConfig(configPath, overrides = {}) {
    let fileConfig = {};
    if (configPath && fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
    const merged = { ...DEFAULT_CONFIG, ...fileConfig, ...overrides };
    return {
        host: String(merged.host || DEFAULT_CONFIG.host),
        port: integer(merged.port, DEFAULT_CONFIG.port, 0, 65535, "port"),
        maxPlayers: integer(merged.maxPlayers, DEFAULT_CONFIG.maxPlayers, 2, 64, "maxPlayers"),
        maxMessageBytes: integer(merged.maxMessageBytes, DEFAULT_CONFIG.maxMessageBytes, 1024, 16 * 1024 * 1024, "maxMessageBytes"),
        maxSnapshotBytes: integer(merged.maxSnapshotBytes, DEFAULT_CONFIG.maxSnapshotBytes, 1024 * 1024, 256 * 1024 * 1024, "maxSnapshotBytes"),
        messagesPerSecond: integer(merged.messagesPerSecond, DEFAULT_CONFIG.messagesPerSecond, 10, 10000, "messagesPerSecond"),
        bytesPerSecond: integer(merged.bytesPerSecond, DEFAULT_CONFIG.bytesPerSecond, 64 * 1024, 128 * 1024 * 1024, "bytesPerSecond"),
        heartbeatIntervalMs: integer(merged.heartbeatIntervalMs, DEFAULT_CONFIG.heartbeatIntervalMs, 1000, 60000, "heartbeatIntervalMs"),
        clientTimeoutMs: integer(merged.clientTimeoutMs, DEFAULT_CONFIG.clientTimeoutMs, 3000, 180000, "clientTimeoutMs"),
    };
}

function safeSend(socket, message) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function normalizedMods(mods) {
    if (!Array.isArray(mods)) return [];
    return mods
        .filter(mod => mod && typeof mod.id === "string" && typeof mod.version === "string")
        .map(mod => ({ id: mod.id.slice(0, 128), version: mod.version.slice(0, 64), name: String(mod.name || mod.id).slice(0, 128) }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

function compatibilityDifference(hostHello, clientHello) {
    const details = { missing: [], extra: [], versionMismatch: [] };
    const hostMods = new Map(normalizedMods(hostHello.mods).map(mod => [mod.id, mod]));
    const clientMods = new Map(normalizedMods(clientHello.mods).map(mod => [mod.id, mod]));
    for (const [id, mod] of hostMods) {
        if (!clientMods.has(id)) details.missing.push(mod);
        else if (clientMods.get(id).version !== mod.version) details.versionMismatch.push({ id, host: mod.version, client: clientMods.get(id).version });
    }
    for (const [id, mod] of clientMods) if (!hostMods.has(id)) details.extra.push(mod);
    if (hostHello.gameVersion && clientHello.gameVersion && hostHello.gameVersion !== clientHello.gameVersion) {
        details.gameVersion = { host: hostHello.gameVersion, client: clientHello.gameVersion };
    }
    if (hostHello.modVersion !== clientHello.modVersion) {
        details.multiplayerVersion = { host: hostHello.modVersion, client: clientHello.modVersion };
    }
    return details;
}

function hasDifference(details) {
    return Boolean(details.gameVersion || details.multiplayerVersion || details.missing.length || details.extra.length || details.versionMismatch.length);
}

class RoomServer {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.rooms = new Map();
        this.wss = null;
        this.heartbeat = null;
    }

    listen() {
        return new Promise((resolve, reject) => {
            this.wss = new WebSocketServer({
                host: this.config.host,
                port: this.config.port,
                maxPayload: this.config.maxSnapshotBytes,
                perMessageDeflate: false,
            });
            this.wss.once("listening", () => {
                this.heartbeat = setInterval(() => this.checkHeartbeat(), this.config.heartbeatIntervalMs);
                resolve();
            });
            this.wss.once("error", reject);
            this.wss.on("connection", (socket, request) => this.onConnection(socket, request));
        });
    }

    address() { return this.wss.address(); }

    onConnection(socket, request) {
        socket.mp = {
            initialized: false, roomId: null, playerId: null, role: null, name: "Игрок",
            lastSeen: Date.now(), windowStarted: Date.now(), messages: 0, bytes: 0,
            remoteAddress: request.socket.remoteAddress,
        };
        socket.on("pong", () => { socket.mp.lastSeen = Date.now(); });
        socket.on("message", (raw, isBinary) => this.onMessage(socket, raw, isBinary));
        socket.on("close", () => this.onClose(socket));
        socket.on("error", error => console.warn(`[server] Ошибка соединения ${socket.mp.remoteAddress}: ${error.message}`));
    }

    reject(socket, reason, details) {
        safeSend(socket, { type: "operation-rejected", reason, details });
        socket.close(1008, String(reason).slice(0, 120));
    }

    consumeRate(socket, bytes, allowSnapshotBytes = false) {
        const now = Date.now();
        if (now - socket.mp.windowStarted >= 1000) {
            socket.mp.windowStarted = now; socket.mp.messages = 0; socket.mp.bytes = 0;
        }
        socket.mp.messages += 1;
        if (!allowSnapshotBytes) socket.mp.bytes += bytes;
        return socket.mp.messages <= this.config.messagesPerSecond &&
            (allowSnapshotBytes || socket.mp.bytes <= this.config.bytesPerSecond);
    }

    onMessage(socket, raw, isBinary) {
        socket.mp.lastSeen = Date.now();
        const bytes = raw.byteLength;
        if (isBinary) return this.reject(socket, "Бинарные сообщения не поддерживаются");
        if (bytes > this.config.maxSnapshotBytes) return this.reject(socket, "Сообщение слишком большое");

        let message;
        try { message = JSON.parse(raw.toString("utf8")); }
        catch { return this.reject(socket, "Некорректный JSON"); }
        if (!message || typeof message.type !== "string") return this.reject(socket, "Не указан тип сообщения");
        const snapshotLike = message.type === "resync" || (message.payload && (message.payload.t === "welcome" || message.payload.t === "resync"));
        if (!this.consumeRate(socket, bytes, snapshotLike)) return this.reject(socket, "Превышен лимит частоты сообщений");
        if (!snapshotLike && bytes > this.config.maxMessageBytes) return this.reject(socket, "Обычное сообщение слишком большое");

        if (!socket.mp.initialized) {
            if (message.type !== "hello") return this.reject(socket, "Первым сообщением должен быть hello");
            return this.handleHello(socket, message);
        }
        this.handleRoomMessage(socket, message);
    }

    makeRoomId() {
        for (let attempt = 0; attempt < 100; attempt += 1) {
            let id = "";
            for (let index = 0; index < 6; index += 1) id += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
            if (!this.rooms.has(id)) return id;
        }
        throw new Error("Не удалось создать код комнаты");
    }

    handleHello(socket, hello) {
        if (hello.protocolVersion !== PROTOCOL_VERSION) return this.reject(socket, `Нужна версия протокола ${PROTOCOL_VERSION}`);
        if (hello.role === "host") return this.createRoom(socket, hello);
        if (hello.role === "client") return this.joinRoom(socket, hello);
        return this.reject(socket, "Неизвестная роль");
    }

    createRoom(socket, hello) {
        const roomId = this.makeRoomId();
        const player = this.initializePlayer(socket, roomId, 1, "host", hello.name);
        const room = { id: roomId, host: socket, hostHello: { ...hello, mods: normalizedMods(hello.mods) }, clients: new Map(), nextPlayerId: 2 };
        this.rooms.set(roomId, room);
        safeSend(socket, { type: "welcome", role: "host", roomId, playerId: 1, maxPlayers: this.config.maxPlayers });
        this.broadcastServerPlayerList(room);
        console.log(`[server] Комната ${roomId} создана (${player.name})`);
    }

    joinRoom(socket, hello) {
        const roomId = String(hello.roomId || "").toUpperCase();
        const room = this.rooms.get(roomId);
        if (!room || room.host.readyState !== WebSocket.OPEN) return this.reject(socket, "Комната не найдена или хост отключён");
        if (room.clients.size + 1 >= this.config.maxPlayers) return this.reject(socket, "Комната заполнена");
        const details = compatibilityDifference(room.hostHello, hello);
        if (hasDifference(details)) return this.reject(socket, "Версии игры или модов не совпадают", details);

        const playerId = room.nextPlayerId++;
        const player = this.initializePlayer(socket, roomId, playerId, "client", hello.name);
        room.clients.set(playerId, socket);
        safeSend(socket, { type: "welcome", role: "client", roomId, playerId, maxPlayers: this.config.maxPlayers });
        safeSend(room.host, { type: "peer-message", from: playerId, payload: { t: "hello", name: player.name, gameVersion: hello.gameVersion || null, mods: normalizedMods(hello.mods) } });
        this.broadcastServerPlayerList(room);
        console.log(`[server] ${player.name} (${playerId}) вошёл в ${roomId}`);
    }

    initializePlayer(socket, roomId, playerId, role, name) {
        socket.mp.initialized = true; socket.mp.roomId = roomId; socket.mp.playerId = playerId; socket.mp.role = role;
        socket.mp.name = String(name || "Игрок").trim().slice(0, 16) || "Игрок";
        return socket.mp;
    }

    handleRoomMessage(socket, message) {
        const room = this.rooms.get(socket.mp.roomId);
        if (!room) return this.reject(socket, "Комната закрыта");
        if (!FORWARDED_TYPES.has(message.type)) return this.reject(socket, `Недопустимый тип: ${message.type}`);
        const payload = message.payload;
        if (!payload || typeof payload.t !== "string") return this.reject(socket, "Отсутствует payload");

        if (socket.mp.role === "host") {
            if (message.to !== undefined) {
                const target = room.clients.get(Number(message.to));
                if (target) safeSend(target, { type: message.type, payload });
            } else {
                for (const [playerId, client] of room.clients) {
                    if (playerId !== Number(message.exclude)) safeSend(client, { type: message.type, payload });
                }
            }
        } else {
            safeSend(room.host, { type: "peer-message", from: socket.mp.playerId, payload });
        }
    }

    broadcastServerPlayerList(room) {
        const players = [{ id: 1, name: room.host.mp.name, role: "host" }];
        for (const [id, socket] of room.clients) players.push({ id, name: socket.mp.name, role: "client" });
        const message = { type: "player-list", players };
        safeSend(room.host, message);
        for (const client of room.clients.values()) safeSend(client, message);
    }

    onClose(socket) {
        if (!socket.mp || !socket.mp.initialized) return;
        const room = this.rooms.get(socket.mp.roomId);
        if (!room) return;
        if (socket.mp.role === "host") {
            this.rooms.delete(room.id);
            for (const client of room.clients.values()) {
                safeSend(client, { type: "disconnect", reason: "Хост завершил сессию" });
                client.close(1001, "host disconnected");
            }
            console.log(`[server] Комната ${room.id} закрыта`);
        } else {
            room.clients.delete(socket.mp.playerId);
            safeSend(room.host, { type: "peer-disconnected", playerId: socket.mp.playerId });
            this.broadcastServerPlayerList(room);
        }
    }

    checkHeartbeat() {
        const now = Date.now();
        for (const socket of this.wss.clients) {
            if (now - socket.mp.lastSeen > this.config.clientTimeoutMs) socket.terminate();
            else if (socket.readyState === WebSocket.OPEN) socket.ping();
        }
    }

    close() {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        if (!this.wss) return Promise.resolve();
        for (const socket of this.wss.clients) socket.close(1001, "server shutdown");
        return new Promise(resolve => this.wss.close(resolve));
    }
}

module.exports = { DEFAULT_CONFIG, PROTOCOL_VERSION, RoomServer, compatibilityDifference, hasDifference, loadConfig, normalizedMods, parseArgs };
