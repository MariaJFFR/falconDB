const express = require('express');
const axios = require('axios');

const fsdb = require('../../lib/fsdb');
const response = require('../../lib/response');
const createLogger = require('../../lib/logger');

const { DateTime } = require('luxon');

const config = require('../../../etc/configure.json');
const { normalizeKey } = require('../../lib/keyUtils');

const MY_ID = 'dn2s2';

const myDN = config.dns.find(
  dn => dn.servers.some(s => s.id === MY_ID)
);

const myServer = myDN.servers.find(s => s.id === MY_ID);

const peers = myDN.servers
  .filter(s => s.id !== MY_ID)
  .map(s => `http://${s.host}:${s.port}`);

const rpUrl = `http://${config.reverse_proxy.host}:${config.reverse_proxy.port}`;

const PORT = myServer.port;
const RP_IP = config.reverse_proxy.host;
const DN_IPS = myDN.servers.map(s => s.host);
const TEST_CLIENT_IP = config.test_client_ip || null;

const logger = createLogger(`${MY_ID}.log`);
const raftLogger = createLogger(`raft-${MY_ID}.log`);

const startTime = DateTime.now();

function getLivingTime() {
  const diff = DateTime.now().diff(startTime, ['days', 'hours', 'minutes', 'seconds']).toObject();
  const d = Math.floor(diff.days || 0);
  const h = String(Math.floor(diff.hours || 0)).padStart(2, '0');
  const m = String(Math.floor(diff.minutes || 0)).padStart(2, '0');
  const s = String(Math.floor(diff.seconds || 0)).padStart(2, '0');
  return `${d}d-${h}:${m}:${s}`;
}

// ── IP helpers ────────────────────────────────────────────────────────────────

function normalizeIP(ip) {
  if (!ip) return '';
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function requireFromRP(req, res, next) {
  if (normalizeIP(req.ip) === RP_IP) return next();
  res.status(403).json(response.failure('eDN403', 'forbidden: RP only'));
}

function requireFromDN(req, res, next) {
  if (DN_IPS.includes(normalizeIP(req.ip))) return next();
  res.status(403).json(response.failure('eDN403', 'forbidden: DN peers only'));
}

function requireFromRPorTest(req, res, next) {
  const ip = normalizeIP(req.ip);
  if (ip === RP_IP || (TEST_CLIENT_IP && ip === TEST_CLIENT_IP)) return next();
  res.status(403).json(response.failure('eDN403', 'forbidden: RP or test client only'));
}

function requireFromSelf(req, res, next) {
  const ip = normalizeIP(req.ip);
  if (ip === '127.0.0.1' || ip === myServer.host) return next();
  res.status(403).json(response.failure('eDN403', 'forbidden: localhost only'));
}

// ── Raft state ────────────────────────────────────────────────────────────────

let state = 'follower';
let currentTerm = 0;
let votedFor = null;
let leader = null;
let lastHeartbeat = Date.now();

const ELECTION_TIMEOUT = 5000 + Math.floor(Math.random() * 5000);

let stats = {
  create: 0,
  read: 0,
  update: 0,
  delete: 0
};

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (req.body && req.body.key !== undefined) req.body.key = normalizeKey(req.body.key);
  if (req.query && req.query.key !== undefined) req.query.key = normalizeKey(decodeURIComponent(req.query.key));
  next();
});



/*
  STATUS
*/
app.get('/status', (req, res) => {

  res.json({
    data: {
      id: MY_ID,
      port: PORT,
      state,
      term: currentTerm,
      start_at: startTime.toISO(),
      living_time: getLivingTime()
    },
    error: 0
  });
});



/*
  STAT
*/
app.get('/stat', (req, res) => {

  res.json({
    data: {
      start_at: startTime.toISO(),
      living_time: getLivingTime(),
      ...stats
    },
    error: 0
  });
});



/*
  ADMIN - LOGLEVEL  (prv)
*/
app.get('/admin/loglevel', requireFromSelf, (req, res) => {

  const { level } = req.query;
  logger.level = level;
  raftLogger.level = level;
  logger.info(`log level set to ${level}`);
  res.json({ data: { level }, error: 0 });
});



