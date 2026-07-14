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
    cableFaults: [],
  };

  const compSet = new Set();
  const add = (list, set, id) => { if (!set.has(id)) { set.add(id); list.push(id); } };
  const addComp = (c) => add(faults.components, compSet, c);

  const psuSeen = new Set();
  const retimerSeen = new Set();
  const e1sSeen = new Set();
  const fanSeen = new Set();

  let m;

  const psuRe = /\/SYS\/PSU?\/? *(\d+)/gi;
  while ((m = psuRe.exec(output)) !== null) {
    add(faults.psuPorts, psuSeen, `psu-port-${parseInt(m[1], 10) + 1}`);
    addComp('psu');
  }
  if (!compSet.has('psu') && /class\s*=\s*PSUMOD/i.test(output)) addComp('psu');

  // Fan faults — "hwdiag fan info" only reports physical presence ("Present"), not health, so a
  // fan can be present yet faulty (rotating too slowly, etc.). The real fault shows up as a
  // Suspect block (fmadm faulty -a) or an Open_Problems entry naming a specific fan module, e.g.
  // "Affects: /SYS/FANB1/FM3" / "Resource Location: /SYS/FANB1/FM3/F1" — extract the FM number
  // from either shape.
  const fanRe = /\/SYS\/FANB?\d*\/FM(\d+)/gi;
  while ((m = fanRe.exec(output)) !== null) {
    const n = parseInt(m[1], 10);
    add(faults.fanIds, fanSeen, n);
    addComp('gpu');
  }
  // A fan-class problem can also be reported without naming one specific FM (e.g.
  // "alert.chassis.config.fan.capacity-deficient" affecting "/SYS" as a whole, from multiple fan
  // failures/missing fans) — surface that too instead of silently dropping it just because no
  // single fan number could be extracted.
  if (fanSeen.size === 0 && /fault\.chassis\.device\.fan|alert\.chassis\.config\.fan|fan (?:module|capacity)/i.test(output)) {
    faults.genericErrors.push('Fan-related problem reported (insufficient cooling capacity or multiple fan issues) — see raw output for detail');
    addComp('gpu');
  }

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
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [] };
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
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [] };
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

// hwdiag system fabric test all prints, per PCIe switch, one PASSED/FAILED line per link
// (Retimer/GPU/SSD), e.g.:
//   SWITCH: PCIE_SW1
//       PCIE_SW1 Retimer1    x16 @ 32.0GT/s       : PASSED
//       PCIE_SW1 GPU4        x16 @ 32.0GT/s       : PASSED
//       PCIE_SW1 SSD1        x4  @ 32.0GT/s       : PASSED
// On real hardware, a genuinely bad head node connection makes *every* link on *every* switch
// report FAILED — that's not N isolated bad parts, it's a systemic problem, so instead of
// highlighting every retimer/GPU/SSD individually (noisy and actively misleading about what's
// actually wrong), the whole chassis is flagged and a head node reseat is called for. A partial
// failure (some links down, most passing) is treated normally, but this command's "RetimerN" is
// a switch-relative index (1-8) with no fixed correspondence to a real IOU number — confirmed
// there isn't one — so a failed retimer here is reported generically rather than attributed to a
// specific retimer-<iou> id; cross-check with the UPDATE_GXR3_FW targeted check (which reports by
// real IOU number) to find the actual card. GPU/SSD links don't have a dedicated chassis element
// yet either, so they're also called out by number in a generic error.
function parseHwdiagFabricTestAll(output) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [] };
  const compSet = new Set();
  const addComp = (c) => { if (!compSet.has(c)) { compSet.add(c); faults.components.push(c); } };
  const failedRetimers = new Set();
  const failedGpus = new Set();
  const failedSsds = new Set();

  const lineRe = /PCIE_SW(\d+)\s+(Retimer|GPU|SSD)(\d+)\s+.*?:\s*(PASSED|FAILED)\s*$/gim;
  let m;
  let total = 0;
  let failedCount = 0;
  while ((m = lineRe.exec(output)) !== null) {
    total++;
    const [, , partType, partNumStr, status] = m;
    if (status.toUpperCase() !== 'FAILED') continue;
    failedCount++;
    const n = parseInt(partNumStr, 10);
    if (partType === 'Retimer') {
      failedRetimers.add(n);
      addComp('iob');
    } else if (partType === 'GPU') {
      failedGpus.add(n);
      addComp('gpu');
    } else if (partType === 'SSD') {
      failedSsds.add(n);
      addComp('iob');
    }
  }

  if (total > 0 && failedCount === total) {
    faults.components = ['gbb', 'gpu', 'iob', 'psu', 'bmc', 'rot'];
    faults.genericErrors.push(
      `hwdiag system fabric test all: ALL ${total} fabric links failed (0/${total} passed) — this ` +
      `indicates a head node connectivity issue, not isolated component failures. Reseat the head node and retest.`
    );
    return { faults, raw: output };
  }

  if (failedRetimers.size > 0) {
    faults.genericErrors.push(`hwdiag system fabric test all: Retimer(s) failed (switch-relative numbering, not IOU-mapped): ${[...failedRetimers].sort((a, b) => a - b).join(', ')} — cross-check with the UPDATE_GXR3_FW check for the actual IOU`);
  }
  if (failedGpus.size > 0) {
    faults.genericErrors.push(`hwdiag system fabric test all: GPU link(s) failed: ${[...failedGpus].sort((a, b) => a - b).join(', ')}`);
  }
  if (failedSsds.size > 0) {
    faults.genericErrors.push(`hwdiag system fabric test all: SSD link(s) failed: ${[...failedSsds].sort((a, b) => a - b).join(', ')}`);
  }

  return { faults, raw: output };
}

