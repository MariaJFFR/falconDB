const express = require('express');
const axios = require('axios');

const fsdb = require('../../common/fsdb');
const response = require('../../common/response');
const createLogger = require('../../common/logger');

const logger = createLogger('dn0s2.log');

process.env.PORT = 9002;

const app = express();

app.use(express.json());



const peers = [
  'http://127.0.0.1:9001',
  'http://127.0.0.1:9003'
];

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
      node: process.env.PORT,
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
    data: stats,
    error: 0
  });
});



async function startElection() {

  if (state === 'candidate') {
    return;
  }

  state = 'candidate';

  currentTerm++;

  votedFor = 'self';

  let votes = 1;

  logger.info(
    `[TERM ${currentTerm}] became candidate`
  );

  for (const peer of peers) {

    try {

      const response = await axios.get(
        `${peer}/election`,
        {
          params: {
            term: currentTerm,
            candidate: process.env.PORT
          }
        }
      );

      if (response.data.vote) {

        votes++;

        logger.info(
          `[TERM ${currentTerm}] received vote`
        );
      }

    } catch (err) {

      logger.error(err.message);
    }
  }

  if (votes >= 2) {

    state = 'leader';

    leader = process.env.PORT;

    logger.info(
      `[TERM ${currentTerm}] became leader`
    );

    await axios.post(
      'http://127.0.0.1:8000/set_master',
      {
        dnId: 0,
        leaderUrl:
          `http://127.0.0.1:${process.env.PORT}`
      }
    );

    logger.info(
      `[TERM ${currentTerm}] master announced to RP`
    );

    startHeartbeat();

  } else {

    state = 'follower';
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
            leaderId: process.env.PORT
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
    data: {
      ok: true
    },
    error: 0
  });
});



/*
  ELECTION
*/
app.get('/election', (req, res) => {

  const term = parseInt(req.query.term);

  const candidate = req.query.candidate;

  logger.info(
    `[TERM ${term}] vote request from ${candidate}`
  );

  if (term > currentTerm) {

    currentTerm = term;

    votedFor = candidate;

    state = 'follower';

    lastHeartbeat = Date.now();

    logger.info(
      `[TERM ${term}] voted for ${candidate}`
    );

    return res.json({
      vote: true
    });
  }

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

  // 1️⃣ escreve no leader
  fsdb.create(key, value);

  logger.info('leader commit done');

  stats.create++;

  // 2️⃣ replica para followers
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
  DELETE (2PC)
*/
app.post('/delete', (req, res) => {

  const { key } = req.body;

  fsdb.remove(key);

  logger.info('delete committed');

  stats.delete++;

  res.json({
    data: { ok: true },
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

    res.json(
      response.success({
        key,
        value
      })
    );

  } catch (err) {

    logger.error(err.message);

    res.json(
      response.failure(
        'eDNCRUD001',
        err.message
      )
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
        response.failure(
          'eDNCRUD002',
          'key not found'
        )
      );
    }

    logger.info(`READ key=${key}`);

    res.json(
      response.success(data)
    );

  } catch (err) {

    logger.error(err.message);

    res.json(
      response.failure(
        'eDNCRUD003',
        err.message
      )
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

    res.json(
      response.success({
        deleted: key
      })
    );

  } catch (err) {

    logger.error(err.message);

    res.json(
      response.failure(
        'eDNCRUD004',
        err.message
      )
    );
  }
});



app.listen(9002, () => {

  console.log('dn0s2 running on 9002');

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

      logger.info(
        'leader timeout'
      );

      startElection();
    }

  }, 3000);
}



setTimeout(() => {

  logger.info(
    'starting raft monitor'
  );

  startElectionMonitor();

}, 5000);
