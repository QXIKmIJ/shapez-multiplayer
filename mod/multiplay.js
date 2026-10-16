// shapez.io multiplayer mod ("multiplay")
// Host-authoritative multiplayer: host and clients use an independent room
// WebSocket server. The host applies client intents
// to its own world and broadcasts results. Every entity gets its uid assigned by
// the host, so all peers share identical uids. Entities travel using the same
// serialization the savegame uses, so other mods (buildings, components) are
// transferred transparently as long as all peers run the same mods (checked on join).

// @ts-nocheck

const METADATA = {
    website: "",
    author: "QXIK_mIJ",
    name: "Multiplayer (multiplay)",
    version: "1.1.0",
    id: "multiplay",
    description:
        "Co-op multiplayer: build factories together in real time with synchronized buildings and cursors. " +
        "/ Совместная игра по сети: стройте фабрику вместе в реальном времени с синхронизацией построек и курсоров.",
    minimumGameVersion: ">=1.5.0",
    // Не влияет на сейвы: подключаться/отключаться можно в любой момент
    doesNotAffectSavegame: true,
};

/* ------------------------------------------------------------------ */
/*  Константы                                                           */
/* ------------------------------------------------------------------ */

const MP_CURSOR_MS = 100; // частота отправки курсора
const MP_HUB_STATE_MS = 3000; // частота синхронизации прогресса хаба
const MP_BATCH_MS = 40; // буферизация операций (drag ставит по 20 зданий)
const MP_MAX_NAME = 16;
const MP_MAX_PLAYERS = 8;
const MP_MAX_ENTITIES_DUMP = 250000;
const MP_PROTOCOL_VERSION = 2;
const MP_DEFAULT_SERVER = "ws://127.0.0.1:7777";

const MP_COLORS = [
    "#e91e63",
    "#2196f3",
    "#7c4dff",
    "#ff9800",
    "#9c27b0",
    "#00bcd4",
    "#f44336",
    "#536dfe",
];

/** Компоненты, не переносимые в live-операциях (состояние времени выполнения) */
const MP_SKIP_LIVE_COMPONENTS = new Set([
    "ItemEjector",
    "ItemAcceptor",
    "Belt",
    "ItemProcessor",
]);

function mpColorForId(id) {
    return MP_COLORS[((id - 1) % MP_COLORS.length + MP_COLORS.length) % MP_COLORS.length];
}

function mpEscapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Диагностический лог мода. */
function mpLog(...args) {
    console.log("[mp-mod]", ...args);
}

/**
 * Версия игры. G_BUILD_VERSION объявлена не на window, а в scope бандла,
 * поэтому в некоторых окнах недоступна — используем безопасное чтение.
 */
function mpGetGameVersion() {
    try {
        return typeof G_BUILD_VERSION !== "undefined" ? G_BUILD_VERSION : null;
    } catch (ex) {
        return null;
    }
}

/* ------------------------------------------------------------------ */
/*  Транспорт                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Локализация (i18n: ru / en)                                         */
/* ------------------------------------------------------------------ */

const MP_I18N = {
    ru: {
        "mod.name": "Мультиплеер",
        "btn.multiplayer": "Мультиплеер",
        "btn.host": "Открыть текущий мир (я — хост)",
        "btn.join": "Подключиться к другу",
        "dialog.main.title": "Мультиплеер",
        "dialog.main.desc":
            "Запусти отдельный Shapez Multiplayer Server. Хост открывает текущий мир " +
            "и получает код приглашения.\n" +
            "Друг вводит код и подключается к его миру.",
        "dialog.server.title": "Адрес сервера",
        "dialog.server.desc": "Сначала запусти отдельный shapez-multiplayer-server.exe, затем укажи его WebSocket-адрес.",
        "dialog.server.badUrl": "Нужен адрес вида ws://IP:порт",
        "dialog.server.createFail": "Не удалось создать комнату: {0}",
        "dialog.created.title": "Мир создан",
        "dialog.created.desc":
            "<div>Комната создана! Отправь другу этот код:</div>" +
            "<div style=\"font-size:11px; margin-top:8px; opacity:0.8;\">" +
            "Затем начни новую игру (или продолжи существующую) — друг подключится к твоему миру.</div>",
        "dialog.name.title": "Имя игрока",
        "dialog.name.desc": "Друг будет видеть это имя и твой курсор.",
        "dialog.name.placeholder": "Твоё имя",
        "dialog.name.default": "Игрок",
        "dialog.connect.title": "Подключение",
        "dialog.connect.desc": "Вставь код от друга (MPZ2:...).",
        "dialog.connect.badCode": "Некорректный код подключения",
        "dialog.connect.fail": "Не удалось подключиться:\n{0}",
        "dialog.connect.waiting": "Подключено! Ждём, пока хост войдёт в мир — после этого ты автоматически попадёшь в его игру.",
        "notify.joined": "{0} подключился",
        "notify.left": "{0} покинул игру",
        "notify.loadingWorld": "Загружаем мир хоста...",
        "notify.disconnected": "Соединение с хостом потеряно{0}",
        "notify.sessionEnded": "Сессия мультиплеера завершена",
        "notify.reconnectNotice": "Выйди в меню и подключись заново",
        "notify.kicked": "Тебя отключили от сервера: {0}",
        "notify.opRejected": "Операция отклонена: {0}",
        "notify.resynced": "Мир обновлён из хоста",
        "notify.resyncFailed": "Не удалось обновить мир — смотри журнал ошибок",
        "notify.hostOnlyCode": "Код доступен только у хоста",
        "notify.clientOnlyResync": "Обновление доступно только у клиента — у хоста мир и так актуальный",
        "notify.copyFailed": "Не удалось скопировать — выдели код вручную",
        "hud.hostThisWorld": "Создать сессию для этого мира",
        "hud.copyCode": "Скопировать код мира",
        "hud.copyCodeTitle": "Код появится у друга в буфере обмена — он сможет подключиться",
        "hud.copied": "Скопировано!",
        "hud.resyncWorld": "Обновить мир",
        "hud.resyncTitle": "Полностью синхронизировать мир с хостом (чинит рассинхрон)",
        "hud.resyncing": "Обновляю...",
        "hud.chat": "Чат",
        "hud.chatPlaceholder": "Сообщение, Enter — отправить, Esc — закрыть",
        "hud.leaveSession": "Покинуть сессию",
        "hud.roleHost": "хост",
        "hud.roleClient": "клиент",
        "hud.roleNoSession": "нет сессии",
        "hud.youTag": "(ты)",
        "hud.ms": "мс",
        "hud.connectedTo": "Подключён к {0}",
        "compat.rejected": "Подключение отклонено",
        "compat.gameVersion": "Версия игры: хост {0}, клиент {1}",
        "compat.modVersion": "Версия multiplay: хост {0}, клиент {1}",
        "compat.missing": "Отсутствуют у клиента: {0}",
        "compat.extra": "Лишние у клиента: {0}",
        "compat.versionMismatch": "Другие версии: {0}",
        "compat.modsMismatch": "Моды не совпадают с хостом!\n\n",
        "compat.hostHas": "У хоста есть, у тебя нет: {0}\n",
        "compat.clientHas": "У тебя есть, у хоста нет: {0}",
        "signal.title": "Сигнал",
        "signal.desc": "Выбери значение из списка или введи код",
        "signal.label": "Код сигнала (например: CuCuCuCu, red, 1)"
    },
    en: {
        "mod.name": "Multiplayer",
        "btn.multiplayer": "Multiplayer",
        "btn.host": "Open current world (Host)",
        "btn.join": "Join a friend (Client)",
        "dialog.main.title": "Multiplayer",
        "dialog.main.desc":
            "Start the standalone Shapez Multiplayer Server first. The host opens the current world " +
            "and receives an invite code.\n" +
            "A friend enters the code to join the world.",
        "dialog.server.title": "Server Address",
        "dialog.server.desc": "Start the standalone shapez-multiplayer-server.exe first, then enter its WebSocket address.",
        "dialog.server.badUrl": "Requires address format ws://IP:port",
        "dialog.server.createFail": "Failed to create room: {0}",
        "dialog.created.title": "World Created",
        "dialog.created.desc":
            "<div>Room created! Send this code to your friend:</div>" +
            "<div style=\"font-size:11px; margin-top:8px; opacity:0.8;\">" +
            "Then start a new game (or continue an existing one) — your friend will join your world.</div>",
        "dialog.name.title": "Player Name",
        "dialog.name.desc": "Your friend will see this name and your cursor.",
        "dialog.name.placeholder": "Your name",
        "dialog.name.default": "Player",
        "dialog.connect.title": "Connect",
        "dialog.connect.desc": "Paste the invite code from your friend (MPZ2:...).",
        "dialog.connect.badCode": "Invalid connection code",
        "dialog.connect.fail": "Failed to connect:\n{0}",
        "dialog.connect.waiting": "Connected! Waiting for host to enter the world — you will join automatically.",
        "notify.joined": "{0} joined",
        "notify.left": "{0} left the game",
        "notify.loadingWorld": "Loading host world...",
        "notify.disconnected": "Connection to host lost{0}",
        "notify.sessionEnded": "Multiplayer session ended",
        "notify.reconnectNotice": "Return to menu and reconnect",
        "notify.kicked": "Disconnected from server: {0}",
        "notify.opRejected": "Operation rejected: {0}",
        "notify.resynced": "World resynced from host",
        "notify.resyncFailed": "Failed to resync world — check error log",
        "notify.hostOnlyCode": "Invite code is only available on host",
        "notify.clientOnlyResync": "Resync only available on client — host world is already authoritative",
        "notify.copyFailed": "Failed to copy — select code manually",
        "hud.hostThisWorld": "Host this world",
        "hud.copyCode": "Copy invite code",
        "hud.copyCodeTitle": "The invite code will be copied to your clipboard — send it to a friend",
        "hud.copied": "Copied!",
        "hud.resyncWorld": "Resync world",
        "hud.resyncTitle": "Fully resynchronize world from host (fixes desync)",
        "hud.resyncing": "Resyncing...",
        "hud.chat": "Chat",
        "hud.chatPlaceholder": "Message, Enter to send, Esc to close",
        "hud.leaveSession": "Leave session",
        "hud.roleHost": "host",
        "hud.roleClient": "client",
        "hud.roleNoSession": "no session",
        "hud.youTag": "(you)",
        "hud.ms": "ms",
        "hud.connectedTo": "Connected to {0}",
        "compat.rejected": "Connection rejected",
        "compat.gameVersion": "Game version: host {0}, client {1}",
        "compat.modVersion": "Multiplay version: host {0}, client {1}",
        "compat.missing": "Missing on client: {0}",
        "compat.extra": "Extra on client: {0}",
        "compat.versionMismatch": "Version mismatch: {0}",
        "compat.modsMismatch": "Mods do not match host!\n\n",
        "compat.hostHas": "Host has, you do not: {0}\n",
        "compat.clientHas": "You have, host does not: {0}",
        "signal.title": "Signal",
        "signal.desc": "Choose a value from the list or enter a code",
        "signal.label": "Signal code (e.g.: CuCuCuCu, red, 1)"
    }
};

function mpGetLanguage(app) {
    try {
        if (app && app.settings && typeof app.settings.getLanguage === "function") {
            const lang = app.settings.getLanguage();
            if (lang) return lang.toLowerCase().startsWith("ru") ? "ru" : "en";
        }
        if (app && app.settings && typeof app.settings.getAllSettings === "function") {
            const s = app.settings.getAllSettings();
            if (s && s.language) return s.language.toLowerCase().startsWith("ru") ? "ru" : "en";
        }
    } catch (e) {}
    try {
        const docLang = (typeof document !== "undefined" && (document.documentElement.getAttribute("lang") || document.documentElement.lang)) || "";
        if (docLang) return docLang.toLowerCase().startsWith("ru") ? "ru" : "en";
    } catch (e) {}
    try {
        if (typeof navigator !== "undefined" && navigator.language) {
            return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
        }
    } catch (e) {}
    return "en";
}

function mpT(app, key, ...args) {
    const lang = mpGetLanguage(app);
    const dict = MP_I18N[lang] || MP_I18N.en;
    let text = dict[key] || (MP_I18N.en && MP_I18N.en[key]) || key;
    if (args.length > 0) {
        for (let i = 0; i < args.length; i++) {
            text = text.replace(new RegExp(`\\{${i}\\}`, "g"), args[i] !== undefined ? args[i] : "");
        }
    }
    return text;
}

