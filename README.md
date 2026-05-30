# FalconDB

A distributed key-value database built in Node.js, using **Raft** for leader election and **Two-Phase Commit (2PC)** for distributed writes.

---

## Architecture

```
                    ┌──────────────────────┐
                    │     Client (HTTP)     │
                    └──────────┬───────────┘
                               │ :8000
                    ┌──────────▼───────────┐
                    │    Reverse Proxy      │
                    │  · routes by shard    │
                    │  · orchestrates 2PC   │
                    │  · tracks leaders     │
                    └────┬─────────┬────┬──┘
                         │         │    │
           ┌─────────────▼─┐ ┌─────▼──┐ ┌▼────────────┐
           │   Shard  dn0  │ │  dn1   │ │    dn2      │
           │               │ │        │ │             │
           │  dn0s1 leader │ │  dn1s1 │ │  dn2s1      │
           │  dn0s2        │ │  dn1s2 │ │  dn2s2      │
           │  dn0s3        │ │  dn1s3 │ │  dn2s3      │
           │               │ │        │ │             │
           │  Raft + 2PC   │ │  Raft  │ │  Raft       │
           │  DBdata/*.json│ │ DBdata │ │  DBdata     │
           └───────────────┘ └────────┘ └─────────────┘
                  ◄────────── replication ──────────►
```

Each shard group runs **Raft** internally to elect a leader. All writes go through the leader and are replicated to the other two nodes.

---

## Requirements

- [Podman](https://podman.io/) installed and running
- **Windows:** `podman machine start`

---

## Getting Started

### 1. Build the image

**Windows**
```powershell
.\bin\podman-compose.ps1 build
```

**Linux / macOS**
```bash
./bin/podman-compose build
```

### 2. Start the cluster

**Windows**
```powershell
.\bin\podman-compose.ps1
```

**Linux / macOS**
```bash
./bin/podman-compose
```

Wait ~10 seconds for Raft to elect leaders, then check:

```powershell
curl.exe http://localhost:8000/status
```

---

## CRUD

> On **Linux/macOS** use `curl` instead of `curl.exe` and single quotes around the JSON.

### Check cluster status
```powershell
curl.exe http://localhost:8000/status
```

### Create
```powershell
curl.exe -X POST http://localhost:8000/db/c `
  -H "Content-Type: application/json" `
  -d '{\"key\":\"teste\",\"value\":{\"nome\":\"maria\"}}'
```

### Read
```powershell
curl.exe "http://localhost:8000/db/r?key=teste"
```

### Update
```powershell
curl.exe -X POST http://localhost:8000/db/u `
  -H "Content-Type: application/json" `
  -d '{\"key\":\"teste\",\"value\":{\"idade\":20}}'
```

### Delete
```powershell
curl.exe "http://localhost:8000/db/d?key=teste"
```

### Stats
```powershell
curl.exe http://localhost:8000/stat
```

---

## CRUD Verification

To verify that operations were correctly written and replicated across all data nodes:

**Windows**
```powershell
.\bin\to-check-crud.ps1 curl.exe -X POST http://localhost:8000/db/c `
  -H "Content-Type: application/json" `
  -d '{\"key\":\"teste\",\"value\":{\"nome\":\"maria\"}}'
```

**Linux / macOS**
```bash
./bin/to-check-crud curl http://localhost:8000/db/c \
  -X POST -H "Content-Type: application/json" \
  -d '{"key":"teste","value":{"nome":"maria"}}'
```

The script snapshots the filesystem before and after the command, then checks that all replicas of the affected shard are consistent.

---

## Stop / Remove

| Action | Windows | Linux / macOS |
|---|---|---|
| Stop containers | `.\bin\podman-do-stop.ps1` | `./bin/podman-do-stop` |
| Remove containers | `.\bin\podman-rm.ps1` | `./bin/podman-rm` |

---

## Project Structure

```
falconDB/
├── bin/                        # Scripts
│   ├── podman-compose(.ps1)    # Start cluster
│   ├── podman-do-stop(.ps1)    # Stop containers
│   ├── podman-rm(.ps1)         # Remove containers
│   └── to-check-crud(.ps1)     # CRUD verification
├── etc/
│   └── configure.json          # Topology (hosts, ports)
├── src/
│   ├── lib/
│   │   ├── fsdb.js             # File-system key-value store
│   │   ├── shard.js            # Key-to-shard routing
│   │   ├── response.js         # Standardized response format
│   │   ├── logger.js           # Logger factory (Winston)
│   │   └── netUtils.js         # Private IP helper
│   ├── dataNode/               # 9 data node servers (dn0–dn2, s1–s3)
│   └── reverseProxy/
│       └── server.js           # Entry point — port 8000
├── DBdata/                     # Persisted data (one JSON file per key)
├── logs/                       # Log files (auto-created)
├── Containerfile               # Container image definition
├── docker-compose.yml          # Compose topology
└── package.json
```

---

## How It Works

| Concept | Description |
|---|---|
| **Sharding** | Keys are distributed across 3 shard groups via `MD5(key) % 3` |
| **Raft** | Each shard group elects a leader; only the leader accepts writes |
| **2PC** | Writes require all replicas to vote YES before committing |
| **Storage** | Each key is stored as `MD5(key).json` in `DBdata/` |

---

## Logs

```
logs/
├── rp.log            # Reverse Proxy
├── dn0s1.log         # Data Node logs
├── raft-dn0s1.log    # Raft election events
└── ...
```

Live logs from a container:
```powershell
podman logs -f dn0s1
```