/*
  STOP  (RPt)
*/
app.get('/stop', requireFromRPorTest, (req, res) => {

  logger.info('stop requested');
  res.json({ data: { ok: true }, error: 0 });
  process.exit(0);
});



// ── Raft ──────────────────────────────────────────────────────────────────────

async function startElection() {

  if (state === 'candidate') return;

  state = 'candidate';
  currentTerm++;
  votedFor = MY_ID;
  let votes = 1;

  raftLogger.trace(`[TERM ${currentTerm}] election timeout – transitioning to candidate`);
  raftLogger.trace(`[TERM ${currentTerm}] voted for self (${MY_ID}), votes=1`);

  for (const peer of peers) {

    try {
      raftLogger.trace(`[TERM ${currentTerm}] sending RequestVote to ${peer}`);

      const r = await axios.get(`${peer}/election`, {
        params: { term: currentTerm, candidate: MY_ID }
      });

      if (r.data.vote) {
        votes++;
        raftLogger.trace(`[TERM ${currentTerm}] vote granted by ${peer} – total votes=${votes}`);
      } else {
        raftLogger.trace(`[TERM ${currentTerm}] vote denied by ${peer}`);
      }

    } catch (err) {
      raftLogger.trace(`[TERM ${currentTerm}] RequestVote to ${peer} failed: ${err.message}`);
    }
  }

  const majority = Math.floor((myDN.servers.length / 2)) + 1;
  raftLogger.trace(`[TERM ${currentTerm}] election result: ${votes}/${myDN.servers.length} votes (need ${majority})`);

  if (votes >= majority) {

    state = 'leader';
    leader = MY_ID;
    raftLogger.trace(`[TERM ${currentTerm}] won election – transitioning to LEADER`);

    try {
      await axios.get(`${rpUrl}/set_master`, {
        params: { dnId: myDN.id, leaderUrl: `http://${myServer.host}:${PORT}` }
      });
      raftLogger.trace(`[TERM ${currentTerm}] identity sent to RP: http://${myServer.host}:${PORT}`);
    } catch (err) {
      raftLogger.trace(`[TERM ${currentTerm}] failed to announce to RP: ${err.message}`);
    }

    startHeartbeat();

  } else {

    state = 'follower';
    raftLogger.trace(`[TERM ${currentTerm}] lost election – reverting to follower`);
  }
}



function startHeartbeat() {

  const interval = setInterval(async () => {

    if (state !== 'leader') {
      clearInterval(interval);
      return;
    }

    for (const peer of peers) {
      try {
        await axios.post(`${peer}/heartbeat`, { leaderId: MY_ID, term: currentTerm });
        raftLogger.trace(`[TERM ${currentTerm}] heartbeat sent to ${peer}`);
      } catch (err) {
        raftLogger.trace(`[TERM ${currentTerm}] heartbeat to ${peer} failed: ${err.message}`);
      }
    }

  }, 2000);
}



/*
  HEARTBEAT  (DNp)
*/
app.post('/heartbeat', requireFromDN, (req, res) => {

  const { leaderId, term } = req.body;

  raftLogger.trace(`[TERM ${term}] heartbeat received from ${leaderId}`);

  if (term >= currentTerm) {
    currentTerm = term;
    leader = leaderId;
    lastHeartbeat = Date.now();
    state = 'follower';
    votedFor = null;
  }

  res.json({ data: { ok: true }, error: 0 });
});



/*
  ELECTION / RequestVote  (DNp)
*/
app.get('/election', requireFromDN, (req, res) => {

  const term = parseInt(req.query.term);
  const candidate = req.query.candidate;

  raftLogger.trace(`[TERM ${term}] RequestVote received from ${candidate} (my term=${currentTerm}, votedFor=${votedFor})`);

  if (term > currentTerm && (votedFor === null || votedFor === candidate)) {

    currentTerm = term;
    votedFor = candidate;
    state = 'follower';
    lastHeartbeat = Date.now();

    raftLogger.trace(`[TERM ${term}] vote GRANTED to ${candidate}`);
    return res.json({ vote: true });
  }

  raftLogger.trace(`[TERM ${term}] vote DENIED to ${candidate} (currentTerm=${currentTerm}, votedFor=${votedFor})`);
  res.json({ vote: false });
});