function mpProtocolType(message) {
    const type = message && message.t;
    if (type === "op" || type === "rtt" || type === "wait-host") return "operation";
    if (type === "welcome" || type === "resync") return "resync";
    if (type === "player-list" || type === "player-left" || type === "player-joined") return "player-list";
    if (type === "kick" || type === "mods-mismatch") return "operation-rejected";
    return type || "operation";
}

/** Единый браузерный WebSocket-транспорт для Steam и portable. */
class MpWebSocketTransport {
    constructor(url, hello) {
        this.url = url;
        this.hello = hello;
        this.ws = null;
        this.connected = false;
        this.roomId = hello.roomId || null;
        this.playerId = null;
        this.onMessage = null;
        this.onClientMessage = null;
        this.onClientDisconnected = null;
        this.onClose = null;
        this.onRejected = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            let settled = false;
            try {
                this.ws = new WebSocket(this.url);
            } catch (ex) {
                return reject(ex);
            }
            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    this.close();
                    reject(new Error("Таймаут подключения (10 сек)"));
                }
            }, 10000);
            this.ws.onopen = () => this.ws.send(JSON.stringify(this.hello));
            this.ws.onmessage = ev => {
                let message;
                try {
                    message = JSON.parse(ev.data);
                } catch (ex) {
                    return console.error("mp: bad server message", ex);
                }
                if (message.type === "welcome" && !settled) {
                    settled = true;
                    this.connected = true;
                    this.roomId = message.roomId;
                    this.playerId = message.playerId;
                    clearTimeout(timeout);
                    resolve(message);
                    return;
                }
                if (message.type === "operation-rejected" && !message.payload) {
                    if (this.onRejected) this.onRejected(message);
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        const error = new Error(message.reason || "Сервер отклонил подключение");
                        error.details = message.details;
                        reject(error);
                    }
                    return;
                }
                if (message.type === "peer-message" && this.onClientMessage) {
                    this.onClientMessage(message.from, JSON.stringify(message.payload));
                } else if (message.type === "peer-disconnected" && this.onClientDisconnected) {
                    this.onClientDisconnected(message.playerId);
                } else if (message.payload && this.onMessage) {
                    this.onMessage(message.payload);
                } else if (message.type === "disconnect" && this.onClose) {
                    this.onClose(1001, message.reason || "Сессия закрыта");
                }
            };
            this.ws.onclose = ev => {
                const wasConnected = this.connected;
                this.connected = false;
                clearTimeout(timeout);
                if (!settled) {
                    settled = true;
                    reject(new Error("Сервер недоступен"));
                } else if (wasConnected && this.onClose) {
                    this.onClose(ev.code, ev.reason);
                }
            };
            this.ws.onerror = () => {};
        });
    }

    sendEnvelope(obj, extra) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        this.ws.send(JSON.stringify({ type: mpProtocolType(obj), ...(extra || {}), payload: obj }));
        return true;
    }

    send(obj) { return this.sendEnvelope(obj); }
    sendToClient(clientId, obj) { return this.sendEnvelope(obj, { to: clientId }); }
    broadcast(obj, excludeClientId = null) { return this.sendEnvelope(obj, { exclude: excludeClientId }); }
    start() { return this.connect(); }
    stop() { this.close(); return Promise.resolve(); }

    close() {
        if (this.ws) {
            try { this.ws.close(); } catch (ex) {}
            this.ws = null;
        }
    }
}

class MpTransportHost extends MpWebSocketTransport {}
class MpTransportClient extends MpWebSocketTransport {}

/* ------------------------------------------------------------------ */
/*  Мод                                                                 */
/* ------------------------------------------------------------------ */

class Mod extends shapez.Mod {
    t(key, ...args) {
        return mpT(this.app, key, ...args);
    }

    getDefaultPlayerName() {
        return this.t("dialog.name.default");
    }

    getPlayerName() {
        return (this.myName && this.myName.trim()) || this.getDefaultPlayerName();
    }

    init() {
        // Защита от повторной инициализации (мод грузится один раз)
        if (window.__multiplay_initialized) {
            return;
        }
        window.__multiplay_initialized = true;

        this.role = null; // "host" | "client" | null
        this.net = null;
        this.myPlayerId = null;
        this.myName = "";
        this.worldLoaded = false;
        this.players = new Map();
        this.session = null; // { root, hudPart, chatLines }
        this.pendingDump = null;
        this.applyingRemote = false; // гард рекурсии при применении удалённых операций
        this.placeOutbox = []; // буфер place для батчинга
        this.deleteOutbox = [];
        this.outboxTimer = null;
        this.cursorTimer = null;
        this.hubTimer = null;
        this.lastCursor = { x: 1e9, y: 1e9 };
        this.serverPort = null;
        this.serverUrl = MP_DEFAULT_SERVER;
        this.roomId = null;
        this.operationSequence = 0;
        this.seenOperationIds = new Set();
        this.lastOperationSequence = new Map();
        this.resyncCooldownUntil = 0;
        this.lastHostEntities = undefined;

        this.registerCss();
        this.registerHooks();

        // Кнопка в главном меню
        this.signals.stateEntered.add(state => {
            if (state.constructor.name === "MainMenuState") {
                if (this.session) {
                    // Смена мира закрывает старую комнату: snapshot предыдущего
                    // сейва не должен оставаться активным без игрового root.
                    const oldSession = this.session;
                    if (this.role) this.leaveSession(false);
                    if (oldSession.hudPart) {
                        oldSession.hudPart.cleanup();
                    }
                    this.session = null;
                }
                this.setupMainMenu(state);
            }
        });

        this.signals.gameStarted.add(root => {
            this.onGameStarted(root);
        });

        // Автотест мультиплеера (используется интеграционным тестом):
        // #mp-auto-host[=имя] — стартует сервер и заходит в новую игру
        // #mp-auto-join=код[;имя] — подключается и ждёт мира
        const autoHash = (typeof window !== "undefined" && window.location && window.location.hash) || "";
        if (autoHash.startsWith("#mp-auto")) {
            this.scheduleAutoTest(autoHash);
        }
    }

    /** Автотест: выполняет роль хоста/клиента без участия UI */
    scheduleAutoTest(hash) {
        const params = hash.slice(1).split("=");
        const mode = params[0];
        const args = (params[1] || "").split(";");

        setTimeout(async () => {
            try {
                // Ждём главное меню
                let state = null;
                for (let i = 0; i < 60; ++i) {
                    state = this.app.stateMgr ? this.app.stateMgr.currentState : null;
                    if (state && state.constructor.name === "MainMenuState") break;
                    await new Promise(r => setTimeout(r, 500));
                }
                if (!state || state.constructor.name !== "MainMenuState") {
                    console.error("mp-auto: главное меню не появилось");
                    return;
                }

                if (mode === "mp-auto-host") {
                    this.myName = args[0] || "AutoHost";
                    this.role = "host";
                    this.myPlayerId = 1;
                    this.players.set(1, { id: 1, name: this.myName, color: mpColorForId(1), ping: 0, cursorPos: null });
                    this.pendingClients = [];
                    await this.refreshLocalIps();
                    this.net = new MpTransportHost(MP_DEFAULT_SERVER, this.makeHello("host"));
                    const welcome = await this.net.start();
                    this.serverUrl = MP_DEFAULT_SERVER;
                    this.roomId = welcome.roomId;
                    this.serverPort = 7777;
                    this.net.onClientDisconnected = clientId => {
                        const player = this.players.get(clientId);
                        if (player) {
                            this.players.delete(clientId);
                            this.broadcast({ t: "player-left", id: clientId, reason: "disconnected" });
                            this.inGameNotify(this.t("notify.left", player.name));
                            this.updateHudPanel();
                        }
                    };
                    this.net.onClientMessage = (clientId, raw) => {
                        let msg;
                        try {
                            msg = JSON.parse(raw);
                        } catch (ex) {
                            return;
                        }
                        this.handleClientMessage(clientId, msg);
                    };
                    console.log("MP_AUTO_READY:" + this.buildInviteCode());
                    // Заходим в новую игру
                    const savegame = this.app.savegameMgr.createNewSavegame();
                    this.app.stateMgr.moveToState("InGameState", { savegame });

                    // Режим полного автотеста: открываем второе окно с автоклиентом
                    if (args.includes("spawn")) {
                        console.warn("mp-auto: второе окно нужно запустить отдельно с кодом", this.buildInviteCode());
                    }

                    // Автотест постановки: через 35с после входа в мир ставим 3 белта
                    // (программно, тем же путём, что и игрок) и логируем тайминги
                    if (args.includes("spawn")) {
                        setTimeout(() => {
                            try {
                                const root = this.session && this.session.root;
                                if (!root || !root.gameInitialized) {
                                    mpLog("AUTOTEST: root не готов");
                                    return;
                                }
                                const belt = shapez.gMetaBuildingRegistry.findById("belt");
                                if (!belt) {
                                    mpLog("AUTOTEST: belt не найден");
                                    return;
                                }
                                mpLog("AUTOTEST: ставим 3 белта...");
                                const t0 = Date.now();
                                for (let i = 0; i < 3; ++i) {
                                    const t1 = Date.now();
                                    const placed = root.logic.tryPlaceBuilding({
                                        origin: new shapez.Vector(-1 + i, 4),
                                        rotation: 0,
                                        rotationVariant: 0,
                                        originalRotation: 0,
                                        variant: shapez.defaultBuildingVariant,
                                        building: belt,
                                    });
                                    mpLog(
                                        "AUTOTEST: place #" + i,
                                        placed ? "ok uid=" + placed.uid : "FAIL",
                                        (Date.now() - t1) + "ms"
                                    );
                                }
                                mpLog("AUTOTEST: всего", (Date.now() - t0) + "ms");
                            } catch (ex) {
                                mpLog("AUTOTEST error:", ex);
                            }
                        }, 35000);
                    }

                    // Автотест Ctrl+C -> Ctrl+V (blueprint): через 55с копируем
                    // поставленные белты как blueprint и вставляем в другое место —
                    // это ровно тот путь, который проходит игрок по Ctrl+C/Ctrl+V.
                    // Проверяем, что клиент получил вставленные здания.
                    if (args.includes("spawn")) {
                        setTimeout(() => {
                            try {
                                const root = this.session && this.session.root;
                                if (!root || !root.gameInitialized) {
                                    mpLog("BPTEST: root не готов");
                                    return;
                                }
                                // 1. Собираем uid'ы всех белтов (как mass selector по Ctrl)
                                const uids = [];
                                for (const entity of root.entityMgr.entities) {
                                    const data = shapez.getBuildingDataFromCode(
                                        entity.components.StaticMapEntity.code
                                    );
                                    if (data && data.metaInstance.getId() === "belt") {
                                        uids.push(entity.uid);
                                    }
                                }
                                if (uids.length === 0) {
                                    mpLog("BPTEST: нет белтов для копирования");
                                    return;
                                }
                                mpLog("BPTEST: копирую", uids.length, "белтов (Ctrl+C)");

                                // 2. Ctrl+C: создаём blueprint из uid'ов
                                const blueprint = shapez.Blueprint.fromUids(root, uids);
                                if (!blueprint || blueprint.entities.length === 0) {
                                    mpLog("BPTEST: blueprint пустой — FAIL");
                                    return;
                                }
                                mpLog(
                                    "BPTEST: blueprint создан, сущностей:",
                                    blueprint.entities.length
                                );

                                // 3. Ctrl+V: вставляем через tryPlace (штатный путь)
                                //    в свободное место ниже
                                const before = new Set(
                                    root.entityMgr.entities.map(e => e.uid)
                                );
                                const tile = new shapez.Vector(-1, 10);
                                const placed = blueprint.tryPlace(root, tile);
                                const newEntities = root.entityMgr.entities.filter(
                                    e => !before.has(e.uid)
                                );
                                mpLog(
                                    "BPTEST: tryPlace ->",
                                    placed,
                                    "новых сущностей:",
                                    newEntities.length
                                );

                                // 4. Ждём 3с (батчинг + доставка + применение у клиента),
                                //    сверяемся по heartbeat-логам (оба окна пишут в общий лог)
                                setTimeout(() => {
                                    mpLog(
                                        "BPTEST: у хоста сущностей:",
                                        root.entityMgr.entities.length,
                                        "(сверь с heartbeat клиента в этом же логе)"
                                    );
                                    if (newEntities.length > 0) {
                                        mpLog("BPTEST: OK — blueprint синхронизируется через place-batch");
                                    } else {
                                        mpLog("BPTEST: WARNING — новых сущностей нет");
                                    }
                                }, 3000);
                            } catch (ex) {
                                mpLog("BPTEST error:", ex);
                            }
                        }, 55000);
                    }
                } else if (mode === "mp-auto-join") {
                    this.myName = args[1] || "AutoJoin";
                    const code = args[0];
                    if (!code) {
                        mpLog("AUTOTEST: нет кода");
                        return;
                    }
                    const payload = JSON.parse(shapez.decompressX64(code.slice(5)));
                    const url = payload.url || MP_DEFAULT_SERVER;
                    const net = new MpTransportClient(url, this.makeHello("client", payload.room));
                    this.role = "client";
                    this.net = net;
                    net.onClose = (code, reason) => this.onDisconnectedFromHost(reason);
                    net.onMessage = msg => this.handleHostMessage(msg);
                    const welcome = await net.connect();
                    this.myPlayerId = welcome.playerId;
                    this.roomId = welcome.roomId;
                    mpLog("AUTOTEST: WS подключён к", url);

                    // Автоклиент: если за 60с welcome не пришёл (хост ещё грузился),
                    // периодически напоминаем о себе
                    const resyncTimer = setInterval(() => {
                        if (this.role !== "client" || !this.net) {
                            clearInterval(resyncTimer);
                            return;
                        }
                        if (this.session && this.session.root && this.session.root.gameMode) {
                            // уже в игре
                            clearInterval(resyncTimer);
                            return;
                        }
                        mpLog("AUTOTEST: повторный request-state");
                        this.net.send({ t: "request-state" });
                    }, 10000);

                    // Логируем вход в мир
                    const origEnter = this.enterWorldWithDump.bind(this);
                    this.enterWorldWithDump = dump => {
                        mpLog("AUTOTEST: клиент получил мир, входим");
                        origEnter(dump);
                    };
                    console.log("MP_AUTO_JOINED");
                }
            } catch (ex) {
                console.error("mp-auto failed:", ex);
            }
        }, 1000);
    }

