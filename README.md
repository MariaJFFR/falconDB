# FalconDB

A distributed key-value database built in Node.js, implementing the **Raft consensus algorithm** for leader election and **Two-Phase Commit (2PC)** for distributed writes. Designed as a learning/experimental system for understanding distributed database fundamentals.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Directory Structure](#directory-structure)
3. [Dependencies](#dependencies)
4. [Configuration](#configuration)
5. [Shared Modules](#shared-modules)
6. [Data Nodes (DN)](#data-nodes-dn)
7. [Reverse Proxy (RP)](#reverse-proxy-rp)
8. [Raft Consensus — Deep Dive](#raft-consensus--deep-dive)
9. [Two-Phase Commit (2PC) — Deep Dive](#two-phase-commit-2pc--deep-dive)
10. [Sharding](#sharding)
11. [Storage Layer](#storage-layer)
12. [API Reference](#api-reference)
13. [Data Flow Walkthroughs](#data-flow-walkthroughs)
14. [Logging](#logging)
15. [Startup & Lifecycle](#startup--lifecycle)
16. [Running with Podman](#running-with-podman)
17. [Error Code System](#error-code-system)
18. [Known Limitations & Design Decisions](#known-limitations--design-decisions)

---

## Architecture Overview

```
                        ┌─────────────────────────────────────┐
                        │           Client (HTTP)              │
                        └────────────────┬────────────────────┘
                                         │ :8000
                        ┌────────────────▼────────────────────┐
                        │         Reverse Proxy (RP)           │
                        │   - Routes requests by shard key      │
                        │   - Orchestrates 2PC for writes       │
                        │   - Tracks current leader per shard   │
                        └────┬───────────┬───────────┬────────┘
                             │           │           │
                    :9001    │   :9002   │   :9003   │
          ┌──────────────────▼┐  ┌──────▼──────┐  ┌▼─────────────────┐
          │   Data Node 1      │  │ Data Node 2  │  │  Data Node 3      │
          │   (dn0s1)          │  │ (dn0s2)      │  │  (dn0s3)          │
          │                    │  │              │  │                   │
          │  ┌──────────────┐  │  │              │  │                   │
          │  │  Raft State  │  │  │  Raft State  │  │  Raft State       │
          │  │  - Leader    │  │  │  - Follower  │  │  - Follower       │
          │  │  - Term      │  │  │  - Term      │  │  - Term           │
          │  └──────────────┘  │  └──────────────┘  └───────────────────┘
          │                    │
          │  ┌──────────────┐  │
          │  │  File Store  │◄─┼─── Replication ──────────────────────►
          │  │  DBdata/*.json│  │
          │  └──────────────┘  │
          └────────────────────┘
```

FalconDB has three layers:

| Layer | Component | Role |
|---|---|---|
| Entry point | Reverse Proxy (`src/reverseProxy/server.js`) | Single HTTP endpoint for all client requests |
| Coordination | Raft consensus between DNs | Elects a single leader, routes all writes through it |
| Storage | File System DB (`src/lib/fsdb.js`) | Persists each key-value pair as a JSON file on disk |

All three Data Nodes hold the same data (full replication, no data partitioning despite the sharding module existing).

---

## Directory Structure

```
falconDB/
├── bin/
│   ├── falconDBd             # Start/stop script for local use (forever)
│   ├── pod-run.ps1           # Start cluster with Podman (Windows)
│   ├── pod-run.sh            # Start cluster with Podman (Linux/Mac)
│   ├── pod-stop.ps1          # Stop cluster (Windows)
│   └── pod-stop.sh           # Stop cluster (Linux/Mac)
├── etc/
│   └── configure.json        # Topology config (hosts, ports, IPs)
├── src/
│   ├── lib/
│   │   ├── fsdb.js           # File-system key-value storage primitives
│   │   ├── logger.js         # Winston logger factory
│   │   ├── response.js       # Standardized success/failure response builders
│   │   └── shard.js          # Key-to-DN routing via consistent hashing
│   ├── dataNode/
│   │   ├── dn0s1/server.js   # Data Node 1 — port 9001
│   │   ├── dn0s2/server.js   # Data Node 2 — port 9002
│   │   └── dn0s3/server.js   # Data Node 3 — port 9003
│   └── reverseProxy/
│       └── server.js         # Reverse proxy — port 8000
├── DBdata/
│   └── *.json                # One file per key (named by MD5 hash of the key)
├── logs/                     # Log files (created automatically)
├── Containerfile             # Container image definition
└── package.json              # npm manifest — dependencies
```

---

## Dependencies

| Package | Version | Why it's used |
|---|---|---|
| `express` | v5.2.1 | HTTP server framework for both RP and DN endpoints |
| `axios` | v1.16.0 | HTTP client for inter-service calls (RP→DN, DN→DN) |
| `md5` | v2.3.0 | Hashes keys deterministically for file naming and sharding |
| `winston` | v3.19.0 | Structured logging to both file and console |
| `luxon` | v3.7.2 | Date/time handling for uptime calculation |
| `forever` | v4.0.3 | Process manager — keeps services alive if they crash (local use) |

---

## Configuration

**`etc/configure.json`** — topology definition loaded at startup by every service:

```json
{
  "reverse_proxy": {
    "host": "127.0.0.1",
    "port": 8000
  },
  "test_client_ip": "127.0.0.1",
  "dns": [
    {
      "id": 0,
      "servers": [
        { "id": "dn0s1", "host": "127.0.0.1", "port": 9001 },
        { "id": "dn0s2", "host": "127.0.0.1", "port": 9002 },
        { "id": "dn0s3", "host": "127.0.0.1", "port": 9003 }
      ]
    }
  ]
}
```

All addresses, ports, and peer lists are derived from this file at runtime. No hardcoded topology in the source files.

---

## Shared Modules

### `src/lib/fsdb.js` — File System Database

The lowest layer. Stores every key-value pair as an individual JSON file under `DBdata/`.

**Key → filename mapping:**

```
key "user1"  →  MD5("user1") = "24c9e15e52afc47c225b757e7bee1f9d"
             →  DBdata/24c9e15e52afc47c225b757e7bee1f9d.json
```

Using MD5 for filenames means:
- Filenames are fixed-length (32 hex chars) regardless of key length.
- The same key always maps to the same file (deterministic).
- No filename collisions for different keys (MD5 collision risk is negligible at this scale).

**File content format:**

```json
{
  "key": "user1",
  "value": { "name": "joao", "age": 30 }
}
```

**API:**

| Function | Signature | Behavior |
|---|---|---|
| `create(key, value)` | `(key, value) → void` | Writes `{key, value}` to disk; throws if key already exists |
| `read(key)` | `key → {key, value} \| null` | Reads and parses the file; returns `null` if missing |
| `update(key, members)` | `(key, object) → {key, value} \| null` | Merges `members` into the existing value field by field; a field set to `"--delete--"` is removed; returns `null` if key doesn't exist |
| `remove(key)` | `key → void` | Deletes the file for the key |
| `list()` | `→ string[]` | Returns all MD5 filenames in DBdata |

---

### `src/lib/logger.js` — Logger Factory

Wraps Winston to produce a pre-configured logger per service:

```js
const logger = createLogger('dn0s1.log');
logger.info('server started');
logger.trace('received vote from 9002');
```

Configuration applied to every logger:
- **Level:** `trace` (all messages recorded)
- **Format:** Timestamp + simple (human-readable)
- **Transports:** File (in `logs/`) + Console (stdout)

---

### `src/lib/response.js` — Response Formatter

Every HTTP response from RP and DN follows one of two shapes:

**Success:**
```json
{
  "data": { "key": "user1", "value": { "name": "joao" } },
  "error": 0
}
```

**Failure:**
```json
{
  "data": 0,
  "error": {
    "code": "eDNCRUD002",
    "errno": 0,
    "message": "key not found"
  }
}
```

---

### `src/lib/shard.js` — Sharding / Routing

Determines which DN group a key belongs to:

```js
getDN(key, totalDNs)
```

**Algorithm:**
1. Hash the key with MD5 → 32-character hex string
2. Take the first 8 hex characters
3. Parse as a base-16 integer
4. `integer % totalDNs` = shard index (0-based)

Currently `totalDNs` is always `1` (there is only one DN group — `dn0`), so all keys map to shard 0.

---

## Data Nodes (DN)

Each DN is a self-contained Express server located in `src/dataNode/dn0s{1,2,3}/server.js`. All three are **identical code** — differentiated only by their `MY_ID` which is read from `configure.json`.

### State per Node

```js
let state = 'follower';         // 'follower' | 'candidate' | 'leader'
let currentTerm = 0;            // Raft logical clock
let votedFor = null;            // ID of candidate voted for in currentTerm
let leader = null;              // ID of the known current leader
let lastHeartbeat = Date.now(); // Timestamp of last heartbeat received (ms)

const ELECTION_TIMEOUT = random between 5000ms and 10000ms
```

These are **in-memory only** — not persisted to disk. A node restart resets all Raft state.

---

## Reverse Proxy (RP)

**Port:** 8000  
**File:** `src/reverseProxy/server.js`

The RP is the single entry point for all external clients. It:

1. **Routes** every request to the correct DN group using `shard.getDN(key)`.
2. **Tracks the current leader** per shard — updated via `/set_master` when a DN wins an election.
3. **Orchestrates 2PC** for all write operations (create, update, delete).
4. **Forwards reads** directly to the shard leader.

---

## Raft Consensus — Deep Dive

Raft is a consensus protocol that guarantees a single leader among a cluster of nodes. FalconDB uses it to ensure only one DN accepts writes at any time.

### Node States

```
            timeout / no heartbeat
Follower ──────────────────────────► Candidate
    ▲                                     │
    │ receive heartbeat from leader        │ win majority vote
    │                                     ▼
    └──────────────────────────────── Leader
              step down (term < peer's term)
```

- **Follower** — passive; waits for heartbeats; can vote in elections.
- **Candidate** — actively seeking votes; increments term and solicits peers.
- **Leader** — the single authoritative node; sends heartbeats; handles all writes.

### Election Trigger

A background loop runs every **3 seconds** on every non-leader node:

```
if (now - lastHeartbeat > ELECTION_TIMEOUT) → startElection()
```

`ELECTION_TIMEOUT` is randomized between 5–10 seconds per node to reduce simultaneous elections. There is an initial **5-second grace period** after startup before the monitor begins.

### Election Process

1. Transition to `candidate`.
2. Increment `currentTerm`.
3. Vote for self.
4. Send `GET /election?term=<currentTerm>` to both peers.
5. Each peer responds `{ vote: true }` if `term > peer.currentTerm` and peer hasn't voted this term.
6. Need **≥ 2 votes** (majority of 3) to win.
7. **If won:** set `state = 'leader'`, notify RP via `/set_master`, start heartbeat loop.
8. **If lost:** revert to `follower`.

### Heartbeat

The leader sends `POST /heartbeat` to both peers **every 2 seconds**. Followers reset their election timer on each heartbeat received.

---

## Two-Phase Commit (2PC) — Deep Dive

2PC ensures that writes are either committed on **all** replicas or on **none**.

### Phase 1 — Prepare (`POST /prepare`)

The RP calls this on the leader. The leader checks local preconditions and asks all followers to **vote**:

| Operation | Condition to vote YES |
|---|---|
| `create` | Key does **not** exist |
| `update` | Key **exists** and value is a flat object |
| `delete` | Key **exists** |

If any peer votes NO or is unreachable, the prepare fails and the operation is aborted.

### Phase 2 — Commit

Only called if Phase 1 succeeded. The leader:
1. Writes the data locally.
2. Replicates to all followers asynchronously.
3. Returns success to the RP.

### 2PC Flow Diagram

```
RP                    Leader                Follower (DN2)    Follower (DN3)
│                          │                      │                 │
│ POST /prepare             │                      │                 │
│──────────────────────────►│                      │                 │
│                          │ POST /vote            │                 │
│                          │──────────────────────►│                 │
│                          │──────────────────────────────────────► │
│                          │  votes yes            │                 │
│       { ok: true }        │                      │                 │
│◄──────────────────────────│                      │                 │
│                          │                      │                 │
│ POST /commit {key,value}  │                      │                 │
│──────────────────────────►│                      │                 │
│                          │ fsdb.create(key,val)  │                 │
│                          │──────────────────────►│ POST /replicate │
│                          │──────────────────────────────────────► │
│       { ok: true }        │  (async, no wait)    │                 │
│◄──────────────────────────│                      │                 │
```

---

## Sharding

```
shard_id = parseInt(MD5(key).substring(0, 8), 16) % totalDNGroups
```

Currently only **1 DN group** (`dn0`) exists, so all keys map to shard 0. The architecture supports adding more DN groups to split the keyspace horizontally.

---

## Storage Layer

**Location:** `DBdata/` — mounted as a shared volume in Podman, or local folder when running without containers.

**File per key:**
```
DBdata/
├── 24c9e15e52afc47c225b757e7bee1f9d.json   ← key: "user1"
└── 698dc19d489c4e4db73e28a713eab07b.json   ← key: "teste"
```

**Storage characteristics:**
- **No schema enforcement** — any JSON value is accepted.
- **No indexing** — lookup is O(1) via MD5 filename.
- **No WAL** — a crash mid-write could corrupt a file.
- **`create` throws if key exists** — use `update` to modify an existing key.

---

## API Reference

### Reverse Proxy (port 8000) — Client-facing

#### `GET /status`
Returns the live status of all DNs.

```json
{"data":[{"dn":"0","status":{"data":{"id":"dn0s2","port":9002,"state":"leader","term":2},"error":0}}],"error":0}
```

#### `GET /stat`
Returns the RP's own operation counters.

```json
{ "data": { "create": 5, "read": 12, "update": 2, "delete": 1, "living_time": "0d-00:10:00" }, "error": 0 }
```

#### `POST /db/c` — Create
```json
{ "key": "user1", "value": { "name": "joao" } }
```

#### `GET /db/r?key=<key>` — Read

#### `POST /db/u` — Update
```json
{ "key": "user1", "value": { "age": 21 } }
```

#### `GET /db/d?key=<key>` — Delete

#### `GET /set_master` — Internal: leader announcement
Called automatically by a DN when it wins an election.

---

### Data Node (ports 9001–9003) — Internal

| Endpoint | Method | Description |
|---|---|---|
| `/status` | GET | Node state (id, port, raft state, term, uptime) |
| `/stat` | GET | Operation counters |
| `/election` | GET | Raft vote request |
| `/heartbeat` | POST | Leader heartbeat |
| `/prepare` | POST | 2PC Phase 1 — check + vote collection |
| `/vote` | POST | Follower vote response |
| `/abort` | POST | 2PC abort signal |
| `/commit` | POST | 2PC Phase 2 — create + replicate |
| `/commit-update` | POST | 2PC Phase 2 — update + replicate |
| `/delete` | POST | 2PC delete + replicate |
| `/replicate` | POST | Follower replication target (create) |
| `/replicate-update` | POST | Follower replication target (update) |
| `/replicate-delete` | POST | Follower replication target (delete) |
| `/db/c` | POST | Direct create (leader only) |
| `/db/r` | GET | Read from local store |
| `/db/u` | POST | Direct update (leader only) |
| `/db/d` | GET | Direct delete (leader only) |
| `/stop` | GET | Graceful shutdown |
| `/admin/loglevel` | GET | Change log level at runtime |

---

## Data Flow Walkthroughs

### Write: `POST /db/c { key: "user1", value: { name: "joao" } }`

```
1. Client → RP:8000 POST /db/c
2. RP: shard = getDN("user1", 1) = 0
3. RP: leaderUrl = leaders[0] = "http://127.0.0.1:9002"
4. RP → Leader POST /prepare { operation: "create", key }
5. Leader checks locally + asks peers to /vote
6. All vote yes → { ok: true }
7. RP → Leader POST /commit { key, value }
8. Leader: fsdb.create("user1", { name: "joao" })
9. Leader → DN1, DN3 POST /replicate { key, value }  (async)
10. RP → Client: { data: { DB_key, DN_id, tuple }, error: 0 }
```

### Read: `GET /db/r?key=user1`

```
1. Client → RP:8000
2. RP routes to leader
3. Leader: fsdb.read("user1") → returns file content
4. RP → Client: { data: { DB_key, DN_id, tuple }, error: 0 }
```

### Delete: `GET /db/d?key=user1`

```
1. Client → RP:8000
2. RP → Leader POST /prepare { operation: "delete", key }
3. All peers vote yes
4. RP → Leader POST /delete { key }
5. Leader: fsdb.remove("user1") + replicates to peers
6. RP → Client: { data: { DB_key, DN_id, tuple }, error: 0 }
```

---

## Logging

Each service writes to its own log file in `logs/`:

| Ficheiro | Serviço |
|---|---|
| `logs/rp.log` | Reverse Proxy |
| `logs/dn0s1.log` | Data Node 1 |
| `logs/dn0s2.log` | Data Node 2 |
| `logs/dn0s3.log` | Data Node 3 |
| `logs/raft-dn0s1.log` | Raft events — DN1 |
| `logs/raft-dn0s2.log` | Raft events — DN2 |
| `logs/raft-dn0s3.log` | Raft events — DN3 |

---

## Startup & Lifecycle

### With Podman (recommended)

```powershell
.\bin\pod-run.ps1    # build image + start all containers
.\bin\pod-stop.ps1   # stop and remove pod
```

### Local (without Podman)

```bash
./bin/falconDBd start    # starts RP + 3 DNs via forever
./bin/falconDBd stop     # stops all
./bin/falconDBd restart
./bin/falconDBd stat     # list forever processes
```

### Per-node startup sequence

```
t=0s    Express server starts on PORT
t=0s    Logger initialized, "server started" logged
t=5s    Raft election monitor begins (3s polling interval)
t=8s+   First election check — if no heartbeat, election starts
```

---

## Running with Podman

### Prerequisites

- Podman installed
- Podman Machine running: `podman machine start`

### Start the cluster

```powershell
.\bin\pod-run.ps1
```

Wait ~10 seconds for Raft to elect a leader.

### Check cluster status

```powershell
curl.exe http://localhost:8000/status
```

### Test CRUD

```powershell
# CREATE
curl.exe -X POST http://localhost:8000/db/c -H "Content-Type: application/json" -d '{\"key\":\"teste\",\"value\":{\"nome\":\"maria\"}}'

# READ
curl.exe "http://localhost:8000/db/r?key=teste"

# UPDATE
curl.exe -X POST http://localhost:8000/db/u -H "Content-Type: application/json" -d '{\"key\":\"teste\",\"value\":{\"idade\":20}}'

# DELETE
curl.exe "http://localhost:8000/db/d?key=teste"

# STATS
curl.exe http://localhost:8000/stat
```

### View logs

```powershell
# live logs from a container
podman logs -f dn0s2

# or open the files directly in logs/
```

### Stop the cluster

```powershell
.\bin\pod-stop.ps1
```

---

## Error Code System

| Prefix | Scope |
|---|---|
| `eDNCRUD###` | Data Node CRUD operation failures |
| `eDNNM###` | Not master — write sent to a follower |
| `eDN403` | Forbidden — request from unauthorized IP |
| `e2PC###` | Two-phase commit protocol failures |
| `eRP403` | Forbidden — request from unauthorized IP (RP side) |
| `eRPCRUD###` | Reverse proxy CRUD forwarding errors |
| `eRPMD###` | Reverse proxy set_master errors |

---

## Known Limitations & Design Decisions

### 1. Raft state is not persisted
`currentTerm`, `votedFor`, and leadership status live only in memory. A node restart resets these, which means a node could vote twice in the same term across restarts.

### 2. 2PC requires all peers available
The prepare phase fails if any peer is unreachable — even if a majority is available. True fault-tolerant 2PC would allow a quorum (2 of 3) to proceed.

### 3. Async replication (eventual consistency)
After the leader commits, it replicates to followers asynchronously and immediately returns success. A follower crash after commit but before replication causes data divergence.

### 4. Only one shard group
All keys map to shard 0 (`dn0`). The sharding module supports multiple groups but only one is configured.

### 5. No authentication
Internal DN endpoints (`/prepare`, `/commit`, `/replicate`, `/election`, `/heartbeat`) are protected by IP filtering only — no token or certificate authentication.

### 6. Split-brain risk
No leader lease mechanism. A network partition could cause two nodes to believe they are leader simultaneously.
