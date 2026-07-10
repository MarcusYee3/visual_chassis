import express from 'express';
import { exec, spawn } from 'child_process';

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

// Delivering multiple chained commands to the ILOM CLI in one instant burst (via a heredoc
// or a printf pipe) was observed on real hardware to drop/duplicate lines — likely because
// those earlier attempts ran without a pseudo-terminal (confirmed by the SSH warning
// "Pseudo-terminal will not be allocated because stdin is not a terminal" in that output),
// and this ILOM's CLI behaves unreliably without one, unlike an interactive/manual session.
// -tt forces PTY allocation. Commands are written one at a time with a pause afterward as
// defense in depth, giving the remote CLI time to settle between state transitions — and
// critically, the first command is only sent after an upfront delay for the connection/auth
// handshake and login banner to finish (writing immediately after spawn() was observed to
// hang the entire session, even for a single unchained command).
function runIlomSession(commands, ilomIp, ilomUser, ilomPassword, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(SSHPASS, [
      '-e', 'ssh',
      '-tt',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-o', 'PreferredAuthentications=keyboard-interactive',
      `${ilomUser}@${ilomIp}`,
    ], { env: { ...process.env, SSHPASS: ilomPassword } });

    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    // The last command is always "exit", which makes the child process close its own end of
    // the pipe before our write loop necessarily finishes waiting out its final delay —
    // without this handler, that write-after-close raises an uncaught EPIPE.
    child.stdin.on('error', () => {});

    const timer = setTimeout(() => {
      child.kill();
      const partial = output.trim();
      reject(new Error(
        `ILOM session timed out after ${timeoutMs}ms` +
        (partial ? ` — partial output before kill:\n${partial}` : ' — no output captured before kill')
      ));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(output);
    });

    (async () => {
      // Wait for the connection/auth handshake and the ILOM's multi-line login banner
      // (copyright notice, warnings, hostname line) to finish before writing the first
      // command — writing immediately after spawn() was observed to hang the whole session,
      // the command apparently lands before the remote shell is ready to receive it.
      await new Promise((r) => setTimeout(r, 4000));
      for (const { line, delayAfterMs } of commands) {
        child.stdin.write(`${line}\n`);
        await new Promise((r) => setTimeout(r, delayAfterMs));
      }
      child.stdin.end();
      // The trailing "exit" line(s) above are supposed to make this restricted ILOM CLI log
      // out and close the connection on its own — but on real hardware that was observed to
      // not happen even at the plain top-level "->" prompt (no nested shell to leave), leaving
      // the process running until the full timeoutMs killed it as a hard failure even though
      // every command had already succeeded and its output was already captured. Since we've
      // written every command and waited out its delay by this point, there's nothing left to
      // gain from keeping the connection open — give it a short grace window to close itself,
      // then force it and let the existing close handler resolve with what we captured.
      await new Promise((r) => setTimeout(r, 2000));
      if (!child.killed) child.kill();
    })();
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
    genericErrors: [],
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
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [] };
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