    /* ---------------- CSS ---------------- */

    registerCss() {
        this.modInterface.registerCss(`
            .mpPanel {
                position: absolute;
                top: $scaled(10px);
                right: $scaled(10px);
                z-index: 100;
                display: flex;
                flex-direction: column;
                gap: $scaled(5px);
                font-size: $scaled(12px);
                background: rgba(30, 31, 34, 0.94);
                border: $scaled(1px) solid #2c2e33;
                border-radius: $scaled(4px);
                padding: $scaled(8px);
                width: $scaled(230px);
                box-sizing: border-box;
                color: #ddd;
            }
            .mpPanel.mpHidden { display: none; }
            .mpPanelHeader {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding-bottom: $scaled(4px);
                border-bottom: 1px solid #3a3d42;
                cursor: pointer;
            }
            .mpPanelHeader .title { font-weight: bold; color: #fff; }
            .mpPanelHeader .role { color: #b388ff; }
            .mpPanelHeader .role.client { color: #5aa9e6; }
            .mpPlayers { display: flex; flex-direction: column; gap: 2px; }
            .mpPlayer { display: flex; align-items: center; gap: $scaled(6px); }
            .mpPlayerDot { width: $scaled(8px); height: $scaled(8px); border-radius: 50%; flex-shrink: 0; }
            .mpPlayerName { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .mpPlayerPing { color: #888; font-size: $scaled(10px); }
            .mpShareCode {
                user-select: text;
                cursor: text;
                color: #b388ff;
                font-size: $scaled(10px);
                word-break: break-all;
            }
            .mpChat { display: flex; flex-direction: column; gap: 2px; max-height: $scaled(90px); overflow-y: auto; }
            .mpChatHidden { display: none !important; }
            .mpChatLine { color: #bbb; font-size: $scaled(11px); word-break: break-word; }
            .mpChatLine .name { font-weight: bold; }
            .mpChatInput {
                width: 100%;
                box-sizing: border-box;
                background: #1b1c1f;
                border: 1px solid #3a3d42;
                color: #eee;
                padding: $scaled(3px) $scaled(6px);
                border-radius: 3px;
                font-size: $scaled(11px);
            }
            .mpBtn {
                background: #2f3136;
                border: 1px solid #3a3d42;
                color: #eee;
                padding: $scaled(3px);
                border-radius: 3px;
                cursor: pointer;
            }
            .mpBtn:hover { background: #3a3d42; }
            .mpBtn.danger { color: #f66; }
            .mpMenuDialog { text-align: left; }
            .mpMenuDialog .desc { color: #999; font-size: 11px; margin-bottom: 8px; }
        `);
    }

    /* ---------------- Перехват логики игры ---------------- */

    registerHooks() {
        const self = this;

        // Любое исключение в хуках мода не должно ронять игровой цикл
        const safe = (fn, tag) => {
            return function () {
                try {
                    return fn.apply(this, arguments);
                } catch (ex) {
                    console.error("mp: hook error in " + tag + ":", ex);
                    return undefined;
                }
            };
        };

        // ---- Установка зданий (ловит плейсеры, чертежи, моды) ----
        const logicProto = shapez.GameLogic.prototype;
        const origTryPlace = logicProto.tryPlaceBuilding;
        logicProto.tryPlaceBuilding = safe(function ({ origin, rotation, rotationVariant, originalRotation, variant, building }) {
            // Удалённая операция — применяем как есть
            if (self.applyingRemote || !self.session) {
                return origTryPlace.apply(this, arguments);
            }

            if (self.role === "host") {
                const entity = origTryPlace.apply(this, arguments);
                if (entity) {
                    self.queueOutgoingPlace(entity);
                }
                return entity;
            }

            if (self.role === "client") {
                // Шлём интент, локально не ставим
                self.sendIntent({
                    k: "place",
                    intent: true,
                    building: building.getId(),
                    variant,
                    origin: { x: origin.x, y: origin.y },
                    rotation,
                    originalRotation,
                });
                return null;
            }

            return origTryPlace.apply(this, arguments);
        }, "tryPlaceBuilding");

        // ---- Удаление ----
        const origTryDelete = logicProto.tryDeleteBuilding;
        logicProto.tryDeleteBuilding = safe(function (building) {
            if (self.applyingRemote || !self.session) {
                return origTryDelete.apply(this, arguments);
            }

            if (self.role === "host") {
                const result = origTryDelete.apply(this, arguments);
                if (result) {
                    self.queueOutgoingDelete(building.uid);
                }
                return result;
            }

            if (self.role === "client") {
                // Батчим интенты удаления: drag-удаление генерирует десятки вызовов
                self.clientDeleteBuffer = self.clientDeleteBuffer || [];
                self.clientDeleteBuffer.push(building.uid);
                if (!self.clientDeleteTimer) {
                    self.clientDeleteTimer = setTimeout(() => {
                        const uids = self.clientDeleteBuffer;
                        self.clientDeleteBuffer = [];
                        self.clientDeleteTimer = null;
                        if (uids.length) {
                            self.sendIntent({ k: "delete-batch", intent: true, uids: uids.slice(0, 1000) });
                        }
                    }, MP_BATCH_MS);
                }
                return true; // притворяемся успехом; реально применится по подтверждению
            }

            return origTryDelete.apply(this, arguments);
        }, "tryDeleteBuilding");

        // ---- Замещение зданий при установке: freeEntityAreaBeforeBuild удаляет
        //      старые здания ДО установки новых — перехватываем, чтобы хост
        //      переслал эти удаления клиентам (иначе у клиентов остаются фантомы)
        const origFreeArea = logicProto.freeEntityAreaBeforeBuild;
        logicProto.freeEntityAreaBeforeBuild = safe(function (entity) {
            if (self.role === "host" && self.session && !self.applyingRemote) {
                // Собираем замещаемых до того, как их удалят
                try {
                    const bounds = entity.components.StaticMapEntity.getTileSpaceBounds();
                    const victims = [];
                    for (let x = bounds.x; x < bounds.x + bounds.w; ++x) {
                        for (let y = bounds.y; y < bounds.y + bounds.h; ++y) {
                            const contents = this.root.map.getLayerContentXY(x, y, entity.layer);
                            if (contents && !victims.includes(contents)) {
                                victims.push(contents);
                            }
                        }
                    }
                    if (victims.length) {
                        self.queueOutgoingDelete(victims.map(v => v.uid));
                    }
                } catch (ex) {
                    console.warn("mp: freeEntityArea hook failed", ex);
                }
            }
            return origFreeArea.apply(this, arguments);
        }, "freeEntityAreaBeforeBuild");

        // ---- Рычаги (оптимистично: значение детерминировано) ----
        const leverProto = shapez.HUDLeverToggle.prototype;
        const origLeverDown = leverProto.downPreHandler;
        leverProto.downPreHandler = safe(function (pos, button) {
            if (!self.session || self.applyingRemote) {
                return origLeverDown.apply(this, arguments);
            }
            const tile = this.root.camera.screenToWorld(pos).toTileSpace();
            const contents = this.root.map.getLayerContentXY(tile.x, tile.y, "regular");
            if (contents && contents.components.Lever && button === shapez.enumMouseButton.left) {
                const toggled = !contents.components.Lever.toggled;
                contents.components.Lever.toggled = toggled;
                self.sendOp({ k: "lever", uid: contents.uid, toggled });
                return shapez.STOP_PROPAGATION;
            }
            return origLeverDown.apply(this, arguments);
        }, "lever");

        // ---- Константные сигналы: своя реализация диалога с синхронизацией ----
        const signalProto = shapez.HUDConstantSignalEdit.prototype;
        const origSignalEdit = signalProto.editConstantSignal;
        signalProto.editConstantSignal = safe(function (entity, opts) {
            if (!self.session || self.applyingRemote) {
                return origSignalEdit.apply(this, arguments);
            }
            self.showSignalDialog(this.root, entity, opts && opts.deleteOnCancel);
        }, "editConstantSignal");

        // ---- Апгрейды (сигнал уже диспатчится после покупки) ----
        // Вешаемся в onGameStarted

        // ---- Отправка сигналов апгрейдов ----
        this.upgradeHook = upgradeId => {
            if (!self.session || self.applyingRemote) return;
            if (self.role === "host") {
                self.broadcast({
                    t: "op",
                    op: { k: "upgrade", upgradeId, levels: { ...self.session.root.hubGoals.upgradeLevels } },
                    by: 1,
                });
            } else if (self.role === "client") {
                self.sendIntent({ k: "upgrade", upgradeId });
            }
        };

        // ---- Отрисовка курсоров поверх игры ----
        const hudProto = shapez.GameHUD.prototype;
        const origDraw = hudProto.draw;
        hudProto.draw = safe(function (parameters) {
            const result = origDraw.apply(this, arguments);
            if (self.session && self.session.hudPart && parameters && parameters.context) {
                self.session.hudPart.drawCursors(parameters);
            }
            return result;
        }, "hudDraw");

        // ---- Чертежи: Blueprint.tryPlace ставит здания напрямую (в обход
        //      tryPlaceBuilding) — перехватываем.
        const bpProto = shapez.Blueprint.prototype;
        const origBpTryPlace = bpProto.tryPlace;
        bpProto.tryPlace = safe(function (root, tile) {
            // Удалённая операция — пропускаем через оригинал
            if (self.applyingRemote || !self.session || !self.role) {
                return origBpTryPlace.apply(this, arguments);
            }

            if (self.role === "host") {
                // Запоминаем uid'ы до установки
                const before = new Set(root.entityMgr.entities.map(e => e.uid));
                const result = origBpTryPlace.apply(this, arguments);
                // Всё новое — рассылаем (это перекроет и удалённые замены)
                for (const entity of root.entityMgr.entities) {
                    if (!before.has(entity.uid)) {
                        self.queueOutgoingPlace(entity);
                    }
                }
                return result;
            }

            if (self.role === "client") {
                // Клиент: проверяем доступность и affordability локально,
                // но НЕ ставим — отправляем интент с относительными координатами.
                if (!this.canPlace(root, tile)) {
                    return false;
                }
                if (!this.canAfford(root)) {
                    root.soundProxy.playUiError();
                    return false;
                }
                self.sendIntent({
                    k: "blueprint",
                    intent: true,
                    tile: { x: tile.x, y: tile.y },
                    // Сущности blueprint'а в относительных координатах (origin уже относителен центру)
                    entities: this.entities.map(entity => {
                        const s = entity.components.StaticMapEntity;
                        const bd = shapez.getBuildingDataFromCode(s.code);
                            return {
                            b: bd.metaInstance.getId(),
                            v: bd.variant,
                            w: bd.rotationVariant,
                            x: s.origin.x,
                            y: s.origin.y,
                            r: s.rotation,
                                o: s.originalRotation,
                                c: self.serializeEntityLive(entity).components,
                            };
                    }),
                });
                return true;
            }

            return origBpTryPlace.apply(this, arguments);
        }, "blueprintTryPlace");
    }

