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
const SELF_IP = config.reverse_proxy.host;
const TEST_CLIENT_IP = config.test_client_ip || null;
const ALL_DN_IPS = config.dns.flatMap(dn => dn.servers.map(s => s.host));

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

function normalizeIP(ip) {
  if (!ip) return '';
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function requireFromDN(req, res, next) {
  const ip = normalizeIP(req.ip);
  if (ALL_DN_IPS.includes(ip)) return next();
  logger.warn(`forbidden /set_master from ${ip}`);
  res.status(403).json(response.failure('eRP403', 'forbidden: DN peers only'));
}

function requireFromSelf(req, res, next) {
  const ip = normalizeIP(req.ip);
  if (ip === '127.0.0.1' || ip === SELF_IP) return next();
  logger.warn(`forbidden /admin from ${ip}`);
  res.status(403).json(response.failure('eRP403', 'forbidden: localhost only'));
}

function requireFromRPorTest(req, res, next) {
  const ip = normalizeIP(req.ip);
  if (ip === SELF_IP || (TEST_CLIENT_IP && ip === TEST_CLIENT_IP)) return next();
  logger.warn(`forbidden /stop from ${ip}`);
  res.status(403).json(response.failure('eRP403', 'forbidden: RP or test client only'));
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

  res.json({ data: { ok: true }, error: 0 });
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

  res.json({ data: status, error: 0 });
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
  ADMIN - LOGLEVEL  (prv: localhost only)
*/
app.get('/admin/loglevel', requireFromSelf, (req, res) => {

  const { level } = req.query;
  logger.level = level;
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

    res.json({
      data: { DB_key: md5(key), DN_id: dn, tuple: { key, value } },
      error: 0
    });

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

    stats.read++;

    res.json({
      data: { DB_key: md5(key), DN_id: dn, tuple: result.data.data },
      error: 0
    });

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
      return res.json(response.failure('e2PCU01',
        prepare.data.data.reason || 'prepare failed'));
    }

    const commit = await axios.post(`${leaderUrl}/commit-update`, { key, value });

    stats.update++;

    res.json({
      data: { DB_key: md5(key), DN_id: dn, tuple: commit.data.data },
      error: 0
    });

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
      return res.json(response.failure('e2PCD01',
        prepare.data.data.reason || 'prepare failed'));
    }

    await axios.post(`${leaderUrl}/delete`, { key });

    stats.delete++;

    res.json({
      data: { DB_key: md5(key), DN_id: dn, tuple: { key } },
      error: 0
    });

  } catch (err) {
    logger.error(err.message);
    res.json(response.failure('eRPCRUD004', err.message));
  }
});



app.listen(PORT, () => {
  console.log(`RP running on ${PORT}`);
  logger.info('RP started');
});