// hwdiag temp get all prints one line per sensor, e.g.:
//   /SYS/MB/T_IN_ZONE0               : 29.50 deg C
//   /SYS/PS1/T_OUT                   : 0.00 deg C
//   /SYS/MB/P0_DTS                   : 56.00 margin
// Only "deg C" readings are temperatures ("margin" is a different unit, not in scope here).
// A reading of exactly 0.00 deg C is a dead/unreadable sensor. If it's a PSU
// (/SYS/PS<n>/...), route it through the existing PSU highlighting; anything else becomes a
// generic error message with no specific chassis component to highlight.
function parseHwdiagTempGetAll(output) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [] };
  const compSet = new Set();
  const addComp = (c) => { if (!compSet.has(c)) { compSet.add(c); faults.components.push(c); } };
  const psuSeen = new Set();

  const re = /^\s*(\S+)\s*:\s*([\d.]+)\s*deg C\s*$/gim;
  let m;
  while ((m = re.exec(output)) !== null) {
    const [, device, valueStr] = m;
    if (parseFloat(valueStr) !== 0) continue;
    const psuMatch = device.match(/\/SYS\/PS(\d+)\b/i);
    if (psuMatch) {
      const id = `psu-port-${parseInt(psuMatch[1], 10) + 1}`;
      if (!psuSeen.has(id)) { psuSeen.add(id); faults.psuPorts.push(id); }
      addComp('psu');
    } else {
      faults.genericErrors.push(`${device} reporting 0.00°C`);
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

    // Step 2: SSH to ILOM using native ssh + sshpass. Passing the command as an ssh remote-
    // command *argument* (`ssh ... 'show /System/Open_Problems'`) was observed to hang
    // indefinitely on some devices even with -tt forcing a pty — this ILOM's restricted CLI
    // apparently doesn't reliably support that invocation mode. A manual/interactive session
    // (connect, then type the command) works fine, so run it the same way: open a bare
    // session and write the command to stdin via runIlomSession, matching tier 2/3. A
    // trailing "exit" is required too — closing stdin (EOF) alone does not make this CLI log
    // out and close the connection, it just sits at the prompt until the timeout kills it,
    // even when the actual command already succeeded and returned a complete result.
    const ilomUser = process.env.ILOM_USER || 'root';
    const ilomPassword = process.env.ILOM_PASSWORD || 'changeme';

    const ilomOut = await runIlomSession(
      [
        { line: 'show /System/Open_Problems', delayAfterMs: 5000 },
        { line: 'exit', delayAfterMs: 1500 },
      ],
      ilomIp, ilomUser, ilomPassword, 30000
    );
    console.log('[diagnose] ILOM raw output:\n', ilomOut);
    let parsed = parseIlomProblems(ilomOut);
    console.log('[diagnose] parsed faults:', JSON.stringify(parsed.faults));

    // Step 3: fall back to the fault management shell, then the diag shell's hwdiag fan and
    // temp scans, when open problems reports nothing. "exit" is required to leave the fault
    // mgmt shell before the diag shell can be entered in the same session. Commands are
    // written one at a time to a live session with a pause after each — delivering them all
    // at once (heredoc or printf pipe) was observed on real hardware to drop/duplicate lines.
    if (parsed.faults.components.length === 0) {
      console.log('[diagnose] no open problems reported, falling back to fmadm faulty -a / hwdiag fan info / hwdiag temp get all');

      // fmadm and hwdiag are run as two separate sessions (rather than one combined session/
      // buffer) so each output is parsed in isolation. parseIlomProblems's "/SYS/PS<n>" regex
      // matches any mention of a PSU resource, not just faulted ones — running it against a
      // buffer that also contains the hwdiag temp/fan dumps previously caused every PSU listed
      // in "hwdiag temp get all" (regardless of its actual reading) to be misreported as
      // faulted, instead of only the ones genuinely at 0.00 deg C.
      // Splitting into two sessions means paying the connection handshake + login banner wait
      // twice, and on real hardware "fmadm faulty -a" itself was observed to still be printing
      // past the 5s delay that was enough when it was one leg of a single 55s-budget session —
      // give this session its own longer delay and timeout rather than reusing the old budget.
      const fmadmOut = await runIlomSession([
        { line: 'start -script /SP/faultmgmt/shell', delayAfterMs: 2000 },
        { line: 'fmadm faulty -a', delayAfterMs: 10000 },
        { line: 'exit', delayAfterMs: 1500 },
      ], ilomIp, ilomUser, ilomPassword, 45000);
      console.log('[diagnose] fmadm raw output:\n', fmadmOut);

      const fmadmParsed = parseIlomProblems(fmadmOut);
      console.log('[diagnose] fmadm parsed faults:', JSON.stringify(fmadmParsed.faults));

      if (fmadmParsed.faults.components.length > 0) {
        parsed = { faults: fmadmParsed.faults, raw: `${ilomOut}\n${fmadmOut}` };
      } else {
        const hwdiagOut = await runIlomSession([
          { line: 'start -script /SP/diag/shell', delayAfterMs: 2000 },
          { line: 'hwdiag fan info', delayAfterMs: 5000 },
          { line: 'hwdiag temp get all', delayAfterMs: 5000 },
          { line: 'exit', delayAfterMs: 1500 }, // leave the diag shell, back to top-level "->"
          { line: 'exit', delayAfterMs: 1500 }, // log out of the top-level session
        ], ilomIp, ilomUser, ilomPassword, 45000);
        console.log('[diagnose] hwdiag raw output:\n', hwdiagOut);

        console.log('[diagnose] fmadm found nothing, scanning hwdiag fan info for non-Present fans/PSUs');
        const fanParsed = parseHwdiagFanInfo(hwdiagOut);
        console.log('[diagnose] hwdiag fan parsed faults:', JSON.stringify(fanParsed.faults));

        if (fanParsed.faults.components.length > 0) {
          parsed = { faults: fanParsed.faults, raw: `${ilomOut}\n${fmadmOut}\n${hwdiagOut}` };
        } else {
          console.log('[diagnose] hwdiag fan info found nothing, scanning hwdiag temp get all for 0.00 deg C sensors');
          const tempParsed = parseHwdiagTempGetAll(hwdiagOut);
          console.log('[diagnose] hwdiag temp parsed faults:', JSON.stringify(tempParsed.faults));
          parsed = { faults: tempParsed.faults, raw: `${ilomOut}\n${fmadmOut}\n${hwdiagOut}` };
        }
      }
    }

    res.json(parsed);
  } catch (err) {
    console.error('[diagnose]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
