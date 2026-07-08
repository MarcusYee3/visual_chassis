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
    fanIds: [],
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

// hwdiag fan info prints one line per fan ("FM<n>") and PSU ("PS<n>"), e.g.:
//   FM1    -  Present
//   FM21   - Not Readable
//   PS1    -  Present
// Anything whose status isn't "Present" is treated as a fault.
function parseHwdiagFanInfo(output) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [] };
  const compSet = new Set();
  const addComp = (c) => { if (!compSet.has(c)) { compSet.add(c); faults.components.push(c); } };
  const fanSeen = new Set();
  const psuSeen = new Set();

  const re = /^\s*(FM|PS)(\d+)\s*-\s*(.+?)\s*$/gim;
  let m;
  while ((m = re.exec(output)) !== null) {
    const [, kind, numStr, status] = m;
    if (/present/i.test(status)) continue;
    const n = parseInt(numStr, 10);
    if (kind === 'FM') {
      if (!fanSeen.has(n)) { fanSeen.add(n); faults.fanIds.push(n); }
      addComp('gpu');
    } else {
      const id = `psu-port-${n}`;
      if (!psuSeen.has(id)) { psuSeen.add(id); faults.psuPorts.push(id); }
      addComp('psu');
    }
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

    // Step 3: fall back to the fault management shell, then the diag shell's hwdiag fan
    // scan, when open problems reports nothing. All commands are sent as piped stdin to a
    // single plain (no remote-command-argument) ssh session via a heredoc — passing them as
    // a quoted multi-line ssh argument does not work (ILOM's CLI doesn't treat an embedded
    // newline as a line break there), and a printf-with-\n-escapes pipe was observed to
    // garble/duplicate lines on real hardware. A quoted heredoc needs no escape interpretation
    // at all, avoiding both failure modes. "exit" is required to leave the fault mgmt shell
    // before the diag shell can be entered in the same session.
    if (parsed.faults.components.length === 0) {
      console.log('[diagnose] no open problems reported, falling back to fmadm faulty -a / hwdiag fan info');
      const deepOut = await localExec(
        `${sshBase} <<'EOF'\nstart -script /SP/faultmgmt/shell\nfmadm faulty -a\nexit\nstart -script /SP/diag/shell\nhwdiag fan info\nEOF`,
        20000,
        { SSHPASS: ilomPassword }
      );
      console.log('[diagnose] deep diagnostic raw output:\n', deepOut);

      const fmadmParsed = parseIlomProblems(deepOut);
      console.log('[diagnose] fmadm parsed faults:', JSON.stringify(fmadmParsed.faults));

      if (fmadmParsed.faults.components.length > 0) {
        parsed = { faults: fmadmParsed.faults, raw: `${ilomOut}\n${deepOut}` };
      } else {
        console.log('[diagnose] fmadm found nothing, scanning hwdiag fan info for non-Present fans/PSUs');
        const fanParsed = parseHwdiagFanInfo(deepOut);
        console.log('[diagnose] hwdiag parsed faults:', JSON.stringify(fanParsed.faults));
        parsed = { faults: fanParsed.faults, raw: `${ilomOut}\n${deepOut}` };
      }
    }

    res.json(parsed);
  } catch (err) {
    console.error('[diagnose]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
