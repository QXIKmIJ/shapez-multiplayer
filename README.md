# Shapez Multiplayer

A multiplayer mod for [Shapez.io](https://shapez.io/) that allows multiple players to share and interact with the same world.

The project provides host-authoritative world synchronization over WebSocket and is designed to work with both the Steam and portable versions of Shapez.io.

> **Status:** Active development. Core networking and synchronization are implemented, but some real-world multiplayer scenarios are still being validated.

## Features

- Host-authoritative multiplayer
- WebSocket-based networking
- Steam and portable Shapez.io support
- Multiplayer sessions for new and existing worlds
- Support for existing Shapez.io savegames
- Player IDs and player lists
- Host/client roles
- Player cursors
- In-game chat
- Ping and connection monitoring
- Full world snapshots
- Manual world resynchronization
- Automatic resynchronization support
- Operation deduplication
- Protocol and mod version validation
- Installed mod compatibility validation

### Synchronized Operations

The multiplayer protocol currently supports:

- Building placement
- Batch building placement
- Building deletion
- Batch building deletion
- Blueprint operations
- Levers
- Constant signals
- Upgrades
- Hub state

The synchronization architecture is designed to handle regular buildings, multi-tile buildings, modded buildings and buildings on the wires layer.

---

## Architecture

Shapez.io contains the actual game logic. The multiplayer server is intentionally kept independent from Shapez.io.

```text
┌───────────────────────────────┐
│       Shapez.io Client        │
│      Steam / Portable         │
│                               │
│        multiplay.js           │
└───────────────┬───────────────┘
                │
                │ WebSocket
                │
                ▼
┌───────────────────────────────┐
│   shapez-multiplayer-server   │
│                               │
│  Room management              │
│  Player management            │
│  Message relay                │
│  Version validation           │
│  Rate limiting                │
│  Heartbeat                    │
└───────────────────────────────┘
                │
                │ WebSocket
                │
                ▼
┌───────────────────────────────┐
│       Other Shapez.io         │
│           Clients             │
└───────────────────────────────┘