// lionking_OSFP.py <SN> is the targeted check for a VERIFY_OSFP_LINKS failure — it checks IB/
// OSFP loopback link status for a JBOG and, on a failure, prints one line per down interface,
// e.g.:
//   ❌ Missing / Down Links:
//   mlx5_10  | 0000:46:00.0    | SLOT 1
//   mlx5_11  | 0000:46:00.1    | SLOT 1
// Each numbered SLOT (1-8) is one end of a physical loopback cable pairing two IOU ports; slots
// pair up (1-2, 3-4, 5-6, 7-8) into the 4 cables spanning the 2 OSFP boards, left to right:
//   slot 1-2 = IOU 6<->IOU 1     slot 3-4 = IOU 7<->IOU 2
//   slot 5-6 = IOU 9<->IOU 4     slot 7-8 = IOU 10<->IOU 5
// matching the port order already in serverData.js's osfpModules. A down slot means that whole
// cable is reported faulted (a disconnected loopback typically drops both ends together).
const OSFP_SLOT_TO_IOU = { 1: 6, 2: 1, 3: 7, 4: 2, 5: 9, 6: 4, 7: 10, 8: 5 };
const OSFP_CABLE_SLOT_PAIRS = [[1, 2], [3, 4], [5, 6], [7, 8]];

function parseLionkingOSFPOutput(output) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [] };

  if (!/Missing \/ Down Links/i.test(output) && /error|traceback|exception/i.test(output)) {
    faults.genericErrors.push(`lionking_OSFP.py did not complete normally: ${output.trim().slice(-500)}`);
    return { faults, raw: output };
  }

  const downSlots = new Set();
  const lineRe = /^\s*(\S+)\s*\|\s*(\S+)\s*\|\s*SLOT\s*(\d+)\s*$/gim;
  let m;
  while ((m = lineRe.exec(output)) !== null) downSlots.add(parseInt(m[3], 10));

  const cableSeen = new Set();
  for (const [slotA, slotB] of OSFP_CABLE_SLOT_PAIRS) {
    if (!downSlots.has(slotA) && !downSlots.has(slotB)) continue;
    const id = `cable-${OSFP_SLOT_TO_IOU[slotA]}-${OSFP_SLOT_TO_IOU[slotB]}`;
    if (!cableSeen.has(id)) { cableSeen.add(id); faults.cableFaults.push(id); }
  }
  if (faults.cableFaults.length > 0) faults.components.push('gbb');

  return { faults, raw: output };
}

