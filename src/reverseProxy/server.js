const express = require('express');
const axios = require('axios');
const md5 = require('md5');
const { DateTime } = require('luxon');

const shard = require('../lib/shard');
const response = require('../lib/response');
const createLogger = require('../lib/logger');
const { normalizeKey } = require('../lib/keyUtils');
const { normalizeIP, isPrivateIP } = require('../lib/netUtils');
const { validateConfig } = require('../lib/configValidator');

validateConfig();

const config = require('../../etc/configure.json');

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

function requireFromDN(req, res, next) {
  if (isPrivateIP(normalizeIP(req.ip))) return next();
  logger.warn(`forbidden /set_master from ${normalizeIP(req.ip)}`);
  res.status(403).json(response.failure('eRP403', 'forbidden: DN peers only'));
}

function requireFromSelf(req, res, next) {
  if (normalizeIP(req.ip) === '127.0.0.1') return next();
  logger.warn(`forbidden /admin from ${normalizeIP(req.ip)}`);
  res.status(403).json(response.failure('eRP403', 'forbidden: localhost only'));
}

function requireFromRPorTest(req, res, next) {
  if (isPrivateIP(normalizeIP(req.ip))) return next();
  logger.warn(`forbidden /stop from ${normalizeIP(req.ip)}`);
  res.status(403).json(response.failure('eRP403', 'forbidden: RP or test client only'));
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (req.body && req.body.key !== undefined) req.body.key = normalizeKey(req.body.key);
  if (req.query && req.query.key !== undefined) req.query.key = normalizeKey(decodeURIComponent(req.query.key));
  next();
});

let stats = {
  create: 0,
  read: 0,
  update: 0,
  delete: 0
};



/*
  SET MASTER  (DNp)
  Spec says GET; POST kept for compatibility. Both accepted.
*/
function handleSetMaster(req, res) {
  const dnId = (req.body && req.body.dnId !== undefined) ? req.body.dnId : req.query.dnId;
  const leaderUrl = (req.body && req.body.leaderUrl) || req.query.leaderUrl;

  if (dnId === undefined || !leaderUrl) {
    return res.json(response.failure('eRPMD001', 'dnId and leaderUrl are required'));
  }

  leaders[dnId] = leaderUrl;
  logger.info(`DN ${dnId} leader -> ${leaderUrl}`);

  res.json(response.success({ ok: true }));
}

app.get('/set_master', requireFromDN, handleSetMaster);
app.post('/set_master', requireFromDN, handleSetMaster);



/*
  STATUS
*/
app.get('/status', async (req, res) => {

  const status = [];

  for (const dn in leaders) {
    try {
      const r = await axios.get(`${leaders[dn]}/status`);
      status.push({ dn, status: r.data });
    } catch (err) {
      status.push({ dn, status: 'DOWN' });
    }
  }

  res.json(response.success(status));
});



/*
  STAT
*/
app.get('/stat', (req, res) => {

  res.json(response.success({
    start_at: startTime.toISO(),
    living_time: getLivingTime(),
    ...stats
  }));
});



/*
  ADMIN - LOGLEVEL  (prv: localhost only)
*/
app.get('/admin/loglevel', requireFromSelf, (req, res) => {

  const { level } = req.query;
  logger.level = level;
  logger.info(`log level set to ${level}`);

  res.json(response.success({ level }));
});



/*
  STOP  (RPt)
*/
app.get('/stop', requireFromRPorTest, (req, res) => {

  logger.info('stop requested');
  res.json(response.success({ ok: true }));
  process.exit(0);
});



/*
  CREATE  (2PC)
*/
app.post('/db/c', async (req, res) => {

  try {
    const { key, value } = req.body;
    const dn = shard.getDN(key, Object.keys(leaders).length);
    const leaderUrl = leaders[dn];

    logger.info(`CREATE DN=${dn} leader=${leaderUrl}`);

    const prepare = await axios.post(`${leaderUrl}/prepare`, {
      operation: 'create',
      key,
      value
    });

    if (!prepare.data.data.ok) {
      return res.json(response.failure('e2PC001',
        prepare.data.data.reason || 'prepare failed'));
    }

    await axios.post(`${leaderUrl}/commit`, { key, value });

    stats.create++;

    res.json(response.success({ DB_key: md5(key), DN_id: dn, tuple: { key, value } }));

  } catch (err) {
    logger.error(err.message);
    res.json(response.failure('eRPCRUD001', err.message));
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

    logger.info(`READ DN=${dn} leader=${leaderUrl}`);

    const result = await axios.get(`${leaderUrl}/db/r`, { params: { key } });

    if (result.data.error !== 0) {
      return res.json(result.data);
    }

    stats.read++;

    res.json(response.success({ DB_key: md5(key), DN_id: dn, tuple: result.data.data }));

  } catch (err) {
    logger.error(err.message);
    res.json(response.failure('eRPCRUD002', err.message));
  }
});



/*
  UPDATE  (2PC)
*/
app.post('/db/u', async (req, res) => {

  try {
    const { key, value } = req.body;
    const dn = shard.getDN(key, Object.keys(leaders).length);
    const leaderUrl = leaders[dn];

    logger.info(`UPDATE DN=${dn} leader=${leaderUrl}`);

    const prepare = await axios.post(`${leaderUrl}/prepare`, {
      operation: 'update',
      key,
      value
    });

    if (!prepare.data.data.ok) {
      return res.json(response.failure('e2PC002',
        prepare.data.data.reason || 'prepare failed'));
    }

    const commit = await axios.post(`${leaderUrl}/commit-update`, { key, value });

    stats.update++;

    res.json(response.success({ DB_key: md5(key), DN_id: dn, tuple: commit.data.data }));

  } catch (err) {
    logger.error(err.message);
    res.json(response.failure('eRPCRUD003', err.message));
  }
});



/*
  DELETE  (2PC)
*/
app.get('/db/d', async (req, res) => {

  try {
    const key = req.query.key;
    const dn = shard.getDN(key, Object.keys(leaders).length);
    const leaderUrl = leaders[dn];

    logger.info(`DELETE DN=${dn} leader=${leaderUrl}`);

    const prepare = await axios.post(`${leaderUrl}/prepare`, {
      operation: 'delete',
      key
    });

    if (!prepare.data.data.ok) {
      return res.json(response.failure('e2PC003',
        prepare.data.data.reason || 'prepare failed'));
    }

    await axios.post(`${leaderUrl}/delete`, { key });

    stats.delete++;

    res.json(response.success({ DB_key: md5(key), DN_id: dn, tuple: { key } }));

  } catch (err) {
    logger.error(err.message);
    res.json(response.failure('eRPCRUD004', err.message));
  }
});



app.listen(PORT, () => {
  console.log(`RP running on ${PORT}`);
  logger.info('RP started');
});