// ── 2PC ───────────────────────────────────────────────────────────────────────

/*
  Helper: check local preconditions for an operation (used in both /prepare and /vote).
  Returns null if ok, or a reason string if not.
*/
function checkPreconditions(operation, key) {
  const existing = fsdb.read(key);

  if (operation === 'create') {
    if (existing) return 'key already exists';
  } else if (operation === 'update') {
    if (!existing) return 'key not found';
    if (typeof existing.value !== 'object' || existing.value === null || Array.isArray(existing.value)) {
      return 'existing value is not a flat object';
    }
  } else if (operation === 'delete') {
    if (!existing) return 'key not found';
  }

  return null;
}



/*
  PREPARE  (RPo – only RP calls this on the master)

  Phase 1 of 2PC: master checks local preconditions, then asks all followers
  to vote. If any follower is not ready, master sends /abort to those that
  already voted yes and returns {ok: false} to the RP.
*/
app.post('/prepare', requireFromRP, async (req, res) => {

  const { operation, key } = req.body;

  logger.info(`2PC PREPARE op=${operation} key=${key}`);

  const localReason = checkPreconditions(operation, key);
  if (localReason) {
    logger.info(`2PC PREPARE rejected locally: ${localReason}`);
    return res.json({ data: { ok: false, reason: localReason }, error: 0 });
  }

  const voted = [];

  for (const peer of peers) {
    try {
      const r = await axios.post(`${peer}/vote`, { operation, key });
      if (!r.data.data.ok) {
        // one follower said no – abort the ones that said yes
        for (const okPeer of voted) {
          try { await axios.post(`${okPeer}/abort`, { operation, key }); } catch (_) {}
        }
        logger.info(`2PC PREPARE rejected by ${peer}: ${r.data.data.reason}`);
        return res.json({ data: { ok: false, reason: `peer ${peer}: ${r.data.data.reason}` }, error: 0 });
      }
      voted.push(peer);
    } catch (err) {
      for (const okPeer of voted) {
        try { await axios.post(`${okPeer}/abort`, { operation, key }); } catch (_) {}
      }
      logger.info(`2PC PREPARE failed – ${peer} unreachable: ${err.message}`);
      return res.json({ data: { ok: false, reason: `peer ${peer} unreachable` }, error: 0 });
    }
  }

  logger.info(`2PC PREPARE ok – all peers ready`);
  res.json({ data: { ok: true }, error: 0 });
});



/*
  VOTE  (DNp – followers answer whether they can execute the operation)
*/
app.post('/vote', requireFromDN, (req, res) => {

  const { operation, key } = req.body;

  const reason = checkPreconditions(operation, key);
  if (reason) {
    logger.info(`2PC VOTE no for op=${operation} key=${key}: ${reason}`);
    return res.json({ data: { ok: false, reason }, error: 0 });
  }

  logger.info(`2PC VOTE yes for op=${operation} key=${key}`);
  res.json({ data: { ok: true }, error: 0 });
});



/*
  ABORT  (DNp – sent by master when prepare collapses mid-way)
  Nothing was locked/written in prepare, so this is a no-op, but the
  route must exist for protocol completeness.
*/
app.post('/abort', requireFromDN, (req, res) => {

  logger.info(`2PC ABORT received op=${req.body.operation} key=${req.body.key}`);
  res.json({ data: { ok: true }, error: 0 });
});



/*
  COMMIT  (RPo)
*/
app.post('/commit', requireFromRP, async (req, res) => {

  const { key, value } = req.body;

  try {
    fsdb.create(key, value);
  } catch (err) {
    return res.json(response.failure('eDNCRUD001', err.message));
  }

  logger.info(`2PC COMMIT create key=${key}`);
  stats.create++;

  for (const peer of peers) {
    try {
      await axios.post(`${peer}/replicate`, { key, value });
    } catch (err) {
      logger.error(`replicate to ${peer} failed: ${err.message}`);
    }
  }

  res.json({ data: { ok: true }, error: 0 });
});



