import express from 'express';
import { Client } from 'ssh2';

const router = express.Router();

function execCommand(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (d) => (out += d.toString()));
      stream.stderr.on('data', (d) => (out += d.toString()));
      stream.on('close', () => resolve(out));
    });
  });
}

router.get('/', async (req, res) => {
  const { sn } = req.query;
  if (!sn) return res.status(400).json({ error: 'sn query param required' });

  const conn = new Client();

  try {
    const output = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      conn.on('error', (e) => finish(reject, e));
      conn.on('ready', async () => {
        try {
          const out = await execCommand(conn, `eve_ip ${sn}`);
          finish(resolve, out);
        } catch (e) { finish(reject, e); }
      });

      conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
        finish(prompts.map(() => process.env.CMD_HOST_PASSWORD));
      });

      conn.connect({
        host: process.env.CMD_HOST,
        port: 22,
        username: process.env.CMD_HOST_USER,
        password: process.env.CMD_HOST_PASSWORD,
        tryKeyboard: true,
        readyTimeout: 20000,
      });
    });

    // eve_ip returns a Python error when the SN doesn't exist
    const isError = /not subscriptable|NoneType|TypeError|Traceback/i.test(output);
    const ipMatch = output.match(/(\d{1,3}(?:\.\d{1,3}){3})/);

    if (isError || !ipMatch) {
      res.json({ valid: false });
    } else {
      res.json({ valid: true, ilomIp: ipMatch[1] });
    }
  } catch (err) {
    console.error('[validate-sn]', err.message);
    const isNetworkErr = err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT';
    const message = isNetworkErr
      ? `Cannot reach ${process.env.CMD_HOST} — check VPN / network`
      : err.message;
    res.status(503).json({ error: message });
  } finally {
    try { conn.end(); } catch {}
  }
});

export default router;
