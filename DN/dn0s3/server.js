const express = require('express');
const axios = require('axios');

const fsdb = require('../../common/fsdb');
const response = require('../../common/response');
const createLogger = require('../../common/logger');

const { DateTime } = require('luxon');

const config = require('../../etc/configure.json');

const MY_ID = 'dn0s3';

const myDN = config.dns.find(
  dn => dn.servers.some(s => s.id === MY_ID)
);

const myServer = myDN.servers.find(s => s.id === MY_ID);

const peers = myDN.servers
  .filter(s => s.id !== MY_ID)
  .map(s => `http://${s.host}:${s.port}`);

const rpUrl = `http://${config.reverse_proxy.host}:${config.reverse_proxy.port}`;

const PORT = myServer.port;

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

const app = express();

app.use(express.json());



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



/*
  STATUS
*/
app.get('/status', (req, res) => {

  res.json({
    data: {
      node: PORT,
      uptime: process.uptime(),
      state
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
  ADMIN - LOGLEVEL
*/
app.get('/admin/loglevel', (req, res) => {

  const { level } = req.query;

  logger.level = level;

  logger.info(`log level set to ${level}`);

  res.json({
    data: { level },
    error: 0
  });
});



/*
  STOP
*/
app.get('/stop', (req, res) => {

  logger.info('stop requested');

  res.json({
    data: { ok: true },
    error: 0
  });

  process.exit(0);
});



async function startElection() {

  if (state === 'candidate') {
    return;
  }

  state = 'candidate';

  currentTerm++;

  votedFor = 'self';

  let votes = 1;

  raftLogger.info(
    `[TERM ${currentTerm}] election timeout detected - became candidate`
  );

  for (const peer of peers) {

    try {

      raftLogger.info(
        `[TERM ${currentTerm}] requesting vote from ${peer}`
      );

      const r = await axios.get(
        `${peer}/election`,
        {
          params: {
            term: currentTerm,
            candidate: PORT
          }
        }
      );

      if (r.data.vote) {

        votes++;

        raftLogger.info(
          `[TERM ${currentTerm}] received vote from ${peer} (votes=${votes})`
        );

      } else {

        raftLogger.info(
          `[TERM ${currentTerm}] vote denied by ${peer}`
        );
      }

    } catch (err) {

      raftLogger.error(`vote request to ${peer} failed: ${err.message}`);
    }
  }

  raftLogger.info(
    `[TERM ${currentTerm}] election result: ${votes} votes`
  );

  if (votes >= 2) {

    state = 'leader';

    leader = PORT;

    raftLogger.info(
      `[TERM ${currentTerm}] elected leader`
    );

    try {

      await axios.post(
        `${rpUrl}/set_master`,
        {
          dnId: myDN.id,
          leaderUrl: `http://${myServer.host}:${PORT}`
        }
      );

      raftLogger.info(
        `[TERM ${currentTerm}] master announced to RP`
      );

    } catch (err) {

      raftLogger.error(`set_master failed: ${err.message}`);
    }

    startHeartbeat();

  } else {

    state = 'follower';

    raftLogger.info(
      `[TERM ${currentTerm}] not enough votes - back to follower`
    );
  }
}



function startHeartbeat() {

  setInterval(async () => {

    if (state !== 'leader') {
      return;
    }

    for (const peer of peers) {

      try {

        await axios.post(
          `${peer}/heartbeat`,
          {
            leaderId: PORT
          }
        );

        logger.info(
          `heartbeat -> ${peer}`
        );

      } catch (err) {

        logger.error(err.message);
      }
    }

  }, 2000);
}



/*
  HEARTBEAT
*/
app.post('/heartbeat', (req, res) => {

  leader = req.body.leaderId;

  lastHeartbeat = Date.now();

  state = 'follower';

  logger.info(
    `heartbeat from ${leader}`
  );

  res.json({
    data: { ok: true },
    error: 0
  });
});



/*
  ELECTION
*/
app.get('/election', (req, res) => {

  const term = parseInt(req.query.term);

  const candidate = req.query.candidate;

  raftLogger.info(
    `[TERM ${term}] vote request from ${candidate}`
  );

  if (term > currentTerm) {

    currentTerm = term;

    votedFor = candidate;

    state = 'follower';

    lastHeartbeat = Date.now();

    raftLogger.info(
      `[TERM ${term}] voted for ${candidate}`
    );

    return res.json({
      vote: true
    });
  }

  raftLogger.info(
    `[TERM ${term}] denied vote for ${candidate} (currentTerm=${currentTerm})`
  );

  res.json({
    vote: false
  });
});



/*
  PREPARE (2PC)
*/
app.post('/prepare', (req, res) => {

  logger.info('2PC PREPARE received');

  res.json({
    data: { ok: true },
    error: 0
  });
});



/*
  COMMIT (2PC)
*/
app.post('/commit', async (req, res) => {

  const { key, value } = req.body;

  fsdb.create(key, value);

  logger.info('leader commit done');

  stats.create++;

  for (const peer of peers) {

    try {
      await axios.post(
        `${peer}/replicate`,
        { key, value }
      );

    } catch (err) {
      logger.error(err.message);
    }
  }

  return res.json({
    data: { ok: true },
    error: 0
  });
});



/*
  REPLICATE
*/
app.post('/replicate', (req, res) => {

  const { key, value } = req.body;

  fsdb.create(key, value);

  logger.info('replicated from leader');

  res.json({
    data: { ok: true },
    error: 0
  });
});



/*
  COMMIT UPDATE (2PC)
*/
app.post('/commit-update', async (req, res) => {

  const { key, value } = req.body;

  const result = fsdb.update(key, value);

  if (!result) {

    return res.json(
      response.failure('eDNCRUD005', 'key not found')
    );
  }

  logger.info('leader update committed');

  stats.update++;

  for (const peer of peers) {

    try {
      await axios.post(
        `${peer}/replicate-update`,
        { key, value }
      );

    } catch (err) {
      logger.error(err.message);
    }
  }

  return res.json({
    data: result,
    error: 0
  });
});



/*
  REPLICATE UPDATE
*/
app.post('/replicate-update', (req, res) => {

  const { key, value } = req.body;

  fsdb.update(key, value);

  logger.info('update replicated from leader');

  res.json({
    data: { ok: true },
    error: 0
  });
});



/*
  DELETE (2PC)
*/
app.post('/delete', async (req, res) => {

  const { key } = req.body;

  fsdb.remove(key);

  logger.info('delete committed');

  stats.delete++;

  for (const peer of peers) {

    try {
      await axios.post(
        `${peer}/replicate-delete`,
        { key }
      );

    } catch (err) {
      logger.error(err.message);
    }
  }

  res.json({
    data: { ok: true },
    error: 0
  });
});



/*
  REPLICATE DELETE
*/
app.post('/replicate-delete', (req, res) => {

  const { key } = req.body;

  fsdb.remove(key);

  logger.info('delete replicated from leader');

  res.json({
    data: { ok: true },
    error: 0
  });
});



/*
  MAINTENANCE
*/
app.get('/maintenance', (req, res) => {

  const keys = fsdb.list();

  res.json({
    data: { keys },
    error: 0
  });
});



/*
  CREATE
*/
app.post('/db/c', (req, res) => {

  try {

    const { key, value } = req.body;

    fsdb.create(key, value);

    logger.info(`CREATE key=${key}`);

    stats.create++;

    res.json(
      response.success({ key, value })
    );

  } catch (err) {

    logger.error(err.message);

    res.json(
      response.failure('eDNCRUD001', err.message)
    );
  }
});



/*
  UPDATE
*/
app.post('/db/u', (req, res) => {

  try {

    const { key, value } = req.body;

    const result = fsdb.update(key, value);

    if (!result) {

      return res.json(
        response.failure('eDNCRUD005', 'key not found')
      );
    }

    logger.info(`UPDATE key=${key}`);

    stats.update++;

    res.json(
      response.success(result)
    );

  } catch (err) {

    logger.error(err.message);

    res.json(
      response.failure('eDNCRUD006', err.message)
    );
  }
});



/*
  READ
*/
app.get('/db/r', (req, res) => {

  try {

    const key = req.query.key;

    const data = fsdb.read(key);

    if (!data) {

      return res.json(
        response.failure('eDNCRUD002', 'key not found')
      );
    }

    logger.info(`READ key=${key}`);

    stats.read++;

    res.json(
      response.success(data)
    );

  } catch (err) {

    logger.error(err.message);

    res.json(
      response.failure('eDNCRUD003', err.message)
    );
  }
});



/*
  DELETE
*/
app.get('/db/d', (req, res) => {

  try {

    const key = req.query.key;

    fsdb.remove(key);

    logger.info(`DELETE key=${key}`);

    stats.delete++;

    res.json(
      response.success({ deleted: key })
    );

  } catch (err) {

    logger.error(err.message);

    res.json(
      response.failure('eDNCRUD004', err.message)
    );
  }
});



app.listen(PORT, () => {

  console.log(`${MY_ID} running on ${PORT}`);

  logger.info('server started');
});



function startElectionMonitor() {

  setInterval(() => {

    if (state === 'leader') {
      return;
    }

    const diff =
      Date.now() - lastHeartbeat;

    if (diff > ELECTION_TIMEOUT) {

      raftLogger.info(
        `leader timeout after ${diff}ms`
      );

      startElection();
    }

  }, 3000);
}



setTimeout(() => {

  raftLogger.info(
    'starting raft monitor'
  );

  startElectionMonitor();

}, 5000);