/*
  REPLICATE  (DNp)
*/
app.post('/replicate', requireFromDN, (req, res) => {

  const { key, value } = req.body;

  // Use _write-equivalent: always overwrite on replication (leader already committed)
  const existing = fsdb.read(key);
  if (existing) {
    fsdb.remove(key);
  }
  try {
    fsdb.create(key, value);
  } catch (_) {
    // key was removed just above, this should never throw
  }

  logger.info(`replicated create key=${key}`);
  res.json({ data: { ok: true }, error: 0 });
});



/*
  COMMIT-UPDATE  (RPo)
*/
app.post('/commit-update', requireFromRP, async (req, res) => {

  const { key, value } = req.body;

  let result;
  try {
    result = fsdb.update(key, value);
  } catch (err) {
    return res.json(response.failure('eDNCRUD005', err.message));
  }

  if (!result) return res.json(response.failure('eDNCRUD005', 'key not found'));

  logger.info(`2PC COMMIT update key=${key}`);
  stats.update++;

  for (const peer of peers) {
    try {
      await axios.post(`${peer}/replicate-update`, { key, value });
    } catch (err) {
      logger.error(`replicate-update to ${peer} failed: ${err.message}`);
    }
  }

  res.json({ data: result, error: 0 });
});



/*
  REPLICATE-UPDATE  (DNp)
*/
app.post('/replicate-update', requireFromDN, (req, res) => {

  const { key, value } = req.body;

  try {
    fsdb.update(key, value);
  } catch (err) {
    logger.error(`replicate-update local error: ${err.message}`);
  }

  logger.info(`replicated update key=${key}`);
  res.json({ data: { ok: true }, error: 0 });
});



/*
  DELETE  (RPo)
*/
app.post('/delete', requireFromRP, async (req, res) => {

  const { key } = req.body;

  fsdb.remove(key);
  logger.info(`2PC COMMIT delete key=${key}`);
  stats.delete++;

  for (const peer of peers) {
    try {
      await axios.post(`${peer}/replicate-delete`, { key });
    } catch (err) {
      logger.error(`replicate-delete to ${peer} failed: ${err.message}`);
    }
  }

  res.json({ data: { ok: true }, error: 0 });
});



/*
  REPLICATE-DELETE  (DNp)
*/
app.post('/replicate-delete', requireFromDN, (req, res) => {

  const { key } = req.body;
  fsdb.remove(key);
  logger.info(`replicated delete key=${key}`);
  res.json({ data: { ok: true }, error: 0 });
});



/*
  MAINTENANCE  (DNp)
*/
app.get('/maintenance', requireFromDN, (req, res) => {

  const keys = fsdb.list();
  res.json({ data: { keys }, error: 0 });
});



// ── CRUD routes (RPt) ─────────────────────────────────────────────────────────

/*
  CREATE  (RPt)
  If this server is the master, runs full 2PC; otherwise rejects.
*/
app.post('/db/c', requireFromRPorTest, async (req, res) => {

  if (state !== 'leader') {
    return res.json(response.failure('eDNNM001', 'not master – send requests through RP'));
  }

  try {
    const { key, value } = req.body;

    const localReason = checkPreconditions('create', key);
    if (localReason) return res.json(response.failure('eDNCRUD001', localReason));

    const voted = [];
    for (const peer of peers) {
      try {
        const r = await axios.post(`${peer}/vote`, { operation: 'create', key });
        if (!r.data.data.ok) {
          for (const p of voted) { try { await axios.post(`${p}/abort`, { operation: 'create', key }); } catch (_) {} }
          return res.json(response.failure('eDNCRUD001', r.data.data.reason));
        }
        voted.push(peer);
      } catch (err) {
        for (const p of voted) { try { await axios.post(`${p}/abort`, { operation: 'create', key }); } catch (_) {} }
        return res.json(response.failure('eDNCRUD001', `peer unreachable: ${err.message}`));
      }
    }

    fsdb.create(key, value);
    logger.info(`CREATE key=${key}`);
    stats.create++;

    for (const peer of peers) {
      try { await axios.post(`${peer}/replicate`, { key, value }); } catch (err) {
        logger.error(`replicate to ${peer}: ${err.message}`);
      }
    }

    res.json(response.success({ key, value }));

  } catch (err) {
    logger.error(err.message);
    res.json(response.failure('eDNCRUD001', err.message));
  }
});



