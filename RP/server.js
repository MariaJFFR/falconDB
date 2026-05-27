const express = require('express');
const axios = require('axios');
const md5 = require('md5');
const { DateTime } = require('luxon');

const shard = require('../common/shard');
const response = require('../common/response');
const createLogger = require('../common/logger');

const config = require('../etc/configure.json');

const logger = createLogger('rp.log');

const PORT = config.reverse_proxy.port;

const leaders = {};
config.dns.forEach(dn => {
  leaders[dn.id] = `http://${dn.servers[0].host}:${dn.servers[0].port}`;
});

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

let stats = {
  create: 0,
  read: 0,
  update: 0,
  delete: 0
};



/*
  SET MASTER
*/
app.post('/set_master', (req, res) => {

  const { dnId, leaderUrl } = req.body;

  leaders[dnId] = leaderUrl;

  logger.info(`DN ${dnId} leader -> ${leaderUrl}`);

  res.json({
    data: { ok: true },
    error: 0
  });
});



/*
  STATUS
*/
app.get('/status', async (req, res) => {

  const status = [];

  for (const dn in leaders) {

    try {

      const r = await axios.get(`${leaders[dn]}/status`);

      status.push({
        dn,
        status: r.data
      });

    } catch (err) {

      status.push({
        dn,
        status: 'DOWN'
      });
    }
  }

  res.json({
    data: status,
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



/*
  CREATE (2PC)
*/
app.post('/db/c', async (req, res) => {

  try {

    const { key, value } = req.body;

    const dn = shard.getDN(key, Object.keys(leaders).length);
    const leaderUrl = leaders[dn];

    logger.info(`DN=${dn} leader=${leaderUrl}`);

    // FASE 1: PREPARE
    const prepare = await axios.post(
      `${leaderUrl}/prepare`,
      req.body
    );

    if (!prepare.data.data.ok) {
      return res.json({
        data: 0,
        error: {
          code: 'e2PC001',
          message: 'prepare failed'
        }
      });
    }

    // FASE 2: COMMIT
    await axios.post(
      `${leaderUrl}/commit`,
      req.body
    );

    stats.create++;

    res.json({
      data: {
        DB_key: md5(key),
        DN_id: dn,
        tuple: { key, value }
      },
      error: 0
    });

  } catch (err) {

    logger.error(err.message);

    res.json({
      data: 0,
      error: {
        code: 'eRP002',
        message: err.message
      }
    });
  }
});



/*
  READ
*/
app.get('/db/r', async (req, res) => {

  try {

    const key = req.query.key;

    const dn = shard.getDN(key, Object.keys(leaders).length);
    const leaderUrl = leaders[dn];

    logger.info(`DN=${dn} leader=${leaderUrl}`);

    const result = await axios.get(
      `${leaderUrl}/db/r`,
      {
        params: { key }
      }
    );

    stats.read++;

    res.json({
      data: {
        DB_key: md5(key),
        DN_id: dn,
        tuple: result.data.data
      },
      error: 0
    });

  } catch (err) {

    logger.error(err.message);

    res.json(
      response.failure('eRPCRUD002', err.message)
    );
  }
});



/*
  UPDATE (2PC)
*/
app.post('/db/u', async (req, res) => {

  try {

    const { key } = req.body;

    const dn = shard.getDN(key, Object.keys(leaders).length);
    const leaderUrl = leaders[dn];

    logger.info(`DN=${dn} leader=${leaderUrl}`);

    // FASE 1: PREPARE
    const prepare = await axios.post(
      `${leaderUrl}/prepare`,
      req.body
    );

    if (!prepare.data.data.ok) {
      return res.json({
        data: 0,
        error: {
          code: 'e2PCU01',
          message: 'prepare failed'
        }
      });
    }

    // FASE 2: COMMIT UPDATE
    const commit = await axios.post(
      `${leaderUrl}/commit-update`,
      req.body
    );

    stats.update++;

    res.json({
      data: {
        DB_key: md5(key),
        DN_id: dn,
        tuple: commit.data.data
      },
      error: 0
    });

  } catch (err) {

    logger.error(err.message);

    res.json({
      data: 0,
      error: {
        code: 'eRPU01',
        message: err.message
      }
    });
  }
});



/*
  DELETE (2PC)
*/
app.get('/db/d', async (req, res) => {

  try {

    const key = req.query.key;

    const dn = shard.getDN(key, Object.keys(leaders).length);
    const leaderUrl = leaders[dn];

    logger.info(`DN=${dn} leader=${leaderUrl}`);

    await axios.post(`${leaderUrl}/prepare`, req.query);

    await axios.post(`${leaderUrl}/delete`, req.query);

    stats.delete++;

    res.json({
      data: {
        DB_key: md5(key),
        DN_id: dn,
        tuple: { key }
      },
      error: 0
    });

  } catch (err) {

    logger.error(err.message);

    res.json({
      data: 0,
      error: {
        code: 'eRPD01',
        message: err.message
      }
    });
  }
});



app.listen(PORT, () => {
  console.log(`RP running on ${PORT}`);
  logger.info('RP started');
});
