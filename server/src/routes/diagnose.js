import express from 'express';
import { Client } from 'ssh2';

const router = express.Router({ mergeParams: true });

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

function parseIlomProblems(output) {
  const faults = {
    // Top-level chassis components: 'gbb' | 'gpu' | 'iob' | 'psu' | 'bmc' | 'rot'
    components: [],
    psuPorts: [],    // ['psu-port-N']
    retimerIds: [],  // ['retimer-N']
    e1sIds: [],      // ['e1s-a', 'e1s-b']
  };

  const compSet = new Set();
  const add = (list, set, id) => { if (!set.has(id)) { set.add(id); list.push(id); } };
  const addComp = (c) => add(faults.components, compSet, c);

  const psuSeen = new Set();
  const retimerSeen = new Set();
  const e1sSeen = new Set();

  let m;

  // PSU: /SYS/PS0 /SYS/PSU0 /SYS/PSU/0  (ILOM 0-indexed → UI 1-indexed)
  const psuRe = /\/SYS\/PSU?\/? *(\d+)/gi;
  while ((m = psuRe.exec(output)) !== null) {
    add(faults.psuPorts, psuSeen, `psu-port-${parseInt(m[1], 10) + 1}`);
    addComp('psu');
  }
  // Also plain "PSU" class in ILOM problem entries
  if (!compSet.has('psu') && /class\s*=\s*PSUMOD/i.test(output)) addComp('psu');

  // GPU Baseboard: /SYS/GPU /SYS/GPUBD /SYS/GPU_BASEBOARD
  if (/\/SYS\/GPU|GPU[\s_]?BASEBOARD|GPUBD/i.test(output)) addComp('gpu');

  // BMC: /SYS/BMC
  if (/\/SYS\/BMC\b/i.test(output)) addComp('bmc');

  // ROT: /SYS/ROT
  if (/\/SYS\/ROT\b/i.test(output)) addComp('rot');

  // Retimers: /SYS/RETIMER0  /SYS/IOB/RETIMER0  /SYS/MB/RETIMER0  GXR3V2_0
  const retimerRe = /\/SYS\/(?:\w+\/)*RETIMER\/? *(\d+)|GXR3V\w*?(\d+)/gi;
  while ((m = retimerRe.exec(output)) !== null) {
    const n = parseInt(m[1] ?? m[2], 10);
    if (!isNaN(n)) {
      add(faults.retimerIds, retimerSeen, `retimer-${n}`);
      addComp('iob');
    }
  }

  // E1S boards: /SYS/E1SA  /SYS/IOB/E1S_A  E1S_A
  if (/\/SYS\/[^/]*E1S[_\-.]?A\b|E1S[_\-.]?A/i.test(output)) {
    add(faults.e1sIds, e1sSeen, 'e1s-a');
    addComp('iob');
  }
  if (/\/SYS\/[^/]*E1S[_\-.]?B\b|E1S[_\-.]?B/i.test(output)) {
    add(faults.e1sIds, e1sSeen, 'e1s-b');
    addComp('iob');
  }

  // IOB Tray (generic, no specific sub-component matched)
  if (/\/SYS\/IOB\b|IOB[\s_]?TRAY/i.test(output)) addComp('iob');

  // GBB / OSFP / PCIe → GBB tray
  if (/\/SYS\/GBB|\/SYS\/OSFP|\/SYS\/(?:\w+\/)*PCIE|class\s*=\s*PCIE\b/i.test(output)) {
    addComp('gbb');
  }

  return { faults, raw: output };
}

router.get('/', async (req, res) => {
  const { serialNumber } = req.query;
  if (!serialNumber) {
    return res.status(400).json({ error: 'serialNumber query param required' });
  }

  const conn1 = new Client();
  const conn2 = new Client();

  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      conn1.on('error', (e) => finish(reject, e));
      conn2.on('error', (e) => finish(reject, e));

      conn1.on('ready', async () => {
        try {
          // Step 1: resolve ILOM IP from the cmd host
          const eveOut = await execCommand(conn1, `eve_ip ${serialNumber}`);
          const ipMatch = eveOut.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
          if (!ipMatch) {
            return finish(reject, new Error(`No IP in eve_ip output: ${eveOut.trim()}`));
          }
          const ilomIp = ipMatch[1];

          // Step 2: tunnel through cmd host → ILOM port 22
          conn1.forwardOut('127.0.0.1', 0, ilomIp, 22, (err, stream) => {
            if (err) return finish(reject, err);

            conn2.on('ready', async () => {
              try {
                const ilomOut = await execCommand(conn2, 'show /System/Open_Problems');
                finish(resolve, parseIlomProblems(ilomOut));
              } catch (e) { finish(reject, e); }
            });

            conn2.connect({
              sock: stream,
              username: process.env.ILOM_USER || 'root',
              password: process.env.ILOM_PASSWORD || 'change me',
              readyTimeout: 20000,
            });
          });
        } catch (e) { finish(reject, e); }
      });

      conn1.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
        finish(prompts.map(() => process.env.CMD_HOST_PASSWORD));
      });

      conn1.connect({
        host: process.env.CMD_HOST,
        port: 22,
        username: process.env.CMD_HOST_USER,
        password: process.env.CMD_HOST_PASSWORD,
        tryKeyboard: true,
        readyTimeout: 20000,
      });
    });

    res.json(result);
  } catch (err) {
    console.error('[diagnose]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { conn2.end(); } catch {}
    try { conn1.end(); } catch {}
  }
});

export default router;