/*
  READ  (RPt)
*/
app.get('/db/r', requireFromRPorTest, (req, res) => {

  try {
    const key = req.query.key;
    const data = fsdb.read(key);

    if (!data) return res.json(response.failure('eDNCRUD002', 'key not found'));

    logger.info(`READ key=${key}`);
    stats.read++;

    res.json(response.success(data));

  } catch (err) {
    logger.error(err.message);
    res.json(response.failure('eDNCRUD002', err.message));
  }
});



/*
  UPDATE  (RPt)
  If master, runs full 2PC; otherwise rejects.
*/
app.post('/db/u', requireFromRPorTest, async (req, res) => {

  if (state !== 'leader') {
    return res.json(response.failure('eDNNM002', 'not master – send requests through RP'));
  }

  try {
    const { key, value } = req.body;

    const localReason = checkPreconditions('update', key);
    if (localReason) return res.json(response.failure('eDNCRUD005', localReason));

    const voted = [];
    for (const peer of peers) {
      try {
        const r = await axios.post(`${peer}/vote`, { operation: 'update', key });
        if (!r.data.data.ok) {
          for (const p of voted) { try { await axios.post(`${p}/abort`, { operation: 'update', key }); } catch (_) {} }
          return res.json(response.failure('eDNCRUD005', r.data.data.reason));
        }
        voted.push(peer);
      } catch (err) {
        for (const p of voted) { try { await axios.post(`${p}/abort`, { operation: 'update', key }); } catch (_) {} }
        return res.json(response.failure('eDNCRUD005', `peer unreachable: ${err.message}`));
      }
    }

    const result = fsdb.update(key, value);
    logger.info(`UPDATE key=${key}`);
    stats.update++;

    for (const peer of peers) {
      try { await axios.post(`${peer}/replicate-update`, { key, value }); } catch (err) {
        logger.error(`replicate-update to ${peer}: ${err.message}`);
      }
    }

    res.json(response.success(result));

  } catch (err) {
    logger.error(err.message);
    res.json(response.failure('eDNCRUD005', err.message));
  }
});



/*
  DELETE  (RPt)
  If master, runs full 2PC; otherwise rejects.
*/
app.get('/db/d', requireFromRPorTest, async (req, res) => {

  if (state !== 'leader') {
    return res.json(response.failure('eDNNM003', 'not master – send requests through RP'));
  }

  try {
    const key = req.query.key;

    const localReason = checkPreconditions('delete', key);
    if (localReason) return res.json(response.failure('eDNCRUD004', localReason));

    const voted = [];
    for (const peer of peers) {
      try {
        const r = await axios.post(`${peer}/vote`, { operation: 'delete', key });
        if (!r.data.data.ok) {
          for (const p of voted) { try { await axios.post(`${p}/abort`, { operation: 'delete', key }); } catch (_) {} }
          return res.json(response.failure('eDNCRUD004', r.data.data.reason));
        }
        voted.push(peer);
      } catch (err) {
        for (const p of voted) { try { await axios.post(`${p}/abort`, { operation: 'delete', key }); } catch (_) {} }
        return res.json(response.failure('eDNCRUD004', `peer unreachable: ${err.message}`));
      }
    }

    fsdb.remove(key);
    logger.info(`DELETE key=${key}`);
    stats.delete++;

    for (const peer of peers) {
      try { await axios.post(`${peer}/replicate-delete`, { key }); } catch (err) {
        logger.error(`replicate-delete to ${peer}: ${err.message}`);
      }
    }

    res.json(response.success({ deleted: key }));

  } catch (err) {
    logger.error(err.message);
    res.json(response.failure('eDNCRUD004', err.message));
  }
});



app.listen(PORT, () => {
  console.log(`${MY_ID} running on ${PORT}`);
  logger.info('server started');
});



// ── Election monitor ──────────────────────────────────────────────────────────

function startElectionMonitor() {

  setInterval(() => {

    if (state === 'leader') return;

    const diff = Date.now() - lastHeartbeat;

    if (diff > ELECTION_TIMEOUT) {
      raftLogger.trace(`[TERM ${currentTerm}] no heartbeat for ${diff}ms – starting election`);
      startElection();
    }

  }, 3000);
}

setTimeout(() => {
  raftLogger.trace('raft monitor started');
  startElectionMonitor();
}, 5000);