    /* ---------------- Главное меню ---------------- */

    setupMainMenu(state) {
        const tryInsert = () => {
            if (!state.htmlElement || !state.htmlElement.isConnected) return;
            const container = state.htmlElement.querySelector(".mainContainer .buttons .outer");
            if (!container) return setTimeout(tryInsert, 100);
            if (container.querySelector(".mpMenuButton")) return;

            const btn = document.createElement("button");
            btn.className = "styledButton mpMenuButton";
            btn.textContent = this.t("btn.multiplayer");
            btn.style.order = "-1";
            container.appendChild(btn);
            state.trackClicks(btn, () => this.showMenuDialog(state));
        };
        setTimeout(tryInsert, 50);
    }

    showMenuDialog(state) {
        const html = `
            <div class="mpMenuDialog">
                <div class="desc" style="white-space:pre-line;">
                    ${mpEscapeHtml(this.t("dialog.main.desc"))}
                </div>
                <div style="display:flex; flex-direction:column; gap:8px;">
                    <button class="styledButton mpBtnHost">${mpEscapeHtml(this.t("btn.host"))}</button>
                    <button class="styledButton mpBtnJoin">${mpEscapeHtml(this.t("btn.join"))}</button>
                </div>
            </div>
        `;
        const dialog = new shapez.Dialog({
            app: this.app,
            title: this.t("dialog.main.title"),
            contentHTML: html,
            buttons: ["cancel:bad:escape"],
            type: "info",
        });
        state.dialogs.internalShowDialog(dialog);

        dialog.dialogElem.querySelector(".mpBtnHost").addEventListener("click", () => {
            dialog.closeRequested.dispatch();
            this.hostFlow(state);
        });
        dialog.dialogElem.querySelector(".mpBtnJoin").addEventListener("click", () => {
            dialog.closeRequested.dispatch();
            this.joinFlow(state);
        });
    }