async function runLionkingOSFPCheck(serialNumber) {
  console.log(`[diagnose] running: /home/tester/lionking_OSFP.py ${serialNumber}`);
  const output = await localExec(`/home/tester/lionking_OSFP.py ${serialNumber}`, 30000);
  console.log('[diagnose] lionking_OSFP.py raw output:\n', output);
  const result = parseLionkingOSFPOutput(output);
  console.log('[diagnose] lionking_OSFP.py parsed faults:', JSON.stringify(result.faults));
  return result;
}

// gxr3_fw_update_check is the targeted check for an UPDATE_GXR3_FW failure. It's interactive
// (prompts "Please enter server SN:" on stdin rather than taking the SN as an argument like
// lionking_OSFP.py), so the SN is piped in. It prints one line per IOU GXR3 retimer card, e.g.:
//   IOU1 GXR3 card FW update Good
//   IOU9 GXR3 card FW update failed
// This reports directly by real IOU number (1,2,4,5,6,7,9,10 — the same 8 IOUs the OSFP boards
// use), which is what the retimer UI is keyed by (retimer-<iou>) — unlike "hwdiag system fabric
// test all"'s switch-relative RetimerN, there's no ambiguity here about which physical card failed.
function parseGxr3FwUpdateCheck(output) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [] };
  const compSet = new Set();
  const addComp = (c) => { if (!compSet.has(c)) { compSet.add(c); faults.components.push(c); } };
  const retimerSeen = new Set();

  const re = /IOU(\d+)\s+GXR3\s+card\s+FW\s+update\s+(\S+)/gi;
  let m;
  let total = 0;
  while ((m = re.exec(output)) !== null) {
    total++;
    const [, iouStr, status] = m;
    if (/^good$/i.test(status)) continue;
    const id = `retimer-${parseInt(iouStr, 10)}`;
    if (!retimerSeen.has(id)) { retimerSeen.add(id); faults.retimerIds.push(id); }
    addComp('iob');
  }

  if (total === 0) {
    faults.genericErrors.push(`gxr3_fw_update_check did not report any IOU GXR3 results: ${output.trim().slice(-500)}`);
  }

  return { faults, raw: output };
}

// "gxr3_fw_update_check" is a shell alias (not a real path) for /home/tester/WesleyH/GXR3_update_check
// -- same directory as eve_ip.pyc, not lionking_OSFP.py.
const GXR3_UPDATE_CHECK_PATH = '/home/tester/WesleyH/GXR3_update_check';

async function runGxr3FwUpdateCheck(serialNumber) {
  console.log(`[diagnose] running: echo ${serialNumber} | ${GXR3_UPDATE_CHECK_PATH}`);
  const output = await localExec(`echo ${serialNumber} | ${GXR3_UPDATE_CHECK_PATH}`, 30000);
  console.log('[diagnose] gxr3_fw_update_check raw output:\n', output);
  const result = parseGxr3FwUpdateCheck(output);
  console.log('[diagnose] gxr3_fw_update_check parsed faults:', JSON.stringify(result.faults));
  return result;
}

// Maps a mfg-collector checkName to its targeted diagnostic flow. Add an entry here per check as
// its specific command/script and output format are known, instead of falling back to the
// generic "not ILOM-observable" message below.
const MFG_COLLECTOR_TARGETED_CHECKS = {
  VERIFY_OSFP_LINKS: runLionkingOSFPCheck,
  UPDATE_GXR3_FW: runGxr3FwUpdateCheck,
};

