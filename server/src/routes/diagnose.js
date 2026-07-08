import express from 'express';
import { exec } from 'child_process';

const router = express.Router({ mergeParams: true });

const SSHPASS = '/home/tester/.local/bin/sshpass';

function localExec(command, timeoutMs = 15000, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs, env: { ...process.env, ...extraEnv } }, (error, stdout, stderr) => {
      if (error?.killed) return reject(new Error(`Command timed out: ${command}`));
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
    pcieFaults: [], // [{ resource, iou, pcie, probability }]
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

  if (/\/SYS\/GPU|GPU[\s_]?BASEBOARD|GPUBD|number of GPU|GPU.*not present/i.test(output)) addComp('gpu');
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
  if (/\/SYS\/GBB|\/SYS\/OSFP|class\s*=\s*PCIE\b/i.test(output)) addComp('gbb');

  // PCIe faults — two possible shapes depending on which ILOM command produced the output:
  //  (1) show /System/Open_Problems: inline "(Probability:N, UUID:x, Resource:y, ...)" per problem
  //  (2) fmadm faulty -a: one "Suspect N of M" block per fault, with Certainty + Resource/Location
  const iouPcieRe = /\/SYS\/IOU(\d+)\/PCIE(\d+)/i;
  const pcieSeen = new Set();
  const addPcieFault = (resource, probability) => {
    const pciePathMatch = resource.match(iouPcieRe);
    if (!pciePathMatch) return;
    if (pcieSeen.has(resource)) return;
    pcieSeen.add(resource);
    faults.pcieFaults.push({
      resource,
      iou: parseInt(pciePathMatch[1], 10),
      pcie: parseInt(pciePathMatch[2], 10),
      probability,
    });
    addComp('gbb');
  };

  const faultBlockRe = /\(Probability:(\d+),\s*UUID:[^,]+,\s*Resource:([^\s,)]+)/g;
  while ((m = faultBlockRe.exec(output)) !== null) {
    addPcieFault(m[2], parseInt(m[1], 10));
  }

  const suspectBlocks = output.split(/(?=Suspect \d+ of \d+)/i);
  for (const block of suspectBlocks) {
    const certaintyMatch = block.match(/Certainty\s*:\s*(\d+)%/i);
    const resourceMatch = block.match(/Resource\s*\r?\n\s*Location\s*:\s*(\S+)/i);
    if (!resourceMatch) continue;
    addPcieFault(resourceMatch[1], certaintyMatch ? parseInt(certaintyMatch[1], 10) : null);
  }

  return { faults, raw: output };
}

router.get('/', async (req, res) => {
  const { serialNumber, ilomIp: ilomIpParam } = req.query;
  if (!serialNumber) return res.status(400).json({ error: 'serialNumber query param required' });

  if (!/^[a-zA-Z0-9]+$/.test(serialNumber)) {
    return res.status(400).json({ error: 'Invalid serial number format' });
  }

  try {
    // Step 1: use ILOM IP from validation if provided, otherwise run eve_ip
    let ilomIp = ilomIpParam;
    if (!ilomIp) {
      const eveOut = await localExec(`python3 /home/tester/WesleyH/eve_ip.pyc ${serialNumber}`);
      const ilomMatch = eveOut.match(/^ILOM\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3})\s+up/im);
      if (!ilomMatch) {
        return res.status(400).json({ error: `ILOM not found or not up: ${eveOut.trim()}` });
      }
      ilomIp = ilomMatch[1];
    }
    console.log('[diagnose] ILOM IP:', ilomIp);

    // Step 2: SSH to ILOM using native ssh + sshpass
    const ilomUser = process.env.ILOM_USER || 'root';
    const ilomPassword = process.env.ILOM_PASSWORD || 'changeme';
    const sshBase = `${SSHPASS} -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o PreferredAuthentications=keyboard-interactive ${ilomUser}@${ilomIp}`;

    const ilomOut = await localExec(`${sshBase} 'show /System/Open_Problems'`, 20000, { SSHPASS: ilomPassword });
    console.log('[diagnose] ILOM raw output:\n', ilomOut);
    let parsed = parseIlomProblems(ilomOut);
    console.log('[diagnose] parsed faults:', JSON.stringify(parsed.faults));

    // Step 3: fall back to the fault management shell when open problems reports nothing.
    // The two commands must be sent as piped stdin to a plain (no remote-command-argument)
    // ssh session — passing them as a single quoted multi-line ssh argument does not work,
    // ILOM's CLI does not treat the embedded newline as a line break in that mode.
    if (parsed.faults.components.length === 0) {
      console.log('[diagnose] no open problems reported, falling back to fmadm faulty -a');
      const fmadmOut = await localExec(
        `printf 'start -script /SP/faultmgmt/shell\\nfmadm faulty -a\\n' | ${sshBase}`,
        20000,
        { SSHPASS: ilomPassword }
      );
      console.log('[diagnose] fmadm raw output:\n', fmadmOut);
      const fmadmParsed = parseIlomProblems(fmadmOut);
      console.log('[diagnose] fmadm parsed faults:', JSON.stringify(fmadmParsed.faults));
      parsed = { faults: fmadmParsed.faults, raw: `${ilomOut}\n${fmadmOut}` };
    }

    res.json(parsed);
  } catch (err) {
    console.error('[diagnose]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
