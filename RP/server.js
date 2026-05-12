const express = require('express');
const axios = require('axios');

const shard = require('../common/shard');
const response = require('../common/response');
const createLogger = require('../common/logger');

const logger = createLogger('rp.log');

const leaders = {
  0: 'http://127.0.0.1:9001'
};

const app = express();
app.use(express.json());

const dns = [
  'http://127.0.0.1:9001',
  'http://127.0.0.1:9002',
  'http://127.0.0.1:9003'
];

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
    data: stats,
    error: 0
  });
});



/*
  CREATE (2PC)
*/
app.post('/db/c', async (req, res) => {

  try {

    const dn = shard.getDN(req.body.key, Object.keys(leaders).length);
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
    const commit = await axios.post(
      `${leaderUrl}/commit`,
      req.body
    );

    stats.create++;

    res.json(commit.data);

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

    res.json(result.data);

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

    const dn = shard.getDN(req.body.key, Object.keys(leaders).length);
    const leaderUrl = leaders[dn];

    logger.info(`DN=${dn} leader=${leaderUrl}`);

    // PREPARE
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

    // COMMIT
    const commit = await axios.post(
      `${leaderUrl}/commit`,
      req.body
    );

    stats.update++;

    res.json(commit.data);

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

    const dn = shard.getDN(req.query.key, Object.keys(leaders).length);
    const leaderUrl = leaders[dn];

    logger.info(`DN=${dn} leader=${leaderUrl}`);

    await axios.post(`${leaderUrl}/prepare`, req.query);

    const result = await axios.post(`${leaderUrl}/delete`, req.query);

    stats.delete++;

    res.json(result.data);

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



app.listen(8000, () => {
  console.log('RP running on 8000');
  logger.info('RP started');
});