    normalizeServerUrl(value) {
        let url = String(value || "").trim().replace(/\/$/, "");
        if (!/^wss?:\/\//i.test(url)) url = "ws://" + url;
        const parsed = new URL(url);
        if (!/^wss?:$/.test(parsed.protocol) || !parsed.hostname || !parsed.port) {
            throw new Error(this.t("dialog.server.badUrl"));
        }
        return parsed.toString().replace(/\/$/, "");
    }

    makeHello(role, roomId = null) {
        return {
            type: "hello",
            protocolVersion: MP_PROTOCOL_VERSION,
            role,
            roomId,
            name: this.myName,
            gameVersion: mpGetGameVersion(),
            modVersion: METADATA.version,
            mods: this.getModsList(),
        };
    }

    formatConnectionError(error) {
        const details = error && error.details;
        if (!details) return error.message || String(error);
        const lines = [error.message || this.t("compat.rejected")];
        if (details.gameVersion) lines.push(this.t("compat.gameVersion", details.gameVersion.host, details.gameVersion.client));
        if (details.multiplayerVersion) lines.push(this.t("compat.modVersion", details.multiplayerVersion.host, details.multiplayerVersion.client));
        if (details.missing && details.missing.length) lines.push(this.t("compat.missing", details.missing.map(m => `${m.id} ${m.version}`).join(", ")));
        if (details.extra && details.extra.length) lines.push(this.t("compat.extra", details.extra.map(m => `${m.id} ${m.version}`).join(", ")));
        if (details.versionMismatch && details.versionMismatch.length) lines.push(this.t("compat.versionMismatch", details.versionMismatch.map(m => `${m.id} (${m.host} vs ${m.client})`).join(", ")));
        return lines.join("\n");
    }

    async hostFlow(state) {
        if (this.role) this.leaveSession(false);
        const name = await this.askName(state);
        if (name === null) return;
        this.myName = name;

        const serverInput = await this.askText(
            state,
            this.t("dialog.server.title"),
            this.t("dialog.server.desc"),
            this.serverUrl || MP_DEFAULT_SERVER
        );
        if (serverInput === null) return;

        try {
            this.serverUrl = this.normalizeServerUrl(serverInput);
            this.net = new MpTransportHost(this.serverUrl, this.makeHello("host"));
            const welcome = await this.net.start();
            this.roomId = welcome.roomId;
            this.myPlayerId = welcome.playerId;
            this.serverPort = Number(new URL(this.serverUrl).port);
        } catch (ex) {
            state.dialogs.showWarning(this.t("mod.name"), this.t("dialog.server.createFail", ex.message));
            this.net = null;
            return;
        }

        this.role = "host";
        this.players.set(this.myPlayerId, { id: this.myPlayerId, name: this.myName, color: mpColorForId(this.myPlayerId), ping: 0, cursorPos: null });
        this.pendingClients = [];
        this.updateHudPanel();
        if (this.session) {
            this.startCursorTicker();
            this.startHubStateTicker();
        }

        this.net.onClientDisconnected = clientId => {
            const player = this.players.get(clientId);
            if (player) {
                this.players.delete(clientId);
                this.broadcast({ t: "player-left", id: clientId, reason: "disconnected" });
                this.inGameNotify(this.t("notify.left", player.name));
                this.updateHudPanel();
            }
        };
        this.net.onClientMessage = (clientId, raw) => {
            let msg;
            try {
                msg = JSON.parse(raw);
            } catch (ex) {
                return;
            }
            this.handleClientMessage(clientId, msg);
        };

        // Код приглашения
        const code = this.buildInviteCode();

        const html = `
            <div class="mpMenuDialog">
                ${this.t("dialog.created.desc")}
                <div class="mpShareCode">${mpEscapeHtml(code)}</div>
            </div>
        `;
        const dlg = new shapez.Dialog({
            app: this.app,
            title: this.t("dialog.created.title"),
            contentHTML: html,
            buttons: ["ok:good:enter"],
            type: "info",
        });
        state.dialogs.internalShowDialog(dlg);
        try {
            navigator.clipboard.writeText(code);
        } catch (ex) {}
    }

    buildInviteCode() {
        if (!this.serverUrl || !this.roomId) return null;
        const payload = { url: this.serverUrl, room: this.roomId, protocol: MP_PROTOCOL_VERSION };
        return "MPZ2:" + shapez.compressX64(JSON.stringify(payload));
    }

    /** Асинхронно подтягивает сетевые адреса машины (для кода приглашения) */
    async refreshLocalIps(includeLocal = false) {
        this.localIps = [];
        this.updateHudPanel();
    }

    async joinFlow(state) {
        if (this.role) this.leaveSession(false);
        const name = await this.askName(state);
        if (name === null) return;
        this.myName = name;

        const input = await this.askText(
            state,
            this.t("dialog.connect.title"),
            this.t("dialog.connect.desc"),
            ""
        );
        if (input === null) return;

        let url;
        let roomId;
        try {
            const trimmed = input.trim().replace(/\s+/g, "");
            if (!trimmed.startsWith("MPZ2:")) throw new Error("bad");
            const payload = JSON.parse(shapez.decompressX64(trimmed.slice(5)));
            url = this.normalizeServerUrl(payload.url);
            roomId = String(payload.room || "").toUpperCase();
            if (!/^[A-Z2-9]{6}$/.test(roomId) || payload.protocol !== MP_PROTOCOL_VERSION) throw new Error("bad");
        } catch (ex) {
            state.dialogs.showWarning(this.t("mod.name"), this.t("dialog.connect.badCode"));
            return;
        }

        const net = new MpTransportClient(url, this.makeHello("client", roomId));
        net.onClose = (code, reason) => this.onDisconnectedFromHost(reason);
        net.onMessage = msg => this.handleHostMessage(msg);
        let welcome;
        try {
            welcome = await net.connect();
        } catch (ex) {
            state.dialogs.showWarning(
                this.t("mod.name"),
                this.t("dialog.connect.fail", this.formatConnectionError(ex))
            );
            return;
        }

        this.role = "client";
        this.net = net;
        this.serverUrl = url;
        this.roomId = welcome.roomId;
        this.myPlayerId = welcome.playerId;

        state.dialogs.showInfo(
            this.t("mod.name"),
            this.t("dialog.connect.waiting")
        );
    }

    askName(state) {
        return new Promise(resolve => {
            const input = new shapez.FormElementInput({
                id: "mp_name",
                label: null,
                placeholder: this.t("dialog.name.placeholder"),
                defaultValue: this.myName || this.getDefaultPlayerName(),
                validator: val => val.trim().length >= 1 && val.trim().length <= MP_MAX_NAME,
            });
            const dialog = new shapez.DialogWithForm({
                app: this.app,
                title: this.t("dialog.name.title"),
                desc: this.t("dialog.name.desc"),
                formElements: [input],
                buttons: ["cancel:bad:escape", "ok:good:enter"],
            });
            state.dialogs.internalShowDialog(dialog);
            dialog.buttonSignals.ok.add(() => resolve(input.getValue().trim()));
            dialog.buttonSignals.cancel.add(() => resolve(null));
        });
    }

    askText(state, title, desc, value) {
        return new Promise(resolve => {
            const input = new shapez.FormElementInput({
                id: "mp_text",
                label: null,
                placeholder: "",
                defaultValue: value || "",
                validator: val => val.trim().length > 0,
            });
            const dialog = new shapez.DialogWithForm({
                app: this.app,
                title,
                desc,
                formElements: [input],
                buttons: ["cancel:bad:escape", "ok:good:enter"],
            });
            state.dialogs.internalShowDialog(dialog);
            dialog.buttonSignals.ok.add(() => resolve(input.getValue()));
            dialog.buttonSignals.cancel.add(() => resolve(null));
        });
    }

    /* ---------------- Жизненный цикл ---------------- */

    onGameStarted(root) {
        // Один мод-инстанс живёт на всё приложение; session создаётся на каждый вход в игру
        if (this.session) {
            if (this.session.hudPart) {
                this.session.hudPart.cleanup();
            }
        }
        this.session = { root, hudPart: new MpHudPart(this, root), chatLines: [] };
        root.hud.parts.multiplay = this.session.hudPart;
        this.session.hudPart.createElements(document.body);
        this.session.hudPart.initialize();

        root.signals.upgradePurchased.add(this.upgradeHook);

        // Отключаем автосейв у клиента: мир всё равно перезаписывается хостом
        if (this.role === "client") {
            try {
                root.automaticSave.update = () => {};
            } catch (ex) {}
        }

        this.startCursorTicker();
        this.startHubStateTicker();

        // Heartbeat: раз в 5с логируем, что игровой цикл жив
        if (this.frameHeartbeat) clearInterval(this.frameHeartbeat);
        this.frameHeartbeat = setInterval(() => {
            if (this.session && this.session.root) {
                const mine = this.session.root.entityMgr.entities.length;
                const hostInfo =
                    this.role === "client" && this.lastHostEntities !== undefined
                        ? " host=" + this.lastHostEntities
                        : "";
                mpLog(
                    "HEARTBEAT role=" + this.role,
                    "id=" + this.myPlayerId,
                    "seed=" + this.session.root.map.seed,
                    "entities=" + mine + hostInfo,
                    "players=" + this.players.size
                );
            }
        }, 5000);

        if (this.role === "host") {
            // Рассылаем welcome всем ждущим клиентам
            if (this.pendingClients) {
                const clients = this.pendingClients;
                this.pendingClients = [];
                clients.forEach(clientId => this.sendWelcomeTo(clientId));
            }
            this.updateHudPanel();
        } else if (this.role === "client") {
            // Если дамп уже пришёл — стартуем вход в мир
            if (this.pendingDump) {
                this.enterWorldWithDump(this.pendingDump);
                this.pendingDump = null;
            } else if (!this.worldLoaded) {
                this.net.send({ t: "request-state" });
            }
        }
    }

    /** Клиент: входит в игру с дампом хоста через штатную загрузку сейва */
    enterWorldWithDump(dump) {
        this.worldLoaded = true;
        const app = this.app;
        const savegame = app.savegameMgr.createNewSavegame();
        savegame.currentData.dump = dump;
        savegame.currentData.lastUpdate = Date.now();
        this.inGameNotify(this.t("notify.loadingWorld"));
        app.stateMgr.moveToState("InGameState", { savegame });
    }

    onDisconnectedFromHost(reason) {
        if (!this.role) return;
        this.worldLoaded = false;
        this.role = null;
        this.myPlayerId = null;
        this.roomId = null;
        this.players.clear();
        if (this.net) {
            this.net = null;
        }
        this.inGameNotify(this.t("notify.disconnected", reason ? ` (${reason})` : ""));
        this.updateHudPanel();
    }

    leaveSession(notifyUser = true) {
        this.worldLoaded = false;
        if (this.role === "host" && this.net) {
            this.net.stop();
        } else if (this.role === "client" && this.net) {
            this.net.close();
        }
        this.role = null;
        this.net = null;
        this.roomId = null;
        this.myPlayerId = null;
        this.players.clear();
        this.pendingDump = null;
        if (this.cursorTimer) {
            clearInterval(this.cursorTimer);
            this.cursorTimer = null;
        }
        if (this.hubTimer) {
            clearInterval(this.hubTimer);
            this.hubTimer = null;
        }
        if (notifyUser) {
            this.inGameNotify(this.t("notify.sessionEnded"));
        }
        this.updateHudPanel();
    }

    /* ---------------- Сообщения: хост ---------------- */

    handleClientMessage(clientId, msg) {
        switch (msg.t) {
            case "hello": {
                mpLog("HOST: hello от клиента", clientId, JSON.stringify(msg).slice(0, 200));
                if (this.players.size >= MP_MAX_PLAYERS) {
                    this.net.sendToClient(clientId, { t: "kick", reason: "Сервер полон" });
                    return;
                }
                const name = String(msg.name || "Игрок").slice(0, MP_MAX_NAME);
                this.players.set(clientId, {
                    id: clientId,
                    name,
                    color: mpColorForId(clientId),
                    ping: 0,
                    cursorPos: null,
                });

                // Проверка версии и модов
                const hostVersion = mpGetGameVersion();
                if (
                    hostVersion !== null &&
                    msg.gameVersion !== null &&
                    msg.gameVersion !== hostVersion
                ) {
                    this.net.sendToClient(clientId, {
                        t: "kick",
                        reason: `Версии не совпадают: у хоста ${hostVersion}, у тебя ${msg.gameVersion}`,
                    });
                    this.players.delete(clientId);
                    return;
                }
                const diff = this.computeModsDifference(msg.mods || []);
                if (diff.missing.length || diff.extra.length) {
                    this.net.sendToClient(clientId, {
                        t: "mods-mismatch",
                        missing: diff.missing,
                        extra: diff.extra,
                    });
                    this.players.delete(clientId);
                    return;
                }

                this.pendingClients = this.pendingClients || [];
                if (!this.pendingClients.includes(clientId)) {
                    this.pendingClients.push(clientId);
                }

                if (this.session && this.session.root && this.session.root.gameInitialized) {
                    this.sendWelcomeTo(clientId);
                } else {
                    this.net.sendToClient(clientId, { t: "wait-host" });
                }

                this.broadcastPlayerList();
                this.inGameNotify(this.t("notify.joined", name));
                break;
            }

            case "request-state": {
                if (this.session && this.session.root && this.session.root.gameInitialized) {
                    if (this.players.has(clientId)) {
                        this.sendWelcomeTo(clientId);
                    }
                }
                break;
            }

            case "request-resync": {
                // Клиент заметил расхождение — шлём ему свежий полный дамп
                mpLog("RESYNC: клиент", clientId, "запросил обновление мира");
                if (this.session && this.session.root && this.session.root.gameInitialized) {
                    if (this.players.has(clientId)) {
                        this.sendResyncTo(clientId);
                    }
                }
                break;
            }

            case "op": {
                if (!this.session || !this.session.root.gameInitialized) return;
                this.handleClientOperation(clientId, msg.op);
                break;
            }

            case "cursor": {
                const player = this.players.get(clientId);
                if (player) {
                    player.cursorPos = { x: msg.x, y: msg.y };
                    this.net.broadcast({ t: "cursor", id: clientId, x: msg.x, y: msg.y }, clientId);
                }
                break;
            }

            case "chat": {
                const player = this.players.get(clientId);
                if (!player) return;
                const text = String(msg.text || "").slice(0, 200);
                this.net.broadcast(
                    { t: "chat", id: clientId, name: player.name, text },
                    clientId
                );
                this.addChatLine(player.name, player.color, text);
                this.updateHudPanel();
                break;
            }

            case "ping": {
                this.net.sendToClient(clientId, { t: "pong", time: msg.time });
                break;
            }

            case "rtt": {
                // Клиент измерил RTT — запомним и пошлём всем обновлённый список
                const player = this.players.get(clientId);
                if (player) {
                    player.ping = Math.round(msg.rtt);
                }
                break;
            }
        }
    }

    /** Хост: применяет операцию клиента и рассылает результат */
    handleClientOperation(clientId, op) {
        const root = this.session.root;

        if (!op || op.senderId !== clientId || !this.rememberOperation(op)) {
            this.net.sendToClient(clientId, {
                t: "operation-rejected",
                operationId: op && op.operationId,
                reason: "Некорректная или повторная операция",
            });
            return;
        }

        switch (op.k) {
            case "place-intent":
            case "place": {
                const metaBuilding = shapez.gMetaBuildingRegistry.findById(op.building);
                if (!metaBuilding) return;
                const variant = op.variant || shapez.defaultBuildingVariant;

                // Серверно-авторитетный пересчёт оптимального поворота
                let rotation = op.rotation || 0;
                let rotationVariant = 0;
                try {
                    const optimal = metaBuilding.computeOptimalDirectionAndRotationVariantAtTile({
                        root,
                        tile: new shapez.Vector(op.origin.x, op.origin.y),
                        rotation,
                        variant,
                        layer: metaBuilding.getLayer(),
                    });
                    rotation = optimal.rotation;
                    rotationVariant = optimal.rotationVariant;
                } catch (ex) {
                    console.warn("mp: optimal rotation failed", ex);
                }

                this.applyingRemote = true;
                let entity = null;
                try {
                    entity = root.logic.tryPlaceBuilding({
                        origin: new shapez.Vector(op.origin.x, op.origin.y),
                        rotation,
                        rotationVariant,
                        originalRotation: op.originalRotation || rotation,
                        variant,
                        building: metaBuilding,
                    });
                } finally {
                    this.applyingRemote = false;
                }

                if (entity) {
                    // Перехват tryPlaceBuilding выключен (applyingRemote), рассылаем сами
                    this.queueOutgoingPlace(entity);
                    root.soundProxy.playUi(shapez.SOUNDS.placeBuilding);
                }
                break;
            }

            case "delete-intent":
            case "delete-batch": {
                this.applyingRemote = true;
                try {
                    const uids = (op.uids || []).slice(0, 1000);
                    const deleted = [];
                    for (const uid of uids) {
                        const entity = root.entityMgr.findByUid(uid, false);
                        if (entity && root.logic.tryDeleteBuilding(entity)) {
                            deleted.push(uid);
                        }
                    }
                    if (deleted.length) {
                        this.queueOutgoingDelete(deleted);
                    }
                } finally {
                    this.applyingRemote = false;
                }
                break;
            }

            case "blueprint-intent":
            case "blueprint": {
                const placed = [];
                this.applyingRemote = true;
                try {
                    for (const item of (op.entities || []).slice(0, 5000)) {
                        const metaBuilding = shapez.gMetaBuildingRegistry.findById(item.b);
                        if (!metaBuilding) continue;
                        const entity = root.logic.tryPlaceBuilding({
                            origin: new shapez.Vector(op.tile.x + item.x, op.tile.y + item.y),
                            rotation: item.r || 0,
                            rotationVariant: item.w || 0,
                            originalRotation: item.o || item.r || 0,
                            variant: item.v || shapez.defaultBuildingVariant,
                            building: metaBuilding,
                        });
                        if (!entity) continue;
                        for (const componentId in item.c || {}) {
                            if (componentId === "StaticMapEntity" || MP_SKIP_LIVE_COMPONENTS.has(componentId)) continue;
                            const component = entity.components[componentId];
                            if (component) component.deserialize(item.c[componentId], root);
                        }
                        placed.push(entity);
                    }
                } finally {
                    this.applyingRemote = false;
                }
                for (const entity of placed) this.queueOutgoingPlace(entity);
                break;
            }

            case "lever": {
                const entity = root.entityMgr.findByUid(op.uid, false);
                if (entity && entity.components.Lever) {
                    entity.components.Lever.toggled = !!op.toggled;
                    this.broadcast({ t: "op", op: { k: "lever", uid: op.uid, toggled: !!op.toggled }, by: clientId });
                }
                break;
            }

            case "signal":
            case "constant-signal": {
                const entity = root.entityMgr.findByUid(op.uid, false);
                if (entity && entity.components.ConstantSignal) {
                    try {
                        const item = op.signal ? shapez.itemResolverSingleton(root, op.signal) : null;
                        entity.components.ConstantSignal.signal = item;
                        this.broadcast({
                            t: "op",
                            op: { k: "constant-signal", uid: op.uid, signal: op.signal },
                            by: clientId,
                        });
                    } catch (ex) {
                        console.warn("mp: signal failed", ex);
                    }
                }
                break;
            }

            case "upgrade": {
                // Покупает от имени клиента — очки общие у хоста
                if (root.hubGoals.tryUnlockUpgrade(op.upgradeId)) {
                    this.broadcast({
                        t: "op",
                        op: {
                            k: "upgrade",
                            upgradeId: op.upgradeId,
                            levels: { ...root.hubGoals.upgradeLevels },
                        },
                        by: clientId,
                    });
                }
                break;
            }
        }
    }

    sendWelcomeTo(clientId) {
        const root = this.session.root;
        if (!root.gameInitialized) {
            // Мир ещё грузится — попробуем позже
            setTimeout(() => {
                if (this.session && this.players.has(clientId)) {
                    this.sendWelcomeTo(clientId);
                }
            }, 500);
            return;
        }

        const serializer = new shapez.SavegameSerializer();
        let dump;
        try {
            dump = serializer.generateDumpFromGameRoot(root, false);
        } catch (ex) {
            console.error("mp: dump failed", ex);
            this.net.sendToClient(clientId, { t: "kick", reason: "Хосту не удалось сериализовать мир" });
            return;
        }

        if (this.pendingClients) {
            this.pendingClients = this.pendingClients.filter(id => id !== clientId);
        }

        // Сжимаем дамп: большие миры могут весить десятки мегабайт
        const compressedDump = shapez.compressX64(JSON.stringify(dump));

        this.net.sendToClient(clientId, {
            t: "welcome",
            yourId: clientId,
            players: this.serializePlayerList(),
            dump: compressedDump,
            level: root.hubGoals.level,
        });
    }

    serializePlayerList() {
        const result = [];
        this.players.forEach(p => result.push({ id: p.id, name: p.name, color: p.color, ping: p.ping }));
        return result;
    }

    /**
     * Полная пересинхронизация одного клиента: дамп мира + сброс его счётчика.
     * В отличие от welcome, клиент применяет дамп "на живую".
     */
    sendResyncTo(clientId) {
        const root = this.session.root;
        if (!root.gameInitialized) return;

        const serializer = new shapez.SavegameSerializer();
        let dump;
        try {
            dump = serializer.generateDumpFromGameRoot(root, false);
        } catch (ex) {
            console.error("mp: resync dump failed", ex);
            return;
        }

        const compressedDump = shapez.compressX64(JSON.stringify(dump));
        this.net.sendToClient(clientId, {
            t: "resync",
            dump: compressedDump,
            entities: root.entityMgr.entities.length,
        });
        mpLog("RESYNC: дамп отправлен клиенту", clientId, "сущностей:", root.entityMgr.entities.length);
    }

    broadcastPlayerList() {
        this.net.broadcast({ t: "player-list", players: this.serializePlayerList() });
        this.updateHudPanel();
    }

    /* ---------------- Сообщения: клиент ---------------- */

    handleHostMessage(msg) {
        switch (msg.t) {
            case "welcome": {
                mpLog("CLIENT: получили welcome, yourId=", msg.yourId, "dump размер:", msg.dump ? msg.dump.length : 0);
                // Повторный welcome (мы уже в игре хоста) — просто обновляем список игроков
                this.myPlayerId = msg.yourId;
                this.players.clear();
                (msg.players || []).forEach(p => this.players.set(p.id, p));
                // Гарантируем, что мы сами есть в списке
                if (!this.players.has(this.myPlayerId)) {
                    this.players.set(this.myPlayerId, {
                        id: this.myPlayerId,
                        name: this.myName,
                        color: mpColorForId(this.myPlayerId),
                        ping: 0,
                        cursorPos: null,
                    });
                }
                if (this.session && this.session.root && this.session.root.gameMode) {
                    this.updateHudPanel();
                    return;
                }

                let dump;
                try {
                    dump = JSON.parse(shapez.decompressX64(msg.dump));
                } catch (ex) {
                    console.error("mp: bad dump", ex);
                    return;
                }

                // Если мы в InGameState-загрузке (мы сами вошли в пустой мир) — перезапишем через выход
                const stateMgr = this.app.stateMgr;
                const current = stateMgr ? stateMgr.currentState : null;
                if (current && current.constructor.name === "InGameState") {
                    this.inGameNotify(this.t("notify.reconnectNotice"));
                    return;
                }

                this.enterWorldWithDump(dump);
                break;
            }

            case "wait-host": {
                // Хост ещё не в игре — ждём (информируем единожды)
                break;
            }

            case "player-list": {
                const myData = this.players.get(this.myPlayerId);
                this.players.clear();
                (msg.players || []).forEach(p => this.players.set(p.id, p));
                // Хост мог разослать список до нашего hello — возвращаем себя
                if (this.myPlayerId && !this.players.has(this.myPlayerId)) {
                    this.players.set(this.myPlayerId, {
                        id: this.myPlayerId,
                        name: this.myName,
                        color: mpColorForId(this.myPlayerId),
                        ping: myData ? myData.ping : 0,
                        cursorPos: myData ? myData.cursorPos : null,
                    });
                }
                this.updateHudPanel();
                break;
            }

            case "op": {
                if (!this.session || !this.session.root) return;
                this.applyRemoteOperation(msg.op);
                break;
            }

            case "cursor": {
                const player = this.players.get(msg.id);
                if (player) {
                    player.cursorPos = { x: msg.x, y: msg.y };
                }
                break;
            }

            case "chat": {
                this.addChatLine(msg.name, mpColorForId(msg.id), msg.text);
                this.updateHudPanel();
                break;
            }

            case "player-joined": {
                this.players.set(msg.player.id, msg.player);
                this.inGameNotify(this.t("notify.joined", msg.player.name));
                this.updateHudPanel();
                break;
            }

            case "player-left": {
                const player = this.players.get(msg.id);
                if (player) {
                    this.players.delete(msg.id);
                    this.inGameNotify(`${player.name} покинул игру`);
                }
                this.updateHudPanel();
                break;
            }

            case "mods-mismatch": {
                const missing = (msg.missing || []).map(m => m.name).join(", ");
                const extra = (msg.extra || []).map(m => m.name).join(", ");
                alert(
                    "Моды не совпадают с хостом!\n\n" +
                        (missing ? "У хоста есть, у тебя нет: " + missing + "\n" : "") +
                        (extra ? "У тебя есть, у хоста нет: " + extra : "")
                );
                this.net.close();
                this.role = null;
                this.net = null;
                break;
            }

            case "kick": {
                this.role = null;
                this.myPlayerId = null;
                if (this.net) {
                    const net = this.net;
                    this.net = null;
                    net.close();
                }
                alert(this.t("notify.kicked", msg.reason || ""));
                break;
            }

            case "operation-rejected": {
                this.inGameNotify(this.t("notify.opRejected", msg.reason || ""));
                break;
            }

            case "hub-state": {
                if (!this.session || !this.session.root) return;
                this.applyHubState(msg);

                // Сверяем количество сущностей с хостом: сильное расхождение
                // означает потерянные операции — просим полную пересинхронизацию
                if (typeof msg.entities === "number") {
                    const mine = this.session.root.entityMgr.entities.length;
                    const theirs = msg.entities;
                    this.lastHostEntities = theirs;
                    const diff = Math.abs(mine - theirs);
                    const allowed = Math.max(5, Math.ceil(theirs * 0.05)); // 5% допуск
                    if (diff > allowed && !this.resyncCooldownUntil) {
                        this.resyncCooldownUntil = Date.now() + 10000; // не чаще раза в 10с
                        mpLog("SYNC-DIFF: у меня", mine, "у хоста", theirs, "— запрашиваю ресинк");
                        this.requestResync();
                    } else if (this.resyncCooldownUntil && Date.now() > this.resyncCooldownUntil) {
                        this.resyncCooldownUntil = 0;
                    }
                }
                break;
            }

            case "resync": {
                // Хост прислал полный дамп мира — применяем на живую
                if (!this.session || !this.session.root) return;
                let dump;
                try {
                    dump = JSON.parse(shapez.decompressX64(msg.dump));
                } catch (ex) {
                    console.error("mp: bad resync dump", ex);
                    return;
                }
                if (this.applyFullDumpLive(dump, msg.entities)) {
                    this.inGameNotify(this.t("notify.resynced"));
                    this.resyncCooldownUntil = Date.now() + 5000;
                    mpLog("RESYNC: применён дамп, сущностей теперь:",
                        this.session.root.entityMgr.entities.length, "(у хоста", msg.entities + ")");
                } else {
                    this.inGameNotify(this.t("notify.resyncFailed"));
                }
                break;
            }

            case "pong": {
                const rtt = Date.now() - msg.time;
                const me = this.players.get(this.myPlayerId);
                if (me) me.ping = rtt;
                // Сообщаем хосту свой RTT (для отображения другим игрокам)
                if (this.net) {
                    this.net.send({ t: "rtt", rtt });
                }
                this.updateHudPanel();
                break;
            }
        }
    }

    /** Клиент: применяет подтверждённую операцию хоста */
    applyRemoteOperation(op) {
        if (!this.rememberOperation(op)) return;
        const root = this.session.root;
        this.applyingRemote = true;
        try {
            switch (op.k) {
                case "place": {
                    const entity = this.deserializeEntityPayload(root, op.e, op.uid);
                    if (entity) {
                        this.idempotentPlace(root, entity, op.uid);
                    }
                    break;
                }

                case "place-batch": {
                    for (const item of op.items || []) {
                        const entity = this.deserializeEntityPayload(root, item.e, item.uid);
                        if (entity) {
                            this.idempotentPlace(root, entity, item.uid);
                        }
                    }
                    break;
                }

                case "delete":
                case "delete-batch": {
                    for (const uid of op.uids || []) {
                        const entity = root.entityMgr.findByUid(uid, false);
                        if (entity) {
                            root.logic.tryDeleteBuilding(entity);
                        }
                    }
                    break;
                }

                case "lever": {
                    const entity = root.entityMgr.findByUid(op.uid, false);
                    if (entity && entity.components.Lever) {
                        entity.components.Lever.toggled = !!op.toggled;
                    }
                    break;
                }

                case "signal":
                case "constant-signal": {
                    const entity = root.entityMgr.findByUid(op.uid, false);
                    if (entity && entity.components.ConstantSignal) {
                        try {
                            entity.components.ConstantSignal.signal = op.signal
                                ? shapez.itemResolverSingleton(root, op.signal)
                                : null;
                        } catch (ex) {}
                    }
                    break;
                }

                case "upgrade": {
                    if (root.hubGoals) {
                        root.hubGoals.upgradeLevels = op.levels || root.hubGoals.upgradeLevels;
                        root.signals.upgradePurchased.dispatch(op.upgradeId);
                    }
                    break;
                }

                case "hub-state": {
                    this.applyHubState(op);
                    break;
                }
            }
        } finally {
            this.applyingRemote = false;
        }
    }

    applyHubState(msg) {
        const root = this.session.root;
        if (!root.hubGoals || !msg.hub) return;
        try {
            root.hubGoals.level = msg.hub.level;
            root.hubGoals.storedShapes = msg.hub.storedShapes;
            if (msg.hub.upgradeLevels) {
                root.hubGoals.upgradeLevels = msg.hub.upgradeLevels;
            }
        } catch (ex) {
            console.warn("mp: hub state failed", ex);
        }
    }

    /** Клиент: просит хоста прислать полный дамп мира */
    requestResync() {
        if (this.role === "client" && this.net) {
            this.net.send({ t: "request-resync" });
        }
    }

    /**
     * Сбрасывает кэш чанков карты: жилы и пятна генерируются при создании
     * чанка из map.seed, поэтому после смены seed'а старые чанки показали бы
     * жилы от предыдущего мира. Вызывать ДО deserialize дампа.
     */
    resetMapChunkCache(root) {
        try {
            root.map.chunksById = new Map();
            root.map.aggregatesById = new Map();
            // Фоновые кэши отрисовки тоже зависят от содержимого чанков
            if (root.map.clearCaches) {
                root.map.clearCaches();
            }
        } catch (ex) {
            console.warn("mp: chunk cache reset failed", ex);
        }
    }

    /** Клиент: применяет полный дамп мира "на живую" — без выхода из игры.
     * Уничтожаем все текущие сущности, чистим карту и белт-пути, затем
     * загружаем дамп как при обычной загрузке сейва. Камеру сохраняем.
     */
    applyFullDumpLive(dump, expectedCount) {
        const root = this.session.root;
        const savedCenter = root.camera.center ? root.camera.center.copy() : null;
        const savedZoom = root.camera.zoomLevel;

        this.applyingRemote = true;
        try {
            // 1. Убираем все сущности штатным путём, чтобы системы получили сигналы
            const entities = root.entityMgr.entities.slice();
            for (const entity of entities) {
                root.map.removeStaticEntity(entity);
                root.entityMgr.destroyEntity(entity);
            }
            root.entityMgr.processDestroyList();

            // 2. Чистим белт-пути (иначе "предметы текут по воздуху")
            try {
                const beltSystem = root.systemMgr.systems.belt;
                if (beltSystem) {
                    beltSystem.beltPaths = [];
                }
            } catch (ex) {
                console.warn("mp: belt paths cleanup failed", ex);
            }

            // 2.5 Сбрасываем кэш чанков: seed в дампе свой, а уже созданные
            // чанки содержат жилы от старого seed'а (рассинхрон жил)
            this.resetMapChunkCache(root);

            // 3. Загружаем дамп через штатный десериализатор
            const serializer = new shapez.SavegameSerializer();
            const status = serializer.deserialize(dump, root);
            if (!status.isGood()) {
                console.error("mp: live resync failed:", status.reason);
                mpLog("RESYNC FAIL:", status.reason);
                return false;
            }

            // Диагностика: seed карты должен совпасть с дампом
            if (dump.map && typeof dump.map.seed === "number" && root.map.seed !== dump.map.seed) {
                mpLog("RESYNC SEED MISMATCH: дамп=" + dump.map.seed, "у клиента=" + root.map.seed);
                // Десериализатор должен был применить seed; если нет — применяем сами
                root.map.seed = dump.map.seed;
                this.resetMapChunkCache(root);
            }
        } catch (ex) {
            console.error("mp: applyFullDumpLive failed", ex);
            mpLog("RESYNC ERROR:", ex);
            return false;
        } finally {
            this.applyingRemote = false;
        }

        // 4. Восстанавливаем камеру и заставляем перерисоваться
        if (savedCenter) {
            root.camera.center = savedCenter;
        }
        root.camera.zoomLevel = savedZoom;
        root.queue.requireRedraw = true;

        mpLog(
            "RESYNC OK: сущностей:",
            root.entityMgr.entities.length,
            "(ожидалось",
            expectedCount + ")"
        );
        return true;
    }

    /**
     * Идемпотентная установка сущности на клиенте:
     * 1. Если uid уже известен — это дубль сообщения, пропускаем.
     * 2. Убираем всё, что стоит на тайлах новой сущности (замещение у хоста),
     *    иначе старые сущности останутся фантомами в entityMgr и продолжат
     *    тикать ("предметы текут по воздуху").
     * 3. Регистрируем и ставим на карту.
     */
    idempotentPlace(root, entity, uid) {
        // Дедуп по uid (повторная доставка / повторный welcome)
        if (root.entityMgr.findByUid(uid, false)) {
            return;
        }

        // Убираем всё, что пересекается с тайлами новой сущности
        try {
            const bounds = entity.components.StaticMapEntity.getTileSpaceBounds();
            const victims = [];
            for (let x = bounds.x; x < bounds.x + bounds.w; ++x) {
                for (let y = bounds.y; y < bounds.y + bounds.h; ++y) {
                    const existing = root.map.getLayerContentXY(x, y, entity.layer);
                    if (existing && existing.uid !== uid) {
                        if (!victims.includes(existing)) {
                            victims.push(existing);
                        }
                    }
                }
            }
            for (const victim of victims) {
                root.logic.tryDeleteBuilding(victim);
            }
        } catch (ex) {
            console.warn("mp: idempotentPlace cleanup failed", ex);
        }

        root.map.placeStaticEntity(entity);
        root.entityMgr.registerEntity(entity, uid);
        root.entityMgr.nextUid = Math.max(root.entityMgr.nextUid, uid + 1);
    }

    /** Восстанавливает сущность из сериализованного представления (как в сейве) */
    deserializeEntityPayload(root, payload, uid) {
        try {
            const staticData = payload.components.StaticMapEntity;
            const buildingData = shapez.getBuildingDataFromCode(staticData.code);
            if (!buildingData || !buildingData.metaInstance) return null;

            const entity = buildingData.metaInstance.createEntity({
                root,
                origin: new shapez.Vector(staticData.origin.x, staticData.origin.y),
                rotation: staticData.rotation,
                originalRotation: staticData.originalRotation,
                rotationVariant: buildingData.rotationVariant,
                variant: buildingData.variant,
            });

            for (const componentId in payload.components) {
                if (MP_SKIP_LIVE_COMPONENTS.has(componentId)) continue;
                const component = entity.components[componentId];
                if (!component) continue;
                try {
                    component.deserialize(payload.components[componentId], root);
                } catch (ex) {
                    // Ошибка одного компонента не должна валить всю постройку
                }
            }
            entity.uid = uid;
            return entity;
        } catch (ex) {
            console.error("mp: deserializeEntityPayload failed", ex);
            return null;
        }
    }

    /* ---------------- Исходящие операции ---------------- */

    queueOutgoingPlace(entity) {
        const t0 = Date.now();
        const payload = this.serializeEntityLive(entity);
        if (!payload) return;
        this.placeOutbox.push({ uid: entity.uid, e: payload });
        const dt = Date.now() - t0;
        if (dt > 50) {
            console.warn("mp: serializeEntityLive slow:", dt + "ms", entity.uid);
        }
        this.ensureOutboxFlush();
    }

    queueOutgoingDelete(uids) {
        if (Array.isArray(uids)) {
            this.deleteOutbox.push(...uids);
        } else {
            this.deleteOutbox.push(uids);
        }
        this.ensureOutboxFlush();
    }

    ensureOutboxFlush() {
        if (this.outboxTimer) return;
        this.outboxTimer = setTimeout(() => {
            this.outboxTimer = null;
            this.flushOutbox();
        }, MP_BATCH_MS);
    }

    flushOutbox() {
        const t0 = Date.now();
        if (this.role === "host") {
            if (this.placeOutbox.length === 1) {
                this.broadcast({ t: "op", op: { k: "place", ...this.placeOutbox[0] }, by: 1 });
            } else if (this.placeOutbox.length > 1) {
                this.broadcast({ t: "op", op: { k: "place-batch", items: this.placeOutbox }, by: 1 });
            }
            if (this.deleteOutbox.length) {
                this.broadcast({ t: "op", op: { k: "delete", uids: this.deleteOutbox.slice(0, 1000) }, by: 1 });
            }
        } else if (this.role === "client") {
            // Клиент не рассылает свои локальные применения — только интенты
        }
        const dt = Date.now() - t0;
        if (dt > 50) {
            console.warn("mp: flushOutbox slow:", dt + "ms", "places:", this.placeOutbox.length);
        }
        this.placeOutbox = [];
        this.deleteOutbox = [];
    }

    sendIntent(op) {
        if (this.role === "client" && this.net) {
            this.net.send({ t: "op", op: this.decorateOperation(op, this.myPlayerId) });
        }
    }

    sendOp(op) {
        if (this.role === "host" && this.net) {
            this.broadcast({ t: "op", op, by: 1 });
        } else if (this.role === "client" && this.net) {
            this.net.send({ t: "op", op: this.decorateOperation(op, this.myPlayerId) });
        }
    }

    broadcast(obj) {
        if (this.role === "host" && this.net) {
            if (obj.t === "op" && obj.op && !obj.op.operationId) {
                obj = { ...obj, op: this.decorateOperation(obj.op, 1) };
            }
            this.net.broadcast(obj);
        }
    }

    decorateOperation(op, senderId) {
        const sequence = ++this.operationSequence;
        return {
            ...op,
            operationId: `${senderId}:${Date.now().toString(36)}:${sequence.toString(36)}`,
            senderId,
            sequence,
        };
    }

    rememberOperation(op) {
        if (!op || typeof op.operationId !== "string" || !Number.isInteger(op.sequence)) return false;
        if (this.seenOperationIds.has(op.operationId)) return false;
        const lastSequence = this.lastOperationSequence.get(op.senderId) || 0;
        if (op.sequence <= lastSequence) return false;
        this.lastOperationSequence.set(op.senderId, op.sequence);
        this.seenOperationIds.add(op.operationId);
        if (this.seenOperationIds.size > 10000) {
            const oldest = this.seenOperationIds.values().next().value;
            this.seenOperationIds.delete(oldest);
        }
        return true;
    }

    serializeEntityLive(entity) {
        try {
            const payload = entity.serialize();
            const components = {};
            for (const componentId in payload.components) {
                if (MP_SKIP_LIVE_COMPONENTS.has(componentId)) continue;
                components[componentId] = payload.components[componentId];
            }
            payload.components = components;
            return payload;
        } catch (ex) {
            console.error("mp: serializeEntityLive failed", ex);
            return null;
        }
    }

    /* ---------------- Диалог константного сигнала ---------------- */

    showSignalDialog(root, entity, deleteOnCancel) {
        const uid = entity.uid;
        const constantComp = entity.components.ConstantSignal;
        const current = constantComp.signal;

        const signalValueInput = new shapez.FormElementInput({
            id: "mp_signal",
            label: this.t("signal.label"),
            placeholder: "",
            defaultValue: current ? current.getAsCopyableKey() : "",
            validator: val => !!this.parseSignalCode(root, entity, val),
        });

        const items = [...Object.values(shapez.COLOR_ITEM_SINGLETONS)];
        if (entity.components.WiredPins) {
            items.unshift(shapez.BOOL_FALSE_SINGLETON, shapez.BOOL_TRUE_SINGLETON);
        }

        const itemInput = new shapez.FormElementItemChooser({
            id: "mp_signalItem",
            label: null,
            items,
        });

        const dialog = new shapez.DialogWithForm({
            app: this.app,
            title: this.t("signal.title"),
            desc: this.t("signal.desc"),
            formElements: [itemInput, signalValueInput],
            buttons: ["cancel:bad:escape", "ok:good:enter"],
        });
        root.hud.parts.dialogs.internalShowDialog(dialog);

        const apply = () => {
            if (!this.session || !this.session.root) return;
            const entityRef = this.session.root.entityMgr.findByUid(uid, false);
            if (!entityRef || !entityRef.components.ConstantSignal) return;

            let item = null;
            if (itemInput.chosenItem) {
                item = itemInput.chosenItem;
            } else {
                item = this.parseSignalCode(root, entityRef, signalValueInput.getValue());
            }
            entityRef.components.ConstantSignal.signal = item;
            // Рассылаем (формат совпадает с itemResolverSingleton: {$, data})
            const signalPayload = item ? this.serializeItem(item) : null;
            this.sendOp({ k: "constant-signal", uid, signal: signalPayload });
        };

        dialog.buttonSignals.ok.add(apply);
        dialog.valueChosen.add(() => {
            dialog.closeRequested.dispatch();
            apply();
        });

        if (deleteOnCancel) {
            dialog.buttonSignals.cancel.add(() => {
                if (!this.session || !this.session.root) return;
                const entityRef = this.session.root.entityMgr.findByUid(uid, false);
                if (entityRef) {
                    this.session.root.logic.tryDeleteBuilding(entityRef);
                }
            });
        }
    }

    /** Сериализует предмет в формат itemResolverSingleton: {$, data} */
    serializeItem(item) {
        if (!item) return null;
        // Ванильные предметы: boolean_item -> true/false, color -> имя, shape -> shortKey
        try {
            // У модовых предметов может быть свой serialize
            const itemType = item.constructor.getId();
            if (typeof item.serialize === "function") {
                return { $: itemType, data: item.serialize() };
            }
        } catch (ex) {}
        return { $: item.constructor.getId(), data: item.getAsCopyableKey() };
    }

    parseSignalCode(root, entity, code) {
        if (!code) return null;
        code = code.trim().toLowerCase();

        const modResolver = shapez.MODS_ADDITIONAL_CONSTANT_SIGNAL_RESOLVER[code];
        if (modResolver) {
            try {
                return modResolver.apply(this, [entity]);
            } catch (ex) {}
        }

        if (shapez.enumColors[code] && shapez.COLOR_ITEM_SINGLETONS[code]) {
            return shapez.COLOR_ITEM_SINGLETONS[code];
        }

        if (entity && entity.components.WiredPins) {
            if (code === "1" || code === "true") return shapez.BOOL_TRUE_SINGLETON;
            if (code === "0" || code === "false") return shapez.BOOL_FALSE_SINGLETON;
        }

        if (shapez.ShapeDefinition.isValidShortKey(code)) {
            return root.shapeDefinitionMgr.getShapeItemFromShortKey(code);
        }

        return null;
    }

    /* ---------------- Моды / список ---------------- */

    getModsList() {
        if (shapez.MODS && shapez.MODS.getModsListForSavegame) {
            return shapez.MODS.getModsListForSavegame();
        }
        return [];
    }

    computeModsDifference(theirMods) {
        const mine = this.getModsList();
        const missing = [];
        const extra = [];

        mine.forEach(m => {
            if (!theirMods.some(t => t.id === m.id)) {
                missing.push(m);
            }
        });
        theirMods.forEach(m => {
            if (!mine.some(t => t.id === m.id)) {
                extra.push(m);
            }
        });
        return { missing, extra };
    }

    /* ---------------- Тикеры ---------------- */

    startCursorTicker() {
        if (this.cursorTimer) clearInterval(this.cursorTimer);
        this.cursorTimer = setInterval(() => {
            if (!this.session || !this.net) return;
            const root = this.session.root;
            const mouse = root && root.app && root.app.mousePosition;
            if (!mouse) return;
            const world = root.camera.screenToWorld(mouse);
            if (
                Math.abs(world.x - this.lastCursor.x) < 1 &&
                Math.abs(world.y - this.lastCursor.y) < 1
            ) {
                return;
            }
            this.lastCursor = { x: world.x, y: world.y };

            if (this.role === "host") {
                const me = this.players.get(1);
                if (me) me.cursorPos = this.lastCursor;
                this.broadcast({ t: "cursor", id: 1, x: world.x, y: world.y });
            } else if (this.role === "client") {
                this.net.send({ t: "cursor", x: world.x, y: world.y });
            }
        }, MP_CURSOR_MS);
    }

    startHubStateTicker() {
        if (this.hubTimer) clearInterval(this.hubTimer);
        this.hubTimer = setInterval(() => {
            if (!this.net) return;
            if (this.role === "host") {
                const root = this.session && this.session.root;
                if (!root || !root.gameInitialized || !root.hubGoals) return;
                this.broadcast({
                    t: "hub-state",
                    hub: {
                        level: root.hubGoals.level,
                        storedShapes: root.hubGoals.storedShapes,
                        upgradeLevels: root.hubGoals.upgradeLevels,
                    },
                    entities: root.entityMgr.entities.length,
                });
            } else if (this.role === "client") {
                // Пинг для измерения RTT
                this.net.send({ t: "ping", time: Date.now() });
            }
        }, 2000);
    }

    /* ---------------- Чат / уведомления ---------------- */

    sendChat(text) {
        const trimmed = String(text || "").slice(0, 200).trim();
        if (!trimmed || !this.session) return;
        if (this.role === "host") {
            this.broadcast({ t: "chat", id: 1, name: this.myName, text: trimmed });
            this.addChatLine(this.myName, mpColorForId(1), trimmed);
            this.updateHudPanel();
        } else if (this.role === "client") {
            this.net.send({ t: "chat", text: trimmed });
        }
    }

    addChatLine(name, color, text) {
        if (!this.session) return;
        this.session.chatLines.push({ name, color, text, time: Date.now() });
        if (this.session.chatLines.length > 50) this.session.chatLines.shift();
    }

    inGameNotify(text) {
        if (this.session && this.session.root && this.session.root.hud) {
            this.session.root.hud.signals.notification.dispatch(
                text,
                shapez.enumNotificationType.info
            );
        } else {
            console.log("mp:", text);
        }
    }

    updateHudPanel() {
        if (this.session && this.session.hudPart) {
            this.session.hudPart.updatePanel();
        }
    }
}

/* ------------------------------------------------------------------ */
/*  HUD: панель и курсоры                                               */
/* ------------------------------------------------------------------ */

// ВАЖНО: наследуемся от BaseHUDPart — GameHUD каждый кадр вызывает
// shouldPauseGame()/update()/draw() у всех частей, без базового класса
// любой из этих вызовов бросает TypeError и роняет игровой цикл.
class MpHudPart extends shapez.BaseHUDPart {
    t(key, ...args) {
        return this.mod.t(key, ...args);
    }