// mfg-collector.hyvesolutions.org/out/out.evelionking_all.php publishes a live table of every
// EVE LionKing GPU_JBOG_TEST run: JBOG_NUM, TailNode_SN, HeadNode_SN, Started, Status. A
// failing row's Status cell looks like "X11-2C.B300H – HOST_POWER_ON_PRETEST : 5_CHECK_NVME_PRESENCE 00:40"
// (board – stage : numbered check, duration); a passing row is "X11-2C.B300H – : 00:25" (empty
// stage); a still-running row can be just a bare duration with no board/stage at all. This is
// checked before opening any ILOM SSH session, since most of these checks (NVMe presence, OSFP
// links, CDFP connection, firmware update, partner diagnostics) aren't things the ILOM fault/
// hwdiag chain below can see — there's nothing to gain from paying the SSH round-trip cost for
// those. Only CHECK_ILOM_FAULTS and CHECK_PSU_PRESENCE overlap with what the chain below
// actually inspects, so those still fall through to the normal ILOM session flow.
//
// Measured against the real endpoint: the data page is ~600KB and takes ~45s to fully download
// (confirmed with both curl and Node's fetch — this is the server being slow to render/flush
// ~2200 rows, not a client bug). That's as long as the ILOM SSH chain this is meant to save time
// on, so fetching it synchronously per diagnose request would often make things slower, not
// faster. Instead, a background poller fetches+parses the whole table into an in-memory
// SN -> status cache on an interval, and each /diagnose request just does an instant in-memory
// lookup against whatever the cache currently holds.
const MFG_COLLECTOR_BASE = 'https://mfg-collector.hyvesolutions.org';
const MFG_COLLECTOR_LOGIN_PAGE = `${MFG_COLLECTOR_BASE}/out/out.login.php`;
const MFG_COLLECTOR_LOGIN_URL = `${MFG_COLLECTOR_BASE}/op/op.loginA.php`;
const MFG_COLLECTOR_DATA_URL = `${MFG_COLLECTOR_BASE}/out/out.evelionking_all.php`;
const MFG_COLLECTOR_POLL_INTERVAL_MS = 5 * 60 * 1000;
const ILOM_OBSERVABLE_CHECKS = /CHECK_ILOM_FAULTS|CHECK_PSU_PRESENCE/i;

let mfgCollectorCache = new Map(); // SN (uppercase) -> status object
let mfgCollectorCacheUpdatedAt = null;
let mfgCollectorRefreshInFlight = false;

// Requesting the data page with no session redirects (out.php -> op.logout.php -> out.login.php)
// to a plain PHP form-login page (userid/passwd POSTed to op.loginA.php, no CSRF token) — this
// was discovered the hard way: fetch() follows redirects by default, so the "logged out" case
// looked identical to "SN not in the table" (both a valid 200 response, just of the wrong page)
// until the raw HTTP trace was inspected. Log in fresh for each poll using a service account
// (MFG_COLLECTOR_USER/MFG_COLLECTOR_PASSWORD) and carry the resulting PHPSESSID cookie.
function extractSessionCookie(res) {
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const sessionCookie = cookies.find((c) => c.startsWith('PHPSESSID='));
  return sessionCookie ? sessionCookie.split(';')[0] : null;
}

async function mfgCollectorLogin() {
  const user = process.env.MFG_COLLECTOR_USER;
  const password = process.env.MFG_COLLECTOR_PASSWORD;
  if (!user || !password) throw new Error('MFG_COLLECTOR_USER/MFG_COLLECTOR_PASSWORD not set');

  // PHP issues a fresh anonymous PHPSESSID per unauthenticated request unless one is echoed
  // back, so grab that first, the same way a browser would before submitting the login form.
  const loginPageRes = await fetch(MFG_COLLECTOR_LOGIN_PAGE, { signal: AbortSignal.timeout(10000) });
  const anonCookie = extractSessionCookie(loginPageRes);

  const loginRes = await fetch(MFG_COLLECTOR_LOGIN_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(anonCookie ? { Cookie: anonCookie } : {}),
    },
    body: new URLSearchParams({ userid: user, passwd: password }),
    signal: AbortSignal.timeout(10000),
  });

  const cookie = extractSessionCookie(loginRes) || anonCookie;
  if (!cookie) throw new Error('mfg-collector login did not return a session cookie');
  return cookie;
}

