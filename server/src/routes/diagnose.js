import express from 'express';
import { exec } from 'child_process';
import { Client } from 'ssh2';

const router = express.Router({ mergeParams: true });

function sshExec(conn, command) {
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

function localExec(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      resolve(stdout + stderr);
    });
  });
}

function parseIlomProblems(output) {
  const faults = {
    components: [],
    psuPorts: [],
    retimerIds: [],
    e1sIds: [],
  };

  const compSet = new Set();
  const add = (list, set, id) => { if (!set.has(id)) { set.add(id); list.push(id); } };
  const addComp = (c) => add(faults.components, compSet, c);

  const psuSeen = new Set();
  const retimerSeen = new Set();
  const e1sSeen = new Set();

  let m;

  const psuRe = /\/SYS\/PSU?\/? *(\d+)/gi;
  while ((m = psuRe.exec(output)) !== null) {
    add(faults.psuPorts, psuSeen, `psu-port-${parseInt(m[1], 10) + 1}`);
    addComp('psu');
  }
  if (!compSet.has('psu') && /class\s*=\s*PSUMOD/i.test(output)) addComp('psu');

  if (/\/SYS\/GPU|GPU[\s_]?BASEBOARD|GPUBD/i.test(output)) addComp('gpu');
  if (/\/SYS\/BMC\b/i.test(output)) addComp('bmc');
  if (/\/SYS\/ROT\b/i.test(output)) addComp('rot');

  const retimerRe = /\/SYS\/(?:\w+\/)*RETIMER\/? *(\d+)|GXR3V\w*?(\d+)/gi;
  while ((m = retimerRe.exec(output)) !== null) {
    const n = parseInt(m[1] ?? m[2], 10);
    if (!isNaN(n)) { add(faults.retimerIds, retimerSeen, `retimer-${n}`); addComp('iob'); }
  }

  if (/\/SYS\/[^/]*E1S[_\-.]?A\b|E1S[_\-.]?A/i.test(output)) { add(faults.e1sIds, e1sSeen, 'e1s-a'); addComp('iob'); }
  if (/\/SYS\/[^/]*E1S[_\-.]?B\b|E1S[_\-.]?B/i.test(output)) { add(faults.e1sIds, e1sSeen, 'e1s-b'); addComp('iob'); }
  if (/\/SYS\/IOB\b|IOB[\s_]?TRAY/i.test(output)) addComp('iob');
  if (/\/SYS\/GBB|\/SYS\/OSFP|\/SYS\/(?:\w+\/)*PCIE|class\s*=\s*PCIE\b/i.test(output)) addComp('gbb');

  return { faults, raw: output };
}

router.get('/', async (req, res) => {
  const { serialNumber } = req.query;
  if (!serialNumber) return res.status(400).json({ error: 'serialNumber query param required' });

  if (!/^[a-zA-Z0-9]+$/.test(serialNumber)) {
    return res.status(400).json({ error: 'Invalid serial number format' });
  }

  const conn = new Client();

  try {
    // Step 1: get ILOM IP locally — no SSH needed, we're already on the cmd host
    const eveOut = await localExec(`python3 /home/tester/WesleyH/eve_ip.pyc ${serialNumber}`);
    const ilomMatch = eveOut.match(/^ILOM\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3})\s+up/im);
    if (!ilomMatch) {
      return res.status(400).json({ error: `ILOM not found or not up: ${eveOut.trim()}` });
    }
    const ilomIp = ilomMatch[1];
    console.log('[diagnose] ILOM IP:', ilomIp);

    // Step 2: verify ILOM is reachable before attempting SSH
    await new Promise((resolve, reject) => {
      exec(`ping -c 1 -W 3 ${ilomIp}`, (error) => {
        if (error) reject(new Error(`ILOM at ${ilomIp} is not reachable`));
        else resolve();
      });
    });

    // Step 3: single SSH hop directly to the ILOM
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      conn.on('error', (e) => finish(reject, e));
      conn.on('ready', async () => {
        try {
          const ilomOut = await sshExec(conn, 'show /System/Open_Problems');
          finish(resolve, parseIlomProblems(ilomOut));
        } catch (e) { finish(reject, e); }
      });

      conn.connect({
        host: ilomIp,
        port: 22,
        username: process.env.ILOM_USER || 'root',
        password: process.env.ILOM_PASSWORD || 'change me',
        readyTimeout: 20000,
      });
    });

    res.json(result);
  } catch (err) {
    console.error('[diagnose]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { conn.end(); } catch {}
  }
});

export default router;