    constructor(mod, root) {
        super(root);
        this.mod = mod;
        this.panelVisible = true;
        this.element = null;
    }

    createElements(parent) {
        this.element = document.createElement("div");
        this.element.classList.add("mpPanel");

        // Заголовок (клик = свернуть)
        this.headerElem = document.createElement("div");
        this.headerElem.classList.add("mpPanelHeader");
        this.headerElem.addEventListener("click", () => this.togglePanel());
        this.element.appendChild(this.headerElem);

        // Игроки
        this.playersElem = document.createElement("div");
        this.playersElem.classList.add("mpPlayers");
        this.element.appendChild(this.playersElem);

        this.startHostBtn = document.createElement("button");
        this.startHostBtn.classList.add("mpBtn");
        this.startHostBtn.textContent = this.t("hud.hostThisWorld");
        this.startHostBtn.addEventListener("click", ev => {
            ev.stopPropagation();
            this.mod.hostFlow({ dialogs: this.root.hud.parts.dialogs });
        });
        this.element.appendChild(this.startHostBtn);

        // Кнопка копирования кода мира (видна всегда, у хоста — главный код,
        // у клиента — код для подключения новых игроков)
        this.copyCodeBtn = document.createElement("button");
        this.copyCodeBtn.classList.add("mpBtn");
        this.copyCodeBtn.textContent = this.t("hud.copyCode");
        this.copyCodeBtn.title = this.t("hud.copyCodeTitle");
        this.copyCodeBtn.addEventListener("click", ev => {
            ev.stopPropagation();
            const code = this.mod.role === "host" ? this.mod.buildInviteCode() : null;
            if (!code) {
                this.mod.inGameNotify(this.t("notify.hostOnlyCode"));
                return;
            }
            const ok = () => {
                this.copyCodeBtn.textContent = this.t("hud.copied");
                this.copying = true;
                setTimeout(() => {
                    this.copying = false;
                    if (this.copyCodeBtn) this.copyCodeBtn.textContent = this.t("hud.copyCode");
                }, 1500);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(code).then(ok, () => this.fallbackCopy(code, ok));
            } else {
                this.fallbackCopy(code, ok);
            }
        });
        this.element.appendChild(this.copyCodeBtn);

        // Кнопка "Обновить мир" (только у клиента): полностью перезагружает
        // состояние с хоста — чинит визуальные баги и рассинхрон
        this.resyncBtn = document.createElement("button");
        this.resyncBtn.classList.add("mpBtn");
        this.resyncBtn.textContent = this.t("hud.resyncWorld");
        this.resyncBtn.title = this.t("hud.resyncTitle");
        this.resyncBtn.addEventListener("click", ev => {
            ev.stopPropagation();
            if (this.mod.role !== "client") {
                this.mod.inGameNotify(this.t("notify.clientOnlyResync"));
                return;
            }
            this.resyncBtn.textContent = this.t("hud.resyncing");
            this.resyncBtn.disabled = true;
            this.resyncing = true;
            this.mod.requestResync();
            setTimeout(() => {
                this.resyncing = false;
                if (this.resyncBtn) {
                    this.resyncBtn.textContent = this.t("hud.resyncWorld");
                    this.resyncBtn.disabled = false;
                }
            }, 3000);
        });
        this.element.appendChild(this.resyncBtn);

        // Код подключения (свернут, чтобы не мешал)
        this.codeElem = document.createElement("div");
        this.codeElem.classList.add("mpShareCode");
        this.element.appendChild(this.codeElem);

        // Чат: скрыт по умолчанию, открывается по кнопке (или Enter см. ниже)
        this.chatToggleBtn = document.createElement("button");
        this.chatToggleBtn.classList.add("mpBtn");
        this.chatToggleBtn.textContent = this.t("hud.chat");
        this.chatToggleBtn.addEventListener("click", ev => {
            ev.stopPropagation();
            this.toggleChat();
        });
        this.element.appendChild(this.chatToggleBtn);

        this.chatElem = document.createElement("div");
        this.chatElem.classList.add("mpChat", "mpChatHidden");
        this.element.appendChild(this.chatElem);

        this.chatInput = document.createElement("input");
        this.chatInput.classList.add("mpChatInput", "mpChatHidden");
        this.chatInput.placeholder = this.t("hud.chatPlaceholder");
        this.chatInput.addEventListener("keydown", ev => {
            // Пока поле в фокусе — все нажатия наши, игре не отдаём
            ev.stopPropagation();
            if (ev.key === "Enter") {
                const text = this.chatInput.value.trim();
                if (text) {
                    this.mod.sendChat(text);
                    this.chatInput.value = "";
                }
            } else if (ev.key === "Escape") {
                this.closeChat();
            }
        });
        this.chatInput.addEventListener("keyup", ev => ev.stopPropagation());
        this.chatInput.addEventListener("blur", () => {
            // Пользователь ушёл из поля — прячем чат, если он пустой и закрыт
            setTimeout(() => {
                if (!this.chatInput.value && document.activeElement !== this.chatInput) {
                    this.closeChat();
                }
            }, 200);
        });
        this.element.appendChild(this.chatInput);

        // Кнопка выхода из сессии
        this.leaveBtn = document.createElement("button");
        this.leaveBtn.classList.add("mpBtn", "danger");
        this.leaveBtn.textContent = this.t("hud.leaveSession");
        this.leaveBtn.addEventListener("click", () => {
            this.mod.leaveSession(true);
            this.updatePanel();
        });
        this.element.appendChild(this.leaveBtn);

        parent.appendChild(this.element);
    }