// Parses every row into a Map keyed by both TailNode_SN and HeadNode_SN (uppercased) — a JBOG
// entry pairs two physical servers under one shared test status, so either SN should resolve it.
function parseMfgCollectorTable(html) {
  const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  const table = new Map();
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells = [];
    let cellMatch;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) cells.push(stripTags(cellMatch[1]));
    if (cells.length < 5) continue; // header row or a row that isn't shaped like a JBOG entry

    const [, tailSn, headSn, started, status] = cells;
    const failMatch = status.match(/^(.*?)[–-]\s*([A-Z0-9_]*)\s*:\s*(\d+)_([A-Z0-9_]+)\s+([\d:]+)\s*$/);
    const entry = failMatch
      ? (() => {
          const [, board, stage, checkNumber, checkName, duration] = failMatch;
          return {
            found: true, failing: true, tailSn, headSn, started,
            board: board.trim(), stage, checkNumber, checkName, duration,
            ilomObservable: ILOM_OBSERVABLE_CHECKS.test(checkName),
            raw: status,
          };
        })()
      : { found: true, failing: false, tailSn, headSn, started, raw: status };

    if (tailSn) table.set(tailSn.toUpperCase(), entry);
    if (headSn) table.set(headSn.toUpperCase(), entry);
  }
  return table;
}

async function refreshMfgCollectorCache() {
  if (mfgCollectorRefreshInFlight) return;
  mfgCollectorRefreshInFlight = true;
  try {
    const cookie = await mfgCollectorLogin();
    const res = await fetch(MFG_COLLECTOR_DATA_URL, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(90000) });
    if (!res.ok) throw new Error(`mfg-collector returned HTTP ${res.status}`);
    const html = await res.text();
    if (/name=['"]userid['"]/i.test(html)) {
      throw new Error('mfg-collector session invalid — got the login page back instead of the data table');
    }
    mfgCollectorCache = parseMfgCollectorTable(html);
    mfgCollectorCacheUpdatedAt = new Date();
    console.log(`[diagnose] mfg-collector cache refreshed: ${mfgCollectorCache.size} SNs, at ${mfgCollectorCacheUpdatedAt.toISOString()}`);
  } catch (err) {
    console.warn('[diagnose] mfg-collector cache refresh failed, keeping previous cache:', err.message);
  } finally {
    mfgCollectorRefreshInFlight = false;
  }
}

// Fire the first poll on module load (fire-and-forget — the server starts accepting requests
// immediately; until the first refresh lands, lookups just miss and fall through to the normal
// ILOM chain, same as if this feature didn't exist), then keep refreshing on an interval.
refreshMfgCollectorCache();
setInterval(refreshMfgCollectorCache, MFG_COLLECTOR_POLL_INTERVAL_MS);