    /** Запасной способ копирования (если clipboard API недоступен) */
    fallbackCopy(text, ok) {
        try {
            const helper = document.createElement("textarea");
            helper.value = text;
            helper.style.position = "fixed";
            helper.style.opacity = "0";
            document.body.appendChild(helper);
            helper.select();
            document.execCommand("copy");
            helper.remove();
            ok();
        } catch (ex) {
            this.mod.inGameNotify(this.t("notify.copyFailed"));
        }
    }

    /** Открывает чат и фокусирует поле ввода */
    toggleChat() {
        if (this.chatOpen) {
            this.closeChat();
        } else {
            this.chatOpen = true;
            this.chatElem.classList.remove("mpChatHidden");
            this.chatInput.classList.remove("mpChatHidden");
            this.chatInput.focus();
        }
    }

    closeChat() {
        this.chatOpen = false;
        this.chatElem.classList.add("mpChatHidden");
        this.chatInput.classList.add("mpChatHidden");
        this.chatInput.value = "";
        this.chatInput.blur();
    }

    initialize() {
        // Перерисовка каждый кадр не нужна — DOM обновляется по событиям.
        // Но пинги обновляются редко — тикаем раз в секунду.
        this.uiTimer = setInterval(() => this.updatePanel(), 1000);
        this.updatePanel();
    }