router.get('/', async (req, res) => {
  const { serialNumber, ilomIp: ilomIpParam, skipCollector, forceCheck } = req.query;
  if (!serialNumber) return res.status(400).json({ error: 'serialNumber query param required' });

  if (!/^[a-zA-Z0-9]+$/.test(serialNumber)) {
    return res.status(400).json({ error: 'Invalid serial number format' });
  }

  try {
    // ?forceCheck=<checkName> runs a specific targeted check directly, regardless of what the
    // mfg-collector cache currently says (or whether the SN is in it at all) — the cache is a
    // live, rolling view, so a SN you know is actually affected by a given check may have already
    // aged out of it by the time you test through the app. Takes full precedence over everything
    // else below, including skipCollector.
    if (forceCheck) {
      const targetedCheck = MFG_COLLECTOR_TARGETED_CHECKS[forceCheck];
      if (!targetedCheck) {
        return res.status(400).json({ error: `No targeted check mapped for "${forceCheck}". Known checks: ${Object.keys(MFG_COLLECTOR_TARGETED_CHECKS).join(', ')}` });
      }
      console.log(`[diagnose] forceCheck=${forceCheck} set, running its targeted check directly for ${serialNumber}, bypassing mfg-collector entirely`);
      const { faults, raw } = await targetedCheck(serialNumber);
      return res.json({ faults, raw, source: `forced -> ${forceCheck}` });
    }

    // Step 0: check the mfg-collector cache (populated by the background poller above, not
    // fetched live — the real page takes ~45s, too slow to pay per-request) before opening any
    // ILOM SSH session. If it already knows this SN is failing a check the ILOM chain below
    // can't see, report that directly instead of paying for a full SSH round-trip that won't
    // find anything. A cache miss (not yet polled, or genuinely not in the table) just falls
    // through to the normal flow below, same as if this feature didn't exist. ?skipCollector=1
    // forces that fallthrough regardless of cache state, for pulling the full step-by-step ILOM
    // trace on a SN that would otherwise short-circuit here.
    if (skipCollector) {
      console.log(`[diagnose] skipCollector set, bypassing mfg-collector cache for ${serialNumber}`);
    } else {
      const collectorStatus = mfgCollectorCache.get(serialNumber.toUpperCase()) || null;
      console.log('[diagnose] mfg-collector cache lookup:', JSON.stringify(collectorStatus), '(cache last updated', mfgCollectorCacheUpdatedAt, ')');

      if (collectorStatus?.failing && !collectorStatus.ilomObservable) {
        const targetedCheck = MFG_COLLECTOR_TARGETED_CHECKS[collectorStatus.checkName];
        if (targetedCheck) {
          console.log(`[diagnose] mfg-collector reports ${collectorStatus.checkName} failing for ${serialNumber} — running its targeted check instead of the generic ILOM chain`);
          const { faults, raw } = await targetedCheck(serialNumber);
          return res.json({ faults, raw, source: `mfg-collector -> ${collectorStatus.checkName}` });
        }
        console.log(`[diagnose] mfg-collector reports ${collectorStatus.checkName} failing for ${serialNumber} but no targeted flow is mapped for it — returning the generic notice and skipping the ILOM chain below`);
        return res.json({
          faults: { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [
            `mfg-collector: ${serialNumber} failing ${collectorStatus.stage || collectorStatus.board} — ` +
            `${collectorStatus.checkNumber}_${collectorStatus.checkName} (${collectorStatus.duration}), ` +
            `no targeted diagnostic flow yet for this check — skipped ILOM diagnostics`,
          ], cableFaults: [] },
          raw: collectorStatus.raw,
          source: 'mfg-collector',
        });
      }
    }

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
          // "hwdiag temp get all" prints ~70 sensor lines (vs. fan info's ~7) and was observed
          // on real hardware to still be mid-output when the old 5000ms delay elapsed — the
          // trailing "exit" landed while the diag shell was still busy and cut the sensor table
          // off entirely (only the header printed before the connection closed).
          { line: 'hwdiag temp get all', delayAfterMs: 15000 },
          // "hwdiag system fabric test all" actively trains/tests 24 PCIe links (8 switches x 3
          // each), not just reading cached values like the two commands above — no real-hardware
          // timing for this one yet, so 20000ms is a conservative starting estimate pending
          // confirmation; bump it if it turns out to get cut off the same way temp get all did.
          { line: 'hwdiag system fabric test all', delayAfterMs: 20000 },
          { line: 'exit', delayAfterMs: 1500 }, // leave the diag shell, back to top-level "->"
          { line: 'exit', delayAfterMs: 1500 }, // log out of the top-level session
        ], ilomIp, ilomUser, ilomPassword, 75000);
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

          if (tempParsed.faults.components.length > 0) {
            parsed = { faults: tempParsed.faults, raw: `${ilomOut}\n${fmadmOut}\n${hwdiagOut}` };
          } else {
            console.log('[diagnose] hwdiag temp get all found nothing, scanning hwdiag system fabric test all');
            const fabricParsed = parseHwdiagFabricTestAll(hwdiagOut);
            console.log('[diagnose] hwdiag fabric test parsed faults:', JSON.stringify(fabricParsed.faults));
            parsed = { faults: fabricParsed.faults, raw: `${ilomOut}\n${fmadmOut}\n${hwdiagOut}` };
          }
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