    cleanup() {
        if (this.uiTimer) {
            clearInterval(this.uiTimer);
            this.uiTimer = null;
        }
        if (this.element && this.element.parentElement) {
            this.element.parentElement.removeChild(this.element);
        }
        this.element = null;
        super.cleanup();
    }

    togglePanel() {
        this.panelVisible = !this.panelVisible;
        if (this.element) {
            this.element.classList.toggle("mpHidden", !this.panelVisible);
        }
    }

    updatePanel() {
        if (!this.element) return;
        const mod = this.mod;
        const roleLabel =
            mod.role === "host" ? this.t("hud.roleHost") : mod.role === "client" ? this.t("hud.roleClient") : this.t("hud.roleNoSession");
        this.headerElem.innerHTML = `${this.t("mod.name")} <span class="role ${mod.role || ""}">${roleLabel}</span>`;
        this.startHostBtn.textContent = this.t("hud.hostThisWorld");
        if (!this.copying) {
            this.copyCodeBtn.textContent = this.t("hud.copyCode");
            this.copyCodeBtn.title = this.t("hud.copyCodeTitle");
        }
        if (!this.resyncing) {
            this.resyncBtn.textContent = this.t("hud.resyncWorld");
            this.resyncBtn.title = this.t("hud.resyncTitle");
        }
        this.chatToggleBtn.textContent = this.t("hud.chat");
        this.chatInput.placeholder = this.t("hud.chatPlaceholder");
        this.leaveBtn.textContent = this.t("hud.leaveSession");

        let html = "";
        mod.players.forEach(player => {
            html += `
                <div class="mpPlayer">
                    <span class="mpPlayerDot" style="background:${player.color}"></span>
                    <span class="mpPlayerName">${mpEscapeHtml(player.name)}${player.id === mod.myPlayerId ? " " + this.t("hud.youTag") : ""}</span>
                    <span class="mpPlayerPing">${player.ping ? player.ping + " " + this.t("hud.ms") : ""}</span>
                </div>
            `;
        });
        this.playersElem.innerHTML = html;

        const active = Boolean(mod.role);
        this.startHostBtn.style.display = active ? "none" : "block";
        this.playersElem.style.display = active ? "block" : "none";
        this.copyCodeBtn.style.display = mod.role === "host" ? "block" : "none";
        this.resyncBtn.style.display = mod.role === "client" ? "block" : "none";
        this.chatToggleBtn.style.display = active ? "block" : "none";
        this.leaveBtn.style.display = active ? "block" : "none";
        if (!active) this.closeChat();

        // Код подключения больше не показываем как текст (мешает) —
        // копирование через кнопку "Скопировать код мира" выше.
        if (mod.role === "client" && mod.net) {
            this.codeElem.textContent = this.t("hud.connectedTo", mod.net.url || "");
        } else {
            this.codeElem.textContent = "";
        }

        const lines = (mod.session && mod.session.chatLines) || [];
        this.chatElem.innerHTML = lines
            .slice(-10)
            .map(
                line =>
                    `<div class="mpChatLine"><span class="name" style="color:${line.color}">${mpEscapeHtml(
                        line.name
                    )}:</span> ${mpEscapeHtml(line.text)}</div>`
            )
            .join("");
        this.chatElem.scrollTop = this.chatElem.scrollHeight;
    }

    /** Рисуем курсоры других игроков — вызывается из draw-хука нашего HUD */
    drawCursors(parameters) {
        const mod = this.mod;
        const context = parameters.context;
        if (!context) return;

        mod.players.forEach(player => {
            if (player.id === mod.myPlayerId) return;
            if (!player.cursorPos) return;

            const zoom = parameters.zoomLevel || 1;
            const x = player.cursorPos.x;
            const y = player.cursorPos.y;

            context.save();
            context.globalAlpha = 0.95;

            // Точка
            context.fillStyle = player.color;
            context.beginPath();
            context.arc(x, y, 5 / zoom, 0, Math.PI * 2);
            context.fill();

            // "Курсорная" стрелка
            context.strokeStyle = player.color;
            context.lineWidth = 1.5 / zoom;
            context.beginPath();
            context.moveTo(x, y);
            context.lineTo(x + 10 / zoom, y + 10 / zoom);
            context.stroke();

            // Имя
            context.globalAlpha = 0.9;
            context.fillStyle = player.color;
            context.textAlign = "left";
            context.font = `${Math.max(9 / zoom, 8)}px GameFont`;
            context.fillText(player.name, x + 13 / zoom, y + 13 / zoom);

            context.restore();
        });
    }
}
