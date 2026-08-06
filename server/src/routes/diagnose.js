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
    pcieSwitchIds: [],
    dimmIds: [],
  };

  const compSet = new Set();
  const add = (list, set, id) => { if (!set.has(id)) { set.add(id); list.push(id); } };
  const addComp = (c) => add(faults.components, compSet, c);

  const psuSeen = new Set();
  const retimerSeen = new Set();
  const e1sSeen = new Set();
  const fanSeen = new Set();
  const dimmSeen = new Set();

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
  //
  // There are 5 fan boards (FANB1-5), each holding 5 fan modules numbered FM1-5 *within that
  // board* — FM numbering resets per board, it is not a global fan index. The chassis' flat fan
  // numbering (as used elsewhere, e.g. the GPU baseboard fan grid) is
  // (board - 1) * 5 + slot — confirmed on real hardware: FANB2/FM3 is fan 8, FANB3/FM2 is fan 12.
  // The board number must be captured and folded into this formula; using the raw FM slot alone
  // (as before) silently collapses e.g. FANB1/FM3 and FANB2/FM3 onto the same fan id.
  const fanRe = /\/SYS\/FANB?(\d*)\/FM(\d+)/gi;
  while ((m = fanRe.exec(output)) !== null) {
    const board = m[1] ? parseInt(m[1], 10) : 1;
    const slot = parseInt(m[2], 10);
    const n = (board - 1) * 5 + slot;
    add(faults.fanIds, fanSeen, n);
    addComp('gpu');
  }
  // A fan-class problem can also be reported without naming one specific FM (e.g.
  // "fault.chassis.config.fan.capacity-insufficient" affecting "/SYS" as a whole, from multiple
  // fan failures/missing fans — confirmed against real hardware, SN 2629YW10AD, 2026-07-27, both
  // as fmadm's own problem class and as show /System/Open_Problems' one-liner "Insufficient
  // cooling capacity due to multiple faulted or missing fans."). This alone doesn't distinguish a
  // real fault from a 2U chassis's *expected* reduced fan/PSU population (see
  // isNormalReducedFanChassis below, used by the caller to decide whether to actually surface
  // this) — just record that it fired here instead of deciding anything.
  const fanCapacityAlert = fanSeen.size === 0 && /fault\.chassis\.device\.fan|alert\.chassis\.config\.fan|fault\.chassis\.config\.fan\.capacity|fan (?:module|capacity)|insufficient cooling capacity/i.test(output);

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

  // DIMM faults — /SYS/MB/P<cpu>/D<slot> (confirmed against real "hwdiag system fabric test all"
  // output, e.g. "/SYS/MB/P0/D6", AND against a real fmadm faulty -a DIMM training-failure Suspect
  // block, 2629YW10ML, 2026-07-21, whose "Affects"/FRU "Location" lines both read
  // "/SYS/MB/P0/D3"). Only two CPUs (P0/P1), each with 16 DIMM slots (D0-D15) across 4 memory
  // controllers of 4 DIMMs each, per the real captured "CPU N Memory Controller M" sections — see
  // parseHwdiagFabricTestAll below for the PASSED/FAILED per-DIMM training result.
  const dimmRe = /\/SYS\/MB\/P(\d)\/D(\d+)/gi;
  while ((m = dimmRe.exec(output)) !== null) {
    add(faults.dimmIds, dimmSeen, `dimm-p${m[1]}-d${m[2]}`);
    addComp('mb');
  }
  // Fallback for a DIMM fault reported without a clean per-slot "Affects"/"Location" path — e.g.
  // the same real fault's own Response text warns "All memory DIMMs in the channel have been
  // disabled", a channel-wide condition that might not always resolve to one specific /SYS/MB/
  // P<n>/D<n> line. The literal word "DIMM" itself (problem class "fault.memory.amd.dimm...",
  // FRU Name "DDR5 SDRAM DIMM", etc.) is a broader, more reliable signal to watch for than
  // depending on the resource-path convention alone — same fallback pattern already used above
  // for fan faults reported without one specific FM number. "DIMMs?" (not "\bDIMM\b" alone) since
  // a plain word-boundary match doesn't match the plural "DIMMs" — no boundary exists between the
  // "M" and the "s", both being word characters — which is exactly the real channel-wide phrasing
  // this fallback exists to catch.
  if (dimmSeen.size === 0 && /\bDIMMs?\b/i.test(output)) {
    faults.genericErrors.push('DIMM-related fault reported (e.g. training failure or channel disable) — see raw output for the specific slot');
    addComp('mb');
  }

  // PCIe faults — two possible shapes depending on which ILOM command produced the output:
  //  (1) show /System/Open_Problems: inline "(Probability:N, UUID:x, Resource:y, ...)" per problem
  //  (2) fmadm faulty -a: one "Suspect N of M" block per fault, with Certainty + Resource/Location
  // The resource path's carrier can be either a PCIe port (PCIE<n>) or a storage device sitting
  // directly in an IOU bay (SSD<n>) — confirmed on real hardware, SN 2630YW1027, 2026-07-23,
  // "show /System/Open_Problems" -> Subsystems "Storage", "A PCI link error has been detected on
  // a PCI card." with Resource:/SYS/IOU2/SSD201. Both are genuine PCIe-link faults on that IOU, so
  // they're merged into the same pcieFaults shape — the GBB Tray only ever highlights by `iou`,
  // not by what the trailing number after it actually names.
  const iouPcieRe = /\/SYS\/IOU(\d+)\/(?:PCIE|SSD)(\d+)/i;
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

  return { faults, raw: output, fanCapacityAlert };
}

// Every hwdiag command's own banner prints a "Chassis type: <X>." line — confirmed against real
// hardware across multiple SNs (2630YW1027, 2630YW1049, 2629YW10AD, 2026-07) that this reads
// "Chassis type: 2U Flex." for the reduced-bay 2U platform.
function isReducedFanChassis(hwdiagOut) {
  return /Chassis type:\s*2U/i.test(hwdiagOut);
}

// PS2/PS3 are bays a 2U Flex chassis simply doesn't populate (only 2 PSUs, not the larger
// chassis's 4) — reporting "Not Present" on this chassis type is the expected, fully-healthy
// configuration, not a fault. Confirmed against real hardware, SN 2630YW1027, 2026-07-23: PS0/PS1
// "Present", PS2/PS3 "Not Present" on a unit with no other reported problems. FM2 is *not* in this
// set — unlike PS2/PS3, this chassis is expected to carry all three fan modules (FM0/FM1/FM2), so
// FM2 "Not Present" is a real fault, not a normal reduced-population bay.
const REDUCED_CHASSIS_OPTIONAL_BAYS = new Set(['PS2', 'PS3']);

// hwdiag fan info prints one line per fan ("FM<n>") and PSU ("PS<n>"), e.g.:
//   FM1    -  Present
//   FM21   - Not Readable
//   PS1    -  Present
// Anything whose status isn't exactly "Present" is treated as a fault, except PS2/PS3 reading
// "Not Present" specifically on a 2U chassis (see REDUCED_CHASSIS_OPTIONAL_BAYS above).
function parseHwdiagFanInfo(output) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  const compSet = new Set();
  const addComp = (c) => { if (!compSet.has(c)) { compSet.add(c); faults.components.push(c); } };
  const fanSeen = new Set();
  const psuSeen = new Set();
  const reducedChassis = isReducedFanChassis(output);

  const re = /^\s*(FM|PS)(\d+)\s*-\s*(.+?)\s*$/gim;
  let m;
  while ((m = re.exec(output)) !== null) {
    const [, kind, numStr, status] = m;
    const trimmedStatus = status.trim();
    // Exact match only — the previous /present/i.test(status) matched "present" as a *substring*
    // anywhere in the status text, which silently also matched "Not Present" (it contains
    // "Present") and so never actually flagged a missing fan/PSU on any chassis, reduced or not.
    if (/^present$/i.test(trimmedStatus)) continue;
    const bayId = `${kind}${numStr}`;
    if (reducedChassis && REDUCED_CHASSIS_OPTIONAL_BAYS.has(bayId) && /^not present$/i.test(trimmedStatus)) continue;
    const n = parseInt(numStr, 10);
    if (kind === 'FM') {
      // On a reduced (2U) chassis, hwdiag fan info's own FM numbering is itself 0-indexed —
      // FM0/FM1/FM2 (confirmed real hardware, SN 2630YW1027, 2026-07-23) — but the chassis UI's
      // fan grid (FanModule in ServerOverview.jsx) is 1-indexed, Fan 1 upward. Offset by 1 here so
      // a genuine FM0 fault highlights the UI's "Fan 1", not a nonexistent "Fan 0" that would
      // silently fail to match any rendered fan. The full-size chassis's own hwdiag fan info
      // output is already 1-indexed (FM1...FM21 in the real captured sample — see
      // hwdiag_fan_info_format memory) and needs no adjustment.
      const uiFanNum = reducedChassis ? n + 1 : n;
      if (!fanSeen.has(uiFanNum)) { fanSeen.add(uiFanNum); faults.fanIds.push(uiFanNum); }
      addComp('gpu');
    } else {
      // Same 0- vs 1-indexed split as the FM branch above: a reduced (2U) chassis's own hwdiag fan
      // info PS numbering is 0-indexed (PS0/PS1 — same real hardware sample), while the full-size
      // chassis's is already 1-indexed (PS1... in the captured sample). The shared psu-port-<n> id
      // space (used by both the 12-PSU B300 grid and, elsewhere, a 2U chassis's own PS0/PS1
      // display) is always 1-indexed, matching parseIlomProblems/parseHwdiagTempGetAll's own
      // /SYS/PS<n> (0-indexed) + 1 convention — this branch was the one place still emitting the
      // raw, un-offset number for a reduced chassis, which meant a fault reported only via this
      // command (not Open_Problems/fmadm) never matched any real psu-port-<n> id.
      const uiPsuNum = reducedChassis ? n + 1 : n;
      const id = `psu-port-${uiPsuNum}`;
      if (!psuSeen.has(id)) { psuSeen.add(id); faults.psuPorts.push(id); }
      addComp('psu');
    }
  }

  return { faults, raw: output };
}

// Gate for the Open_Problems/fmadm generic fan-capacity fallback below (see parseIlomProblems'
// fanCapacityAlert) — that fallback fires on the literal phrase/problem-class alone, with no way
// to tell a real fan problem from ILOM's fault manager not knowing about this chassis's smaller
// PSU population. Only treat it as a known false positive when the chassis is confirmed 2U *and*
// every bay that chassis is actually expected to carry (FM0/FM1/FM2/PS0/PS1 — all 3 fans, only 2 of
// the 4 PSU bays) reads "Present" — if hwdiag can't confirm that (its session failed, or something's
// actually missing), surface the alert rather than risk hiding a real problem.
function isNormalReducedFanChassis(hwdiagOut) {
  if (!hwdiagOut || !isReducedFanChassis(hwdiagOut)) return false;
  return ['FM0', 'FM1', 'FM2', 'PS0', 'PS1'].every((id) => new RegExp(`\\b${id}\\s*-\\s*Present\\b`, 'i').test(hwdiagOut));
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
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
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

// hwdiag system fabric test all has been observed in two entirely different real formats,
// apparently depending on platform:
//
// Format A ("G5-8hv" platform): one PASSED/FAILED line per switch/link (Retimer/GPU/SSD):
//   SWITCH: PCIE_SW1
//       PCIE_SW1 Retimer1    x16 @ 32.0GT/s       : PASSED
//       PCIE_SW1 GPU4        x16 @ 32.0GT/s       : PASSED
//       PCIE_SW1 SSD1        x4  @ 32.0GT/s       : PASSED
// On real hardware, a genuinely bad head node connection makes *every* link on *every* switch
// report FAILED in this format — that's not N isolated bad parts, it's a systemic problem, so
// instead of highlighting every retimer/GPU/SSD individually (noisy and actively misleading
// about what's actually wrong), the whole chassis is flagged and a head node reseat is called
// for. A partial failure (some links down, most passing) is treated normally. The "SWITCH:
// PCIE_SW<n>" / "PCIE_SW<n> ..." number is the physical PCIe switch itself — unlike the
// Retimer/GPU/SSD numbers on each of its three lines (which are switch-relative and don't map
// to a real IOU), PCIE_SW<n> is the actual faulted part, so a fault on any of a switch's three
// lines is attributed to that PCIE_SW<n> as a whole in faults.pcieSwitchIds.
//
// Format B ("3U Flex" platform): a CPU-core/UPI-link/memory-controller/PCI-device report, with
// PCIe devices identified by real /SYS/IOU<n>/PCIE<n> paths, e.g.:
//   CPU 0 PCI Devices:
//       /SYS/IOU13/PCIE1300    x8  @ 32.0GT/s         : PASSED
//       /SYS/IOU1/PCIE100      Not Trained            : FAILED
// This has no Retimer/GPU/SSD lines at all, so format A's regex matches nothing on it — it's
// parsed separately below and reuses the existing pcieFaults shape/highlighting (same
// /SYS/IOU<n>/PCIE<n> convention used elsewhere in this file), since these are real, unambiguous
// IOU numbers. No real-hardware evidence yet of what a systemic/all-failed case looks like in
// this format, so the "reseat head node" heuristic only applies to format A for now.
function parseHwdiagFabricTestAll(output) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  const compSet = new Set();
  const addComp = (c) => { if (!compSet.has(c)) { compSet.add(c); faults.components.push(c); } };
  const switchFailures = new Map(); // switch number -> [ 'Retimer8', 'GPU7', ... ] (which lines failed)

  const lineRe = /PCIE_SW(\d+)\s+(Retimer|GPU|SSD)(\d+)\s+.*?:\s*(PASSED|FAILED)\s*$/gim;
  let m;
  let total = 0;
  let failedCount = 0;
  while ((m = lineRe.exec(output)) !== null) {
    total++;
    const [, swNumStr, partType, partNumStr, status] = m;
    if (status.toUpperCase() !== 'FAILED') continue;
    failedCount++;
    const swNum = parseInt(swNumStr, 10);
    if (!switchFailures.has(swNum)) switchFailures.set(swNum, []);
    switchFailures.get(swNum).push(`${partType}${partNumStr}`);
    addComp(partType === 'GPU' ? 'gpu' : 'iob');
  }

  if (total > 0 && failedCount === total) {
    faults.components = ['gbb', 'gpu', 'iob', 'psu', 'bmc', 'rot'];
    faults.pcieSwitchIds = [...switchFailures.keys()].sort((a, b) => a - b);
    faults.genericErrors.push(
      `hwdiag system fabric test all: ALL ${total} fabric links failed (0/${total} passed) — this ` +
      `indicates a head node connectivity issue, not isolated component failures. Reseat the head node and retest.`
    );
    return { faults, raw: output };
  }

  if (switchFailures.size > 0) {
    faults.pcieSwitchIds = [...switchFailures.keys()].sort((a, b) => a - b);
    for (const [swNum, parts] of [...switchFailures.entries()].sort((a, b) => a[0] - b[0])) {
      faults.genericErrors.push(`hwdiag system fabric test all: PCIE_SW${swNum} failed (${parts.join(', ')} link down)`);
    }
  }

  // Format B pass — no-op if this output was actually format A (the regex just won't match).
  const pcieSeen = new Set();
  const iouPcieLineRe = /(\/SYS\/IOU(\d+)\/PCIE(\d+)\S*)\s+.*?:\s*(PASSED|FAILED)\s*$/gim;
  while ((m = iouPcieLineRe.exec(output)) !== null) {
    const [, resource, iouStr, pcieStr, status] = m;
    if (status.toUpperCase() !== 'FAILED') continue;
    if (pcieSeen.has(resource)) continue;
    pcieSeen.add(resource);
    faults.pcieFaults.push({ resource, iou: parseInt(iouStr, 10), pcie: parseInt(pcieStr, 10), probability: null });
    addComp('gbb');
  }

  // DIMM training results, also format B only — one line per DIMM under each "CPU <p> Memory
  // Controller <m>" section, e.g. "/SYS/MB/P0/D6          4400 MT/s              : PASSED".
  const dimmSeen = new Set();
  const dimmLineRe = /\/SYS\/MB\/P(\d)\/D(\d+)\s+.*?:\s*(PASSED|FAILED)\s*$/gim;
  while ((m = dimmLineRe.exec(output)) !== null) {
    const [, cpuStr, slotStr, status] = m;
    if (status.toUpperCase() !== 'FAILED') continue;
    const id = `dimm-p${cpuStr}-d${slotStr}`;
    if (dimmSeen.has(id)) continue;
    dimmSeen.add(id);
    faults.dimmIds.push(id);
    addComp('mb');
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
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };

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

// lionking_OSFP.py always looks up and prints the unit's associated test fixture on its way to
// checking OSFP links ("Fetching Fixture SN for JBOG: <SN>..." / "Fixture SN: <fixture SN>") —
// confirmed on real hardware across multiple units (2624YW10B9 -> 2628YW10DV, 2631YW111J ->
// 2628YW10BK). UPDATE_GXR3_FW's own script needs this same fixture SN, not the JBOG's own, to
// successfully resolve a MAC via SFCS (real failure signature seen on both units above when run
// with the JBOG SN instead: "Failed to get MAC from SFCS for SN: <JBOG SN>"). Deliberately matches
// "Fixture SN:" only (not the earlier "Fetching Fixture SN for JBOG:" line, which has "for JBOG"
// between "SN" and ":" and never reaches this pattern) so it only ever captures the resolved
// fixture SN, never the JBOG SN quoted in that first line.
const FIXTURE_SN_RE = /Fixture SN:\s*(\S+)/i;

async function runLionkingOSFPCheck(serialNumber) {
  console.log(`[diagnose] running: /home/tester/lionking_OSFP.py ${serialNumber}`);
  const output = await localExec(`/home/tester/lionking_OSFP.py ${serialNumber}`, 30000);
  console.log('[diagnose] lionking_OSFP.py raw output:\n', output);
  const result = parseLionkingOSFPOutput(output);
  console.log('[diagnose] lionking_OSFP.py parsed faults:', JSON.stringify(result.faults));
  const fixtureSnMatch = output.match(FIXTURE_SN_RE);
  if (fixtureSnMatch) result.fixtureSn = fixtureSnMatch[1];
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
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  const compSet = new Set();
  const addComp = (c) => { if (!compSet.has(c)) { compSet.add(c); faults.components.push(c); } };
  const retimerSeen = new Set();

  // The script colors its output with ANSI codes (e.g. "\x1b[92mIOU2 ... Good\x1b[0m") — left in,
  // \S+ greedily swallows the trailing reset code into the captured status ("Good\x1b[0m"), which
  // then fails an exact "good" match and gets every single IOU wrongly flagged as failed. Strip
  // them before matching.
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');

  const re = /IOU(\d+)\s+GXR3\s+card\s+FW\s+update\s+(\S+)/gi;
  let m;
  let total = 0;
  while ((m = re.exec(plain)) !== null) {
    total++;
    const [, iouStr, status] = m;
    if (/^good$/i.test(status)) continue;
    const id = `retimer-${parseInt(iouStr, 10)}`;
    if (!retimerSeen.has(id)) { retimerSeen.add(id); faults.retimerIds.push(id); }
    addComp('iob');
  }

  if (total === 0) {
    faults.genericErrors.push(`gxr3_fw_update_check did not report any IOU GXR3 results: ${plain.trim().slice(-500)}`);
  }

  return { faults, raw: output };
}

// "gxr3_fw_update_check" is a shell alias (not a real path) for /home/tester/WesleyH/GXR3_update_check
// -- same directory as eve_ip.pyc, not lionking_OSFP.py.
const GXR3_UPDATE_CHECK_PATH = '/home/tester/WesleyH/GXR3_update_check';

// serialNumber here is whatever the caller is currently targeting — the real UUT on a normal
// request, or the Fixture SN during the fixture pre-pass (see isFixturePass/effectiveSn in the
// main route handler below), which now covers what a narrower checkOptions.fixtureSn override
// used to handle just for this one check.
async function runGxr3FwUpdateCheck(serialNumber) {
  console.log(`[diagnose] running: echo ${serialNumber} | ${GXR3_UPDATE_CHECK_PATH}`);
  const output = await localExec(`echo ${serialNumber} | ${GXR3_UPDATE_CHECK_PATH}`, 30000);
  console.log('[diagnose] gxr3_fw_update_check raw output:\n', output);
  const result = parseGxr3FwUpdateCheck(output);
  console.log('[diagnose] gxr3_fw_update_check parsed faults:', JSON.stringify(result.faults));
  return result;
}

// hwdiag power get amps all / hwdiag power get volts all, confirmed against real hardware
// (2629YW10FE, 2026-07-20). The two commands use different line shapes for the same PSU, neither
// matching the "/SYS/PS<n>/..." convention used elsewhere in this file (e.g. "hwdiag temp get
// all"'s "/SYS/PS1/T_OUT : 43.00 deg C") — no space before the unit, and no separator slash:
//   hwdiag power get amps all:
//     /SYS/PS0_INPUT                      :   1.47A
//     /SYS/PS0_OUTPUT                     :  21.31A
//   hwdiag power get volts all:
//     /SYS/PS0                            :  12.12V
// Only PS0/PS1 are checked, per the specific POWER_ON flow this backs (see runPowerOnCheck) — a
// PSU reading exactly 0 for either amps or volts means it isn't actually delivering power, even
// if "hwdiag fan info" still reports it "Present".
function parseHwdiagPowerFaults(output) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  const compSet = new Set();
  const addComp = (c) => { if (!compSet.has(c)) { compSet.add(c); faults.components.push(c); } };
  const psuSeen = new Set();

  // A PSU's 12V rail legitimately reads 0A/0V whenever nothing is drawing load on it — which
  // happens not just when the PSU itself is dead, but whenever the whole host is powered off (both
  // PSUs would then read 0 on the shared main rail even though they're perfectly healthy). Cross-
  // check against the motherboard's own CPU core voltage rails, also in this same "hwdiag power
  // get volts all" output, before blaming a PSU. Confirmed against real hardware, SN 2629YW10AD,
  // 2026-07-27: PS1 read 12.12V/0.00A (looks like a dead PSU in isolation) while every
  // VDD_CORE<n>_CPU<n>_INF rail read exactly 0.00V, and a separate "hwdiag power info all" (richer
  // output this app doesn't run) confirmed those same rails' own Fault Status Word as "[06] OFF -
  // Unit is not providing power" — i.e. the host wasn't on, not a PSU failure. This is a second
  // line of defense behind runPowerOnCheck's own /SYS power_state gate (which should normally catch
  // this first) — e.g. if bypassPowerState was used, or power_state doesn't yet reflect reality.
  const coreVoltRe = /\/SYS\/MB\/VDD_CORE\d_CPU\d_INF\s*:\s*([\d.]+)V/gi;
  const coreVolts = [];
  let cvm;
  while ((cvm = coreVoltRe.exec(output)) !== null) coreVolts.push(parseFloat(cvm[1]));
  if (coreVolts.length > 0 && coreVolts.every((v) => v === 0)) {
    faults.genericErrors.push(
      'POWER_ON check: motherboard CPU core voltage rails (VDD_CORE*) all read 0V — the host is not powered on, so PS0/PS1 reading 0A/0V here is expected and not a PSU fault'
    );
    return { faults, raw: output };
  }

  const flagPsu = (psuNumStr, valueStr, unit, resource) => {
    if (parseFloat(valueStr) !== 0) return;
    const psuNum = parseInt(psuNumStr, 10);
    const id = `psu-port-${psuNum + 1}`;
    if (!psuSeen.has(id)) { psuSeen.add(id); faults.psuPorts.push(id); }
    addComp('psu');
    faults.genericErrors.push(`POWER_ON check: ${resource} reporting 0${unit} — not delivering power`);
  };

  const ampsRe = /\/SYS\/PS([01])_(INPUT|OUTPUT)\s*:\s*([\d.]+)A/gi;
  let m;
  while ((m = ampsRe.exec(output)) !== null) {
    const [, psuNumStr, ioLabel, valueStr] = m;
    flagPsu(psuNumStr, valueStr, 'A', `/SYS/PS${psuNumStr}_${ioLabel}`);
  }

  const voltsRe = /\/SYS\/PS([01])\s*:\s*([\d.]+)V/gi;
  while ((m = voltsRe.exec(output)) !== null) {
    const [, psuNumStr, valueStr] = m;
    flagPsu(psuNumStr, valueStr, 'V', `/SYS/PS${psuNumStr}`);
  }

  return { faults, raw: output };
}

// eve_ip.pyc's output has two real shapes:
//  (1) single-node (the overwhelming majority of units): one flat Name/MAC/IP/Status table with
//      bare "ILOM"/"ROT"/"HOSTNIC" rows.
//  (2) dual-node — a chassis physically hosting two independent server nodes, each with its own
//      full set of interfaces (confirmed real hardware, chassis SN 2630YW103D -> Node0 SN
//      2630YW103P / Node1 SN 2630YW103Q, 2026-07-31): "Node0: <SN>" / "Node1: <SN>" headers, each
//      followed by its own Name/MAC/IP/Status table using suffixed "ILOM0"/"ILOM1"/"ROT0"/"ROT1"/
//      "HOSTNIC0"/"HOSTNIC1" row names, with a "====" divider line between the two blocks.
// Always returns at least one node descriptor. `suffix` is '' for a single-node unit (matching
// its own bare row names) or '0'/'1' for a dual-node unit; `nodeSn` is null for single-node (the
// queried serialNumber IS the node) since a single-node unit's own table never repeats its SN the
// way each "Node<n>:" header does.
function parseEveIpNodes(eveOut) {
  const nodeHeaderRe = /^Node(\d+):\s*(\S+)/gim;
  const headers = [...eveOut.matchAll(nodeHeaderRe)];
  const sections = headers.length > 0
    ? headers.map((m, i) => ({
        suffix: m[1],
        nodeSn: m[2],
        text: eveOut.slice(m.index, i + 1 < headers.length ? headers[i + 1].index : eveOut.length),
      }))
    : [{ suffix: '', nodeSn: null, text: eveOut }];

  return sections.map(({ suffix, nodeSn, text }) => {
    const ilomMatch = text.match(new RegExp(`^ILOM${suffix}\\s+\\S+\\s+(\\d{1,3}(?:\\.\\d{1,3}){3})\\s+(\\S+)`, 'im'));
    const hostnicMatch = text.match(new RegExp(`^HOSTNIC${suffix}\\s+\\S+\\s+(\\d{1,3}(?:\\.\\d{1,3}){3})\\s+(\\S+)`, 'im'));
    return {
      suffix,
      label: suffix ? `ILOM${suffix}` : 'ILOM',
      nodeSn,
      text,
      ilomIp: ilomMatch ? ilomMatch[1] : null,
      ilomStatus: ilomMatch ? ilomMatch[2] : null,
      hostnicIp: hostnicMatch ? hostnicMatch[1] : null,
      hostnicStatus: hostnicMatch ? hostnicMatch[2] : null,
    };
  });
}

// Prefixes every genericError with which node/ILOM it came from, and — since a dual-node unit's
// two nodes are otherwise indistinguishable on a *structured* highlight (a "DIMM P0 D3" tile
// doesn't say which node's motherboard it's on) — adds one extra genericError note whenever a
// structured finding exists too, naming the node so a technician isn't left guessing which of the
// two physical nodes actually needs attention. A single-node unit never calls this at all (see
// each call site's own isMultiNode/explicitNode guard), so its output is completely unaffected.
function tagFaultsWithNode(faults, node) {
  const nodeTag = `${node.label}${node.nodeSn ? ` (node ${node.nodeSn})` : ''}`;
  const hasStructured = ['components', 'psuPorts', 'retimerIds', 'e1sIds', 'pcieFaults', 'fanIds', 'cableFaults', 'pcieSwitchIds', 'dimmIds']
    .some((key) => (faults[key] || []).length > 0);
  const genericErrors = (faults.genericErrors || []).map((msg) => `[${nodeTag}] ${msg}`);
  if (hasStructured) {
    genericErrors.push(`[${nodeTag}] The finding(s) above (${(faults.components || []).join(', ') || 'see detail'}) were found on this node.`);
  }
  return { ...faults, genericErrors };
}

// Merges an array of per-node {faults, raw, gateParam?, chassisModel?, isE5E6Chassis?} results
// (each already tagged via tagFaultsWithNode by the caller) into one combined result, for a
// targeted check invoked standalone (no explicitNode — see runPowerOnCheck/runHostnicCheck) that
// discovers a dual-node chassis via its own eve_ip call. gateParam takes the first node that
// needed one (bypassing it applies to both nodes on the retry, since checkOptions is shared);
// chassisModel takes the last node that reported one (both nodes are physically the same chassis
// model, so this is only ever a redundant confirmation, not a real conflict).
function mergeNodeResults(results) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  let raw = '';
  let gateParam = null;
  let chassisModel = null;
  let isE5E6Chassis = false;
  for (const r of results) {
    for (const key of ['components', 'psuPorts', 'retimerIds', 'e1sIds', 'fanIds', 'cableFaults', 'pcieSwitchIds', 'dimmIds']) {
      faults[key].push(...(r.faults[key] || []));
    }
    faults.pcieFaults.push(...(r.faults.pcieFaults || []));
    faults.genericErrors.push(...(r.faults.genericErrors || []));
    raw += (raw ? '\n\n' : '') + (r.raw || '');
    if (!gateParam && r.gateParam) gateParam = r.gateParam;
    if (r.chassisModel) { chassisModel = r.chassisModel; isE5E6Chassis = r.isE5E6Chassis; }
  }
  return { faults, raw, ...(gateParam ? { gateParam } : {}), ...(chassisModel ? { chassisModel, isE5E6Chassis } : {}) };
}

// Targeted flow for a POWER_ON-class failure (e.g. the HOST_POWER_ON_PRETEST stage seen in
// mfg-collector/Jira tickets): eve_ip -> SSH into the ILOM -> /SP/diag/shell -> "hwdiag power get
// amps all" -> "hwdiag power get volts all", then flag PS0/PS1 if either reports 0. Unlike
// lionking_OSFP.py/GXR3_update_check (external scripts run locally), this one drives the ILOM
// session directly, the same way the default chain's own hwdiag commands do.
//
// explicitNode is passed by the default chain's own per-node loop (see the router handler below)
// when this runs as part of that loop's Step 3 sweep against a dual-node chassis — it reuses the
// eve_ip read the loop already did instead of paying for another one here, and returns *untagged*
// faults since the outer loop applies tagFaultsWithNode itself. Called any other way (the mfg-
// collector/Jira targeted-check short-circuit, or ?forceCheck=CHECK_POWER_ON) it resolves its own
// node(s) from scratch exactly as before — and if that reveals more than one node on its own, it
// runs this same procedure against each and merges+tags the results itself.
async function runPowerOnCheck(serialNumber, options = {}, explicitNode = null) {
  const emptyFaults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  let rawPrefix = '';

  if (!explicitNode) {
    const eveOut = await localExec(`python3 /home/tester/WesleyH/eve_ip.pyc ${serialNumber}`);
    const nodes = parseEveIpNodes(eveOut);
    if (nodes.length > 1) {
      console.log(`[diagnose] POWER_ON check: ${serialNumber} is a dual-node chassis (${nodes.map((n) => n.nodeSn).join(', ')}) — running the check against each node`);
      const results = [];
      for (const node of nodes) {
        const r = await runPowerOnCheck(serialNumber, options, node);
        results.push({ ...r, faults: tagFaultsWithNode(r.faults, node) });
      }
      return mergeNodeResults(results);
    }
    explicitNode = nodes[0];
    rawPrefix = `${eveOut}\n`;
  }

  console.log(`[diagnose] running POWER_ON check flow for ${serialNumber} (${explicitNode.label}): eve_ip -> ILOM -> show /SYS -> hwdiag power get amps/volts all`);
  const { ilomIp, ilomStatus, label: nodeLabel, hostnicIp, hostnicStatus } = explicitNode;
  if (!ilomIp) {
    return { faults: { ...emptyFaults, genericErrors: [`POWER_ON check: no ${nodeLabel} interface found for ${serialNumber} in eve_ip output`] }, raw: rawPrefix };
  }
  if (!/^up$/i.test(ilomStatus || '')) {
    return {
      faults: { ...emptyFaults, genericErrors: [`POWER_ON check: ${nodeLabel} for ${serialNumber} is reported ${(ilomStatus || 'DOWN').toUpperCase()} — cannot check power rails`] },
      raw: rawPrefix,
    };
  }

  // A down HOSTNIC (the host's own network interface) plausibly explains a PS0/PS1 0A/0V reading
  // below without either PSU being genuinely broken — confirmed against real hardware, SN
  // 2629YW10JZ, 2026-07-28: eve_ip reported HOSTNIC down (ILOM/ROT still up) and this exact unit's
  // PS1 later read 0A on its main rail. Checked unconditionally, not just when a Jira ticket
  // happens to pair CHECK_POWER_ON with UPDATE_HOSTNIC_FW_REMOTE in its own text (the previous,
  // too-narrow trigger) — HOSTNIC's state is relevant context for interpreting the power-rail
  // reading regardless of what the ticket says. Reuses the eve_ip data already resolved above
  // (whether from this node's own eve_ip call, or from explicitNode passed in by the caller), no
  // extra round trip.
  //
  // options.bypassHostnicCheck (mirrors bypassPowerState below) lets the caller skip this gate and
  // run the power-rail check anyway — set when the user answers "yes" to the router's "keep
  // running the targeted check?" confirm prompt (see gateParam on the returned object: the router
  // uses it to know which flag to resend on that follow-up request).
  if (hostnicIp && !/^up$/i.test(hostnicStatus || '')) {
    if (!options.bypassHostnicCheck) {
      return {
        faults: { ...emptyFaults, genericErrors: [`POWER_ON check: HOSTNIC (${hostnicIp}) is reported ${hostnicStatus.toUpperCase()} — check the DAC cable`] },
        raw: rawPrefix,
        gateParam: 'bypassHostnicCheck',
      };
    }
    console.log(`[diagnose] POWER_ON check: HOSTNIC is "${hostnicStatus}" but bypassHostnicCheck was requested — running the power-rail check anyway`);
  }

  const ilomUser = process.env.ILOM_USER || 'root';
  const ilomPassword = process.env.ILOM_PASSWORD || 'changeme';

  // Check /SYS's own power_state property first, before paying for the hwdiag power-rail session
  // below — a server that's simply powered off will read near-0A/0V on every rail, which
  // parseHwdiagPowerFaults would otherwise misreport as a genuine PS0/PS1 delivery fault instead
  // of what it actually is (the unit just isn't turned on). Confirmed against real hardware (SN
  // 2629YW10JZ, 2026-07-24), "show /SYS" -> Properties -> "power_state = On" (or "Off").
  //
  // options.bypassPowerState lets the user override this and run the power-rail check anyway —
  // e.g. a technician who just flipped the unit on and knows the ILOM's power_state property
  // hasn't caught up yet, or wants the rail readings regardless of what /SYS currently reports.
  // Set when the user answers "yes" to the router's "keep running the targeted check?" confirm
  // prompt (see gateParam on the returned object below).
  const sysOut = await runIlomSession([
    { line: 'show /SYS', delayAfterMs: 1500 },
    { line: 'exit', delayAfterMs: 750 },
  ], ilomIp, ilomUser, ilomPassword, 10000);
  console.log('[diagnose] POWER_ON check /SYS output:\n', sysOut);
  // "show /SYS" -> Properties also prints "product_name = ORACLE SERVER E6-2c" (confirmed real
  // hardware, SN 2631YW103X, 2026-07-29) — this is the live, always-available signal for routing
  // to the E5-2c/E6-2c chassis page, unlike the Jira "Model" field (E5_E6_MODEL_RE further below),
  // which only exists when a technician supplies a Jira link *and* that ticket happens to carry a
  // Model field. Every diagnose reaches this /SYS read via CHECK_POWER_ON (either matched directly
  // or swept unconditionally in the default chain's Step 3), so this is the primary detection path
  // — chassisModel/isE5E6Chassis are attached to every return below where sysOut is available.
  const productNameMatch = sysOut.match(/product_name\s*=\s*(.+)/i);
  const chassisModel = productNameMatch ? productNameMatch[1].trim() : null;
  const isE5E6Chassis = chassisModel ? E5_E6_MODEL_RE.test(chassisModel) : false;
  const powerStateMatch = sysOut.match(/power_state\s*=\s*(\S+)/i);
  if (powerStateMatch && !/^on$/i.test(powerStateMatch[1])) {
    if (!options.bypassPowerState) {
      return {
        faults: { ...emptyFaults, genericErrors: [`POWER_ON check: /SYS power_state reports "${powerStateMatch[1]}" — server is not powered on`] },
        raw: `${rawPrefix}${sysOut}`,
        gateParam: 'bypassPowerState',
        chassisModel, isE5E6Chassis,
      };
    }
    console.log(`[diagnose] POWER_ON check: /SYS power_state is "${powerStateMatch[1]}" but bypassPowerState was requested — running the power-rail check anyway`);
  }

  const powerOut = await runIlomSession([
    { line: 'start -script /SP/diag/shell', delayAfterMs: 1000 },
    { line: 'hwdiag power get amps all', delayAfterMs: 4000 },
    { line: 'hwdiag power get volts all', delayAfterMs: 4000 },
    { line: 'exit', delayAfterMs: 750 },
    { line: 'exit', delayAfterMs: 750 },
  ], ilomIp, ilomUser, ilomPassword, 22500);
  console.log('[diagnose] POWER_ON check raw output:\n', powerOut);

  const result = parseHwdiagPowerFaults(powerOut);
  console.log('[diagnose] POWER_ON check parsed faults:', JSON.stringify(result.faults));
  return { faults: result.faults, raw: `${rawPrefix}${sysOut}\n${powerOut}`, chassisModel, isE5E6Chassis };
}

// Targeted flow for an UPDATE_HOSTNIC_FW_REMOTE-class failure — that check needs the host's own
// network interface (HOSTNIC) up to even run, so whenever it's mentioned (a mfg-collector match,
// or this checkName appearing among a Jira ticket's own check codes — see describeJiraFlow), verify
// HOSTNIC directly via eve_ip and prompt to check the DAC cable if it's down. This is the same
// HOSTNIC check already folded into runPowerOnCheck above, as its own standalone targeted flow —
// covers a ticket that names UPDATE_HOSTNIC_FW_REMOTE on its own, without also naming
// CHECK_POWER_ON (which is the only other place this app currently checks HOSTNIC). Also means the
// default chain's Step 3 sweep (which runs every entry in MFG_COLLECTOR_TARGETED_CHECKS
// unconditionally) now checks HOSTNIC on every diagnosis, not just Jira-matched ones.
//
// explicitNode/options follow the exact same contract as runPowerOnCheck above — see its own
// comment for the full explanation. options is otherwise unused here (this check has no gate of
// its own to bypass) but kept in the signature so runAndReportCheck can call every targeted check
// the same uniform way.
async function runHostnicCheck(serialNumber, options = {}, explicitNode = null) {
  const emptyFaults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  let rawPrefix = '';

  if (!explicitNode) {
    const eveOut = await localExec(`python3 /home/tester/WesleyH/eve_ip.pyc ${serialNumber}`);
    const nodes = parseEveIpNodes(eveOut);
    if (nodes.length > 1) {
      console.log(`[diagnose] UPDATE_HOSTNIC_FW_REMOTE check: ${serialNumber} is a dual-node chassis (${nodes.map((n) => n.nodeSn).join(', ')}) — running the check against each node`);
      const results = [];
      for (const node of nodes) {
        const r = await runHostnicCheck(serialNumber, options, node);
        results.push({ ...r, faults: tagFaultsWithNode(r.faults, node) });
      }
      return mergeNodeResults(results);
    }
    explicitNode = nodes[0];
    rawPrefix = eveOut;
  }

  console.log(`[diagnose] running UPDATE_HOSTNIC_FW_REMOTE check flow for ${serialNumber} (${explicitNode.label}): eve_ip HOSTNIC status`);
  const { hostnicIp, hostnicStatus, label: nodeLabel } = explicitNode;
  if (!hostnicIp) {
    return { faults: { ...emptyFaults, genericErrors: [`UPDATE_HOSTNIC_FW_REMOTE check: no HOSTNIC interface found for ${serialNumber} (${nodeLabel}) in eve_ip output`] }, raw: rawPrefix };
  }
  if (!/^up$/i.test(hostnicStatus || '')) {
    return {
      faults: { ...emptyFaults, genericErrors: [`UPDATE_HOSTNIC_FW_REMOTE check: HOSTNIC (${hostnicIp}) is reported ${hostnicStatus.toUpperCase()} — check the DAC cable`] },
      raw: rawPrefix,
    };
  }
  console.log(`[diagnose] UPDATE_HOSTNIC_FW_REMOTE check: HOSTNIC (${hostnicIp}) is up`);
  return { faults: emptyFaults, raw: rawPrefix };
}

// Maps a mfg-collector checkName to its targeted diagnostic flow. Add an entry here per check as
// its specific command/script and output format are known, instead of falling back to the
// generic "not ILOM-observable" message below.
const MFG_COLLECTOR_TARGETED_CHECKS = {
  VERIFY_OSFP_LINKS: runLionkingOSFPCheck,
  UPDATE_GXR3_FW: runGxr3FwUpdateCheck,
  CHECK_POWER_ON: runPowerOnCheck,
  UPDATE_HOSTNIC_FW_REMOTE: runHostnicCheck,
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
// Measured against the real endpoint: the data page was ~600KB / ~45s to fully download when this
// was first measured (confirmed with both curl and Node's fetch — the server being slow to
// render/flush ~2200 rows, not a client bug). That's as long as the ILOM SSH chain this is meant
// to save time on, so fetching it synchronously per diagnose request would often make things
// slower, not faster. Instead, a background poller fetches+parses the whole table into an
// in-memory SN -> status cache on an interval, and each /diagnose request just does an instant
// in-memory lookup against whatever the cache currently holds.
//
// The table only grows over time (it's an accumulating historical log, not a rolling window), so
// a fixed timeout measured against an earlier row count eventually becomes too tight — confirmed
// on real hardware: with the original 90s timeout, refreshMfgCollectorCache failed with "The
// operation was aborted due to timeout" on *every* attempt, leaving mfgCollectorCacheUpdatedAt
// permanently null and mfgCollectorCache a permanently empty Map. Every SN then looked like "not
// in mfg-collector" — not because any given SN was actually missing from the table, but because
// the table had never been loaded at all. 180s gives more headroom; see describeDefaultFlow below
// for how a totally unpopulated cache is now reported distinctly from a genuine per-SN miss.
const MFG_COLLECTOR_BASE = 'https://mfg-collector.hyvesolutions.org';
const MFG_COLLECTOR_LOGIN_PAGE = `${MFG_COLLECTOR_BASE}/out/out.login.php`;
const MFG_COLLECTOR_LOGIN_URL = `${MFG_COLLECTOR_BASE}/op/op.loginA.php`;
const MFG_COLLECTOR_DATA_URL = `${MFG_COLLECTOR_BASE}/out/out.evelionking_all.php`;
const MFG_COLLECTOR_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MFG_COLLECTOR_FETCH_TIMEOUT_MS = 180 * 1000;
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
  const startedAt = Date.now();
  try {
    const cookie = await mfgCollectorLogin();
    const res = await fetch(MFG_COLLECTOR_DATA_URL, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(MFG_COLLECTOR_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`mfg-collector returned HTTP ${res.status}`);
    const html = await res.text();
    if (/name=['"]userid['"]/i.test(html)) {
      throw new Error('mfg-collector session invalid — got the login page back instead of the data table');
    }
    mfgCollectorCache = parseMfgCollectorTable(html);
    mfgCollectorCacheUpdatedAt = new Date();
    console.log(`[diagnose] mfg-collector cache refreshed: ${mfgCollectorCache.size} SNs, at ${mfgCollectorCacheUpdatedAt.toISOString()} (took ${Date.now() - startedAt}ms)`);
  } catch (err) {
    // If the cache has never once loaded successfully, mfgCollectorCacheUpdatedAt is still null —
    // describeDefaultFlow below checks that explicitly so an unpopulated cache doesn't get
    // reported to the user as "SN not found in mfg-collector" (a claim about the table's
    // contents) when the real problem is that the table itself was never fetched.
    console.warn(`[diagnose] mfg-collector cache refresh failed after ${Date.now() - startedAt}ms, keeping previous cache (${mfgCollectorCacheUpdatedAt ? `last good: ${mfgCollectorCacheUpdatedAt.toISOString()}` : 'never successfully loaded'}):`, err.message);
  } finally {
    mfgCollectorRefreshInFlight = false;
  }
}

// Fire the first poll on module load (fire-and-forget — the server starts accepting requests
// immediately; until the first refresh lands, lookups just miss and fall through to the normal
// ILOM chain, same as if this feature didn't exist), then keep refreshing on an interval.
refreshMfgCollectorCache();
setInterval(refreshMfgCollectorCache, MFG_COLLECTOR_POLL_INTERVAL_MS);

// Only a select few units are ever actually in JBOG testing (mfg-collector's table) at a given
// time, so a Jira repair ticket referencing a specific SN's failing check(s) is often the *only*
// place that information exists for a unit that's already moved past JBOG. When a jiraLink is
// supplied, it takes priority over the mfg-collector cache below — see describeJiraFlow.
//
// Restricted to the exact Jira REST issue-fetch shape (scheme + host + path prefix) rather than
// accepting any URL — fetching an arbitrary user-supplied URL server-side is an SSRF vector
// (it would let a request reach internal hosts/ports the user couldn't otherwise reach directly).
const JIRA_ISSUE_URL_RE = /^https:\/\/jira\.synnex\.com\/rest\/api\/2\/issue\/[A-Za-z0-9-]+\/?(?:\?.*)?$/;

// Extracts every "<N>_<CHECKNAME>" style code from a Jira issue's summary line, e.g.
// "EVE: 2629YW10GJ : TA.B5-EVE04 : LOC: 8 : 2_CHECK_IOU_POWER_CABLE-3_CHECK_PCIE_CABLE" ->
// [{checkNumber:'2', checkName:'CHECK_IOU_POWER_CABLE'}, {checkNumber:'3', checkName:'CHECK_PCIE_CABLE'}]
// — the same "<N>_<CHECKNAME>" convention mfg-collector's Status column uses (both are fed by the
// same manufacturing check pipeline), confirmed against a real ticket (MFGS-557044, 2026-07-20).
function extractJiraCheckCodes(summary) {
  const codes = [];
  const re = /(\d+)_([A-Z][A-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(summary || '')) !== null) codes.push({ checkNumber: m[1], checkName: m[2] });
  return codes;
}

// hwdiag io config's internal hwdiag_io_cables cross-check (embedded in that diag-shell command's
// own output, not a separate command run by this app) compares the wiring a Golden Image (GI)
// reference config expects against what's actually connected, one ERROR block per mismatched
// cable, e.g.:
//   hwdiag_io_cables -> Cable#13 in GI:
//   PCIe Data Cable#13: IOU Bay: -, IOU Module: Not Connected
//   hwdiag_io_cables -> Cable#13 in system:
//   PCIe Data Cable#13: IOU Bay: 3, IOU Module: PCIE_HH
//   Check Result: FAIL
// Shared by two sources of this same output shape: the live default ILOM chain below now runs
// "hwdiag io config" itself as the first command in its hwdiag session, and describeJiraFlow
// (further down) parses it out of a technician's pasted diag-shell session in a Jira ticket
// comment, for units already routed to repair before this app ran it live (confirmed against a
// real ticket, MFGS-557044, 2026-07-20, where cables #13 and #14 were swapped between IOU bays).
// There's no dedicated chassis UI element for a specific IOU PCIe/power cable yet, so each FAIL
// becomes a generic error naming the cable and the bay/module mismatch; 'iob' is highlighted
// since these cables live on the IOB tray's retimer board.
function parseHwdiagIoCableFaults(text) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  const compSet = new Set();
  const addComp = (c) => { if (!compSet.has(c)) { compSet.add(c); faults.components.push(c); } };

  const blockRe = /Cable#(\d+) in GI:\s*[\r\n]+\s*PCIe Data Cable#\d+:\s*IOU Bay:\s*(\S+),\s*IOU Module:\s*([^\r\n]+?)\s*[\r\n]+\s*hwdiag_io_cables\s*->\s*Cable#\d+ in system:\s*[\r\n]+\s*PCIe Data Cable#\d+:\s*IOU Bay:\s*(\S+),\s*IOU Module:\s*([^\r\n]+?)\s*[\r\n]+\s*Check Result:\s*(PASS|FAIL)/gi;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const [, cableNum, giBay, giModule, sysBay, sysModule, result] = m;
    if (result.toUpperCase() !== 'FAIL') continue;
    faults.genericErrors.push(
      `hwdiag_io_cables: Cable#${cableNum} mismatch — expected IOU Bay ${giBay} (${giModule.trim()}), ` +
      `found IOU Bay ${sysBay} (${sysModule.trim()}) in system — likely swapped with another cable`
    );
    addComp('iob');
  }

  return { faults, raw: text };
}

// hwdiag_io_config's own cross-check on IOU *bay presence* (distinct from parseHwdiagIoCableFaults
// above, which is about the PCIe cabling to a bay) — one ERROR block per bay whose GI-expected
// presence disagrees with what's actually there, e.g. a module physically moved from one bay to
// another (confirmed against a real captured Failure Message):
//   hwdiag_io_config -> IOU Bay 15 in GI:
//   NO_PRESENT
//   hwdiag_io_config -> IOU Bay 15 in system:
//   IOU Bay: 15, IOU Module: PCIE_HH
//   Check Result: FAIL
//   hwdiag_io_config -> IOU Bay 9 in GI:
//   IOU Bay: 9, IOU Module: PCIE_HH
//   hwdiag_io_config -> IOU Bay 9 in system:
//   MISSING
//   Check Result: FAIL.
// The GI/system value line is either a bare NO_PRESENT/MISSING keyword or a structured "IOU Bay: N,
// IOU Module: X" / "IOU Bay: N, PCIe Data Connectors on IOU Module: [...]" line — captured as
// free text either way since only whether the bay is present/absent (not the module details)
// drives the message here. The same real transcript often repeats each bay's block twice (once
// per hwdiag_io_config sub-check), so dedupe by bay number the same way
// parseIouFruPositionFaults does for repeated IOU mentions.
function parseHwdiagIoConfigBayFaults(text) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  const compSet = new Set();
  const addComp = (c) => { if (!compSet.has(c)) { compSet.add(c); faults.components.push(c); } };
  const reportedBays = new Set();

  const blockRe = /hwdiag_io_config\s*->\s*IOU Bay (\d+) in GI:\s*[\r\n]+\s*([^\r\n]+?)\s*[\r\n]+\s*hwdiag_io_config\s*->\s*IOU Bay \d+ in system:\s*[\r\n]+\s*([^\r\n]+?)\s*[\r\n]+\s*Check Result:\s*(PASS|FAIL)\.?/gi;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const [, bayNum, giValue, sysValue, result] = m;
    if (result.toUpperCase() !== 'FAIL' || reportedBays.has(bayNum)) continue;
    reportedBays.add(bayNum);
    const giAbsent = /^(NO_PRESENT|MISSING)$/i.test(giValue.trim());
    const sysAbsent = /^(NO_PRESENT|MISSING)$/i.test(sysValue.trim());
    const detail = giAbsent
      ? `not expected per GI reference (${giValue.trim()}) but found "${sysValue.trim()}" in system — likely a module relocated here from another bay`
      : sysAbsent
        ? `expected "${giValue.trim()}" per GI reference but reported ${sysValue.trim()} in system — likely relocated to another bay, reseat and reverify`
        : `GI reference ("${giValue.trim()}") disagrees with system ("${sysValue.trim()}")`;
    faults.genericErrors.push(`hwdiag_io_config: IOU Bay ${bayNum} ${detail}`);
    addComp('gbb');
    // Only the bay that LOST its expected module (sysAbsent) lights up the GBB Tray's OSFP/IOU
    // module directly — that's the physically empty bay a technician needs to act on. The bay an
    // unexpected module turned up in (giAbsent) isn't flagged the same way: the module itself is
    // presumably fine, it's just sitting in the wrong slot, and the genericError above already
    // names it. hasFault on the chassis UI matches pcieFaults by `iou` alone (see
    // ServerOverview.jsx's renderModule), so pcie/probability are irrelevant here — set null.
    if (sysAbsent) {
      faults.pcieFaults.push({ resource: `IOU${bayNum} bay presence`, iou: parseInt(bayNum, 10), pcie: null, probability: null });
    }
  }

  return { faults, raw: text };
}

// A technician doesn't always paste a structured hwdiag_io_cables transcript into the ticket —
// sometimes the comment is just plain prose ("PSU3 is dead", "Fan 12 not spinning", "IOU5 link
// down"). This catches those looser mentions the same way the real SSH-output parsers above key
// off a part prefix immediately followed by a number (PSU<n>, FANB<n>/FM<n>, /SYS/MB/P<n>/D<n>,
// IOU<n>/PCIE<n>, etc.), just without requiring the full /SYS/... resource path — only a bare
// "<word> <number>". Longer/more specific tokens are listed before their prefixes in the
// alternation (pcie before ps, dimm before d) since JS regex alternation takes the first
// alternative that matches at a position, not the longest, so "psu3" must try "psu" before "ps"
// or it would only ever capture "su3" was PS and drop the U. Deliberately loose (feeds
// genericErrors, not a specific component highlight) since a bare token+number in free text isn't
// as trustworthy as a real resource path.
const PART_MENTION_RE = /\b(pcie|psu|dimm|iou|fan|fm|fs|ps|d)[\s#-]{0,2}(\d{1,3})\b/gi;

// excludeTokens lets a caller that already ran a more specific parser (e.g.
// parseIouFruPositionFaults) over the same text suppress the redundant, vaguer mention it would
// otherwise also produce for the same part+number (e.g. skip "IOU6" here once the FRU-mismatch
// parser has already explained exactly what's wrong with IOU6).
function parseGenericPartMentions(text, excludeTokens = new Set()) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  const seen = new Set();
  let m;
  while ((m = PART_MENTION_RE.exec(text)) !== null) {
    const token = `${m[1].toUpperCase()}${m[2]}`;
    if (seen.has(token) || excludeTokens.has(token)) continue;
    seen.add(token);
    faults.genericErrors.push(`Ticket comment mentions ${token} — verify against live diagnostics before assuming this is the fault`);
  }
  return { faults, raw: text };
}

// CHECK_IOU_FRU compares each IOU's expected position (the "base_record", i.e. what the build
// config says should be installed) against what SFCS (the factory's system-level tracking record)
// actually sees — a mismatch means the physical IOU module isn't seated where it's supposed to be.
// Confirmed against a real ticket, MFGS-525635, 2026-05-23, SN 2621YW11TJ: both the ticket's
// Description ("*Failure Message:*") and a technician's follow-up comment carried the identical
// text (just reflowed — newlines in the Description, single-line inside the comment's {code}
// block), e.g.:
//   Position based on base_record: Device None
//       /SYS/IOU6 (Position According BaseRecord)
//       MISSING (Position From SFCS)
//   Check Result: FAIL
// "MISSING" here means SFCS never detected the module at all — the fix is a physical reseat, not a
// firmware/cable action, so the message says so directly rather than the vaguer "verify against
// live diagnostics" wording parseGenericPartMentions uses for a bare, unconfirmed number mention.
function parseIouFruPositionFaults(text) {
  const faults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  const compSet = new Set();
  const addComp = (c) => { if (!compSet.has(c)) { compSet.add(c); faults.components.push(c); } };
  // Handed back to the caller so it can tell parseGenericPartMentions to skip re-mentioning these
  // same IOUs with its vaguer, unconfirmed-number wording.
  const matchedTokens = new Set();

  // The identical text often appears twice in the same ticket (the Description's own "Failure
  // Message" and a technician's follow-up comment quoting it back) — dedupe by IOU number so that
  // doesn't turn into two copies of the same genericError.
  const reportedIous = new Set();
  const re = /Position based on base_record:\s*Device\s+\S+\s*\/SYS\/IOU(\d+)\s*\(Position According BaseRecord\)\s*(\S+)\s*\(Position From SFCS\)\s*Check Result:\s*(PASS|FAIL)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, iouNum, sfcsStatus, result] = m;
    matchedTokens.add(`IOU${iouNum}`);
    if (result.toUpperCase() !== 'FAIL' || reportedIous.has(iouNum)) continue;
    reportedIous.add(iouNum);
    const verb = /^missing$/i.test(sfcsStatus) ? 'reseat' : 'reseat and reverify';
    faults.genericErrors.push(
      `CHECK_IOU_FRU: IOU${iouNum} reported ${sfcsStatus.toUpperCase()} (expected per base_record, not confirmed by SFCS) — ${verb} IOU${iouNum}`
    );
    addComp('gbb');
  }

  return { faults, raw: text, matchedTokens };
}

// This EVE BOT-generated ticket pipeline stores its machine-parseable failure detail in the
// *description* field as Jira wiki-markup "*Label:* value" lines (one per line, blank-line
// separated) — not as dedicated custom fields, e.g.:
//   *Failed Testcase:* 11_POWER_ON
//   *Failure Message:* Power on failed.
// confirmed against a real ticket (MFGS-557103, 2026-07-20). Extracts every such pair into a Map
// keyed by label so callers can look up "Failed Testcase"/"Failure Message" directly instead of
// guessing at which of the ~700 customfield_XXXXX ids might hold them (most are unrelated and
// null on any given ticket).
function parseJiraDescriptionFields(description) {
  const fields = new Map();
  // The whitespace between ":*" and the value must stay on the same line ([ \t]*, not \s*) — a
  // field with an empty value (e.g. "*Error Detail:* " followed by a blank line) previously let
  // \s* swallow the newlines and bleed into the *next* label's line as if it were this field's
  // value, corrupting whichever field happened to follow an empty one.
  const re = /\*([^*\n]+):\*[ \t]*([^\n]*)/g;
  let m;
  while ((m = re.exec(description || '')) !== null) fields.set(m[1].trim(), m[2].trim());
  return fields;
}

// "Failure Message" is the one field on this EVE BOT template that's genuinely multi-line — e.g.
// a real CHECK_IOU_FRU ticket (MFGS-525635, 2026-05-23, SN 2621YW11TJ):
//   *Failure Message:* Position based on base_record:
//   Device None
//       /SYS/IOU6 (Position According BaseRecord)
//       MISSING (Position From SFCS)
//   Check Result: FAIL.
//
//   *GUTI:* ...
// parseJiraDescriptionFields above deliberately only ever takes the rest of that *same line* (see
// its own comment for why), so descriptionFields.get('Failure Message') alone would only ever
// return "Position based on base_record:" — dropping the "/SYS/IOU6 ... MISSING ... Check Result:
// FAIL" lines that actually name the fault. This captures everything up to the next blank line
// (Jira's own field separator) or the next "*Label:*" line, whichever comes first.
function extractJiraFullFailureMessage(description) {
  const m = (description || '').match(/\*Failure Message:\*[ \t]*([\s\S]*?)(?=\n[ \t]*\n|\n\*[^*\n]+:\*|$)/i);
  return m ? m[1].trim() : '';
}

async function fetchJiraCheckInfo(jiraLink) {
  if (!JIRA_ISSUE_URL_RE.test(jiraLink)) {
    throw new Error(`Jira link must look like https://jira.synnex.com/rest/api/2/issue/<key-or-id> — got: ${jiraLink}`);
  }
  // jira.synnex.com requires auth (confirmed on real hardware: an unauthenticated request comes
  // back HTTP 401) — a Personal Access Token from JIRA_API_TOKEN, sent as a Bearer token, same as
  // Jira Data Center/Server 8.14+'s own PAT support. Never hardcode the token itself here; it must
  // only ever come from the environment (server/.env, which is git-ignored).
  const jiraToken = process.env.JIRA_API_TOKEN;
  if (!jiraToken) {
    throw new Error('JIRA_API_TOKEN not set — cannot authenticate to jira.synnex.com');
  }
  const res = await fetch(jiraLink, {
    headers: { Authorization: `Bearer ${jiraToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Jira returned HTTP ${res.status}`);
  const data = await res.json();
  const summary = data?.fields?.summary || '';
  const description = data?.fields?.description || '';
  const descriptionFields = parseJiraDescriptionFields(description);
  const failedTestcase = descriptionFields.get('Failed Testcase') || '';
  const failureMessage = extractJiraFullFailureMessage(description);
  // Same "*Label:* value" field the ticket carries "Failed Testcase"/"Failure Message" in — used
  // by describeJiraFlow below to route E5-2c/E6-2c units to their own chassis layout page instead
  // of the default B300 visualizer.
  const model = descriptionFields.get('Model') || '';
  // When present, the main route handler runs the full normal command flow (eve_ip -> Open_Problems
  // -> fmadm -> hwdiag -> every targeted check) against this fixture unit BEFORE the entered/UUT
  // serialNumber (see isFixturePass/effectiveSn below) — some tickets, especially UPDATE_GXR3_FW
  // ones, are filed against a test fixture rather than the unit itself. Empty string (not present,
  // same as every other field here) whenever this ticket has no such field, which is the common
  // case — the request then proceeds exactly as if fixtureSn didn't exist.
  const fixtureSn = descriptionFields.get('Fixture SN') || '';
  // The technician's own diagnostic transcript (e.g. an ILOM/hwdiag session pasted while
  // documenting the fault) can live either in the ticket's comments, or directly in the
  // Description's own Failure Message field (confirmed against a real captured Failure Message
  // carrying a full hwdiag_io_cables/hwdiag_io_config transcript) — concatenate every comment's
  // "body" (the Jira API's field name for that comment's text) plus failureMessage so
  // parseHwdiagIoCableFaults/parseHwdiagIoConfigBayFaults scan both regardless of which field a
  // given ticket happens to put it in. Safe to combine for these two specifically since they only
  // ever match a fully-structured "...Check Result: FAIL" block, not a loose keyword — unlike the
  // generic mention scan below, there's no false-positive risk from also scanning comments.
  const commentsText = (data?.fields?.comment?.comments || []).map((c) => c.body || '').join('\n\n');
  const hwdiagTranscriptText = `${commentsText}\n\n${failureMessage}`;
  const cableFaultsResult = parseHwdiagIoCableFaults(hwdiagTranscriptText);
  const bayFaultsResult = parseHwdiagIoConfigBayFaults(hwdiagTranscriptText);
  // Deliberately scoped to *only* the Failure Message field, not summary/description/comments — a
  // technician's comment often quotes a full "hwdiag io config"/"hwdiag io cables" session (see
  // parseHwdiagIoCableFaults above), which lists every IOU/PCIe connector on the chassis as normal
  // inventory, not faults. Scanning that broadly for a bare "IOU3"/"PCIE300"-style mention produced
  // a wall of false positives for perfectly healthy parts. The Failure Message field is the one
  // place the ticket actually states what's wrong (e.g. "only IOU6 is MISSING"), so that's the only
  // text these two parsers should ever see.
  const iouFruResult = parseIouFruPositionFaults(failureMessage);
  const mentionsResult = parseGenericPartMentions(failureMessage, iouFruResult.matchedTokens);
  return {
    key: data.key || jiraLink,
    summary,
    failedTestcase,
    failureMessage,
    model,
    fixtureSn,
    // "Failed Testcase" is itself usually a "<N>_<CHECKNAME>" code (e.g. "11_POWER_ON") — scan it
    // alongside the summary, since some tickets only carry the code in one place or the other.
    checkCodes: extractJiraCheckCodes(`${summary}\n${failedTestcase}`),
    commentsText,
    // Merge every parser's hits into one faults object — describeJiraFlow below treats any
    // genericError here as "this ticket already documents a fault, skip the ILOM chain" regardless
    // of which parser produced it. Order matters: the specific CHECK_IOU_FRU message goes first so
    // it's what a technician sees before the looser, less-confident bare "IOU6" mention.
    cableFaults: {
      ...cableFaultsResult.faults,
      genericErrors: [
        ...cableFaultsResult.faults.genericErrors,
        ...bayFaultsResult.faults.genericErrors,
        ...iouFruResult.faults.genericErrors,
        ...mentionsResult.faults.genericErrors,
      ],
      // bayFaultsResult is the only one of these that ever populates pcieFaults (a bay that lost
      // its expected module — see parseHwdiagIoConfigBayFaults) — without this, the base
      // ...cableFaultsResult.faults spread above would silently overwrite it with [], since that
      // parser never touches pcieFaults itself.
      pcieFaults: [...cableFaultsResult.faults.pcieFaults, ...bayFaultsResult.faults.pcieFaults],
      components: [...new Set([
        ...cableFaultsResult.faults.components,
        ...bayFaultsResult.faults.components,
        ...iouFruResult.faults.components,
      ])],
    },
  };
}

// E5-2c/E6-2c units (real Jira Model values seen: "E5-2C.DENSE", "E6-2c", "ORACLE SERVER E6-2c")
// route to a different chassis-layout page client-side (client/src/pages/E5E6Overview.jsx) instead
// of the default B300 visualizer — this chassis is physically a 10-IOU/3-fan/2-PSU 2U unit, not
// the B300's GBB/GPU-baseboard/IOB/PSU layout. The B300/JBOG chassis's own model string (e.g.
// "X11-2C.B300H") never contains the literal substring "E5-2C"/"E6-2C" at all, so this can't
// false-match it regardless of the trailing \b.
const E5_E6_MODEL_RE = /E[56]-2C\b/i;

// Returns null if no jiraLink was given, or if fetching/parsing it failed for any reason — in
// both cases the caller falls through to the normal mfg-collector-cache-based describeDefaultFlow
// below, same as if this feature didn't exist. Otherwise returns the same {notice, sourceTag,
// targetedCheckName} shape describeDefaultFlow produces (plus an optional resolvedFaults/
// resolvedRaw pair — see below), so both GET /precheck and the main GET / handler can treat a
// Jira-derived decision identically to a mfg-collector one, just sourced from a higher-priority
// place (a specific repair ticket rather than the live JBOG test table, which only ever covers
// the small subset of units currently mid-manufacturing-test). Every branch also carries
// chassisModel/isE5E6Chassis (see E5_E6_MODEL_RE above) since any of them can be the one that
// actually reaches the client — the main GET / handler below surfaces these on {type:'done'} so
// App.jsx knows which page component to render regardless of which branch decided the flow.
async function describeJiraFlow(jiraLink) {
  if (!jiraLink) return null;
  let info;
  try {
    info = await fetchJiraCheckInfo(jiraLink);
  } catch (err) {
    console.warn('[diagnose] Jira link fetch/parse failed, falling back to mfg-collector:', err.message);
    return null;
  }
  const chassisModel = info.model || null;
  const isE5E6Chassis = E5_E6_MODEL_RE.test(info.model || '');

  // A technician's pasted diag-shell session already contains the actual fault (e.g. the swapped
  // cable Cable#13/#14 mismatch) — that's a completed diagnosis, not a hint to go run more checks,
  // so this takes priority even over a targeted-check match below: resolvedFaults tells the main
  // handler to return it directly instead of opening any ILOM session at all.
  const hasTicketFaults = info.cableFaults.genericErrors.length > 0;
  if (hasTicketFaults) {
    return {
      notice: `Jira ${info.key}: fault(s) already documented in the ticket's comments — using them directly, skipping the ILOM chain…`,
      sourceTag: `jira ${info.key} (parsed from ticket comments)`,
      targetedCheckName: null,
      resolvedFaults: info.cableFaults,
      resolvedRaw: info.commentsText,
      chassisModel, isE5E6Chassis, fixtureSn: info.fixtureSn,
    };
  }

  // "POWER_ON" (e.g. a "Failed Testcase: 11_POWER_ON" description field, or the
  // HOST_POWER_ON_PRETEST stage) is matched by exact checkName below when it fits the numbered
  // <N>_<CHECKNAME> shape, but not every ticket phrases it that way — scan the summary, the
  // description's Failed Testcase/Failure Message fields, and the comments directly so none of
  // those shapes get missed.
  if ([info.summary, info.failedTestcase, info.failureMessage, info.commentsText].some((s) => /POWER_ON/i.test(s))) {
    return { notice: null, sourceTag: `jira ${info.key} -> CHECK_POWER_ON`, targetedCheckName: 'CHECK_POWER_ON', chassisModel, isE5E6Chassis, fixtureSn: info.fixtureSn };
  }

  const targetedMatch = info.checkCodes.find((c) => MFG_COLLECTOR_TARGETED_CHECKS[c.checkName]);
  if (targetedMatch) {
    return { notice: null, sourceTag: `jira ${info.key} -> ${targetedMatch.checkName}`, targetedCheckName: targetedMatch.checkName, chassisModel, isE5E6Chassis, fixtureSn: info.fixtureSn };
  }
  if (info.checkCodes.length > 0) {
    const codeList = info.checkCodes.map((c) => `${c.checkNumber}_${c.checkName}`).join(', ');
    return {
      notice: `Jira ${info.key}: "${info.summary}" — ${codeList}, no targeted diagnostic flow yet for ` +
        `${info.checkCodes.length > 1 ? 'these checks' : 'this check'} — running the default ILOM diagnostic chain instead…`,
      sourceTag: 'jira-no-targeted-flow',
      targetedCheckName: null,
      chassisModel, isE5E6Chassis, fixtureSn: info.fixtureSn,
    };
  }
  return {
    notice: `Jira ${info.key}: "${info.summary}" — no recognizable check code in the summary, running the default ILOM diagnostic chain…`,
    sourceTag: 'jira-no-check-code',
    targetedCheckName: null,
    chassisModel, isE5E6Chassis, fixtureSn: info.fixtureSn,
  };
}

// Pure, synchronous (no I/O) read of the in-memory mfg-collector cache — the same decision the
// real GET / handler below makes in its non-forceCheck branch, extracted so GET /precheck can
// report it instantly. The full diagnose request takes tens of seconds (ILOM SSH round-trips);
// this lets the client show an accurate "why is this taking a while" status (e.g. "No
// mfg-collector record found...") the moment the request starts, in place of a generic "Running
// diagnostics…" placeholder, without waiting for the whole chain to finish.
function describeDefaultFlow(serialNumber, skipCollector) {
  if (skipCollector) {
    return { notice: 'skipCollector requested — bypassing mfg-collector, running the default ILOM diagnostic chain…', sourceTag: 'skipCollector', targetedCheckName: null };
  }

  // mfgCollectorCacheUpdatedAt only ever gets set after a *successful* refresh — if it's still
  // null, the cache has never loaded even once (confirmed on real hardware: a too-tight fetch
  // timeout left it permanently empty). A cache miss in that state says nothing about whether
  // serialNumber is actually in the real table, so it must not be reported as "not found" — that
  // claims something specific about the table's contents that was never actually checked.
  if (!mfgCollectorCacheUpdatedAt) {
    return {
      notice: `mfg-collector cache has not loaded yet (no successful refresh since server start) — running the default ILOM diagnostic chain without an mfg-collector check…`,
      sourceTag: 'collector-unavailable',
      targetedCheckName: null,
    };
  }

  const collectorStatus = mfgCollectorCache.get(serialNumber.toUpperCase()) || null;

  if (collectorStatus?.failing && !collectorStatus.ilomObservable) {
    const targetedCheckName = MFG_COLLECTOR_TARGETED_CHECKS[collectorStatus.checkName] ? collectorStatus.checkName : null;
    if (targetedCheckName) {
      return { notice: null, sourceTag: `mfg-collector -> ${targetedCheckName}`, targetedCheckName };
    }
    return {
      notice: `mfg-collector: ${serialNumber} failing ${collectorStatus.stage || collectorStatus.board} — ` +
        `${collectorStatus.checkNumber}_${collectorStatus.checkName} (${collectorStatus.duration}), ` +
        `no targeted diagnostic flow yet for this check — running the default ILOM chain instead…`,
      sourceTag: 'no-targeted-flow',
      targetedCheckName: null,
    };
  }
  if (collectorStatus?.failing && collectorStatus.ilomObservable) {
    return {
      notice: `mfg-collector: ${serialNumber} failing ${collectorStatus.checkNumber}_${collectorStatus.checkName} — ` +
        `ILOM-observable, running the default ILOM diagnostic chain to find it…`,
      sourceTag: 'ilom-observable',
      targetedCheckName: null,
    };
  }
  if (!collectorStatus) {
    return {
      notice: `No mfg-collector record found for ${serialNumber} — running the default ILOM diagnostic chain…`,
      sourceTag: 'no-collector-record',
      targetedCheckName: null,
    };
  }
  // Found and passing — a real match (mfg-collector confirms it's fine), not a "no match" case.
  return { notice: null, sourceTag: null, targetedCheckName: null };
}

// Lets the client ask "what will GET / do for this SN?" before paying for the full request, so
// the loading state can show an accurate status (Jira match, mfg-collector match, or "no record
// found") in place of a generic spinner message. Mostly a read of already-cached state — no ILOM
// session, no targeted-check script execution — so it resolves quickly regardless of what it
// reports; the one exception is a supplied jiraLink, which costs one small, fast network fetch.
router.get('/precheck', async (req, res) => {
  const { serialNumber, skipCollector, forceCheck, jiraLink } = req.query;
  if (!serialNumber) return res.status(400).json({ error: 'serialNumber query param required' });
  if (!/^[a-zA-Z0-9]+$/.test(serialNumber)) {
    return res.status(400).json({ error: 'Invalid serial number format' });
  }

  if (forceCheck) {
    if (!MFG_COLLECTOR_TARGETED_CHECKS[forceCheck]) {
      return res.status(400).json({ error: `No targeted check mapped for "${forceCheck}". Known checks: ${Object.keys(MFG_COLLECTOR_TARGETED_CHECKS).join(', ')}` });
    }
    return res.json({ notice: null, sourceTag: `forced -> ${forceCheck}`, targetedCheckName: forceCheck });
  }

  const flow = (await describeJiraFlow(jiraLink)) || describeDefaultFlow(serialNumber, skipCollector);
  // resolvedFaults/resolvedRaw (the Jira-ticket-comments case) aren't needed here — precheck only
  // reports status text, the real GET / below is what actually returns faults to the client.
  res.json({ notice: flow.notice, sourceTag: flow.sourceTag, targetedCheckName: flow.targetedCheckName });
});

router.get('/', async (req, res) => {
  const {
    serialNumber, ilomIp: ilomIpParam, skipCollector, forceCheck, jiraLink, bypassPowerState, bypassHostnicCheck,
    continueToDefault, continueToUut,
  } = req.query;
  if (!serialNumber) return res.status(400).json({ error: 'serialNumber query param required' });

  if (!/^[a-zA-Z0-9]+$/.test(serialNumber)) {
    return res.status(400).json({ error: 'Invalid serial number format' });
  }

  // Streams newline-delimited JSON events instead of collecting every result before responding
  // once. The default chain below now runs every diagnostic command unconditionally (per an
  // earlier change), and a single slow/timing-out one (confirmed on real hardware:
  // GXR3_update_check hanging past localExec's 30s timeout, SN 2630YW1049, 2026-07-24) used to
  // throw past every step below and land in the catch block, returning a 500 that discarded every
  // fault already found (e.g. a DIMM training failure fmadm had already surfaced). Now each step
  // reports its own fault fragment the moment it finishes — success or failure — and the chain
  // keeps going regardless, so the client can merge results in live instead of waiting on (and
  // being at the mercy of) the single slowest/flakiest command in the whole chain. NDJSON over a
  // chunked response rather than SSE/WebSocket: same-origin, one-directional, and this keeps
  // client-side parsing to "split on \n, JSON.parse each line" with no extra protocol.
  //   {type:'partial', label, faults, raw}   — merge `faults` into the running total immediately
  //   {type:'chassis', chassisModel, isE5E6Chassis} — sent the *instant* the chassis type becomes
  //                                            known, ahead of any partial that might follow — lets
  //                                            the client switch chassis pages before it renders a
  //                                            single fault, rather than rendering every partial on
  //                                            the wrong (default) page until the terminal event
  //                                            finally reveals the real chassis type
  //   {type:'fatal', error}                  — unrecoverable (e.g. ILOM down); stream ends after this
  //   {type:'confirm', message, resumeParam} — stream ends after this; ask the user whether to
  //                                            continue, and if so re-request with every previous
  //                                            query param plus ?<resumeParam>=1 (e.g.
  //                                            bypassPowerState, bypassHostnicCheck, or
  //                                            continueToDefault — the client doesn't need to know
  //                                            which, just resend it)
  //   {type:'done', source, defaultFlowNotice} — stream finished; these are the final status fields
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const sendPartial = (label, faults, raw) => res.write(`${JSON.stringify({ type: 'partial', label, faults, raw })}\n`);
  const sendChassisInfo = (chassisModel, isE5E6Chassis) => res.write(`${JSON.stringify({ type: 'chassis', chassisModel, isE5E6Chassis })}\n`);
  const sendFatal = (error) => res.write(`${JSON.stringify({ type: 'fatal', error })}\n`);
  const sendConfirm = (message, resumeParam) => res.write(`${JSON.stringify({ type: 'confirm', message, resumeParam })}\n`);
  const sendDone = (extra) => res.write(`${JSON.stringify({ type: 'done', ...extra })}\n`);
  const emptyFaults = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  // ?bypassPowerState=1 / ?bypassHostnicCheck=1 let the user skip runPowerOnCheck's own /SYS
  // power_state / HOSTNIC gates and get the hwdiag power-rail reading anyway. Passed unconditionally
  // to every targeted check below — a check that doesn't recognize a given key simply ignores it.
  const checkOptions = {
    bypassPowerState: bypassPowerState === '1' || bypassPowerState === 'true',
    bypassHostnicCheck: bypassHostnicCheck === '1' || bypassHostnicCheck === 'true',
  };
  // Runs one targeted check and reports it as a partial either way — a thrown error (e.g. a
  // localExec/runIlomSession timeout) becomes a genericErrors fragment naming the check instead of
  // aborting the rest of the chain, since every other check's findings are still valid and worth
  // keeping. Returns the full result ({faults, gateParam}) so callers can tell whether the check
  // actually found anything (see hasRealFinding below) and whether it stopped at a bypassable gate
  // (runPowerOnCheck's own power_state/HOSTNIC checks set gateParam when they do).
  // explicitNode is passed only from within the default chain's own per-node loop (see
  // runDefaultChainForNode further below), and only for a genuinely multi-node chassis (see
  // parseEveIpNodes) — it makes the resulting partial's label/faults tagged by node (see
  // tagFaultsWithNode). Omitted (the vast majority of calls — the targeted-check short-circuit
  // branch, the forceCheck path, and every single-node chassis's Step 3 sweep all call this with no
  // explicitNode), this behaves exactly as before: plain checkName label, untagged faults. See
  // reuseNode below for the separate, node-count-independent eve_ip-reuse concern.
  // targetSn/labelPrefix let a caller run this against a different unit than the entered
  // serialNumber (see the Fixture SN pre-pass further below) without duplicating this function —
  // both default to today's exact behavior, so the forceCheck/targetedCheckName short-circuit
  // callers (which never pass either) are completely unaffected.
  //
  // explicitNode vs reuseNode: explicitNode only controls per-node LABEL/fault tagging (must stay
  // null for a single-node chassis — tagFaultsWithNode is a genuinely multi-node-only concept, see
  // its own comment). reuseNode is the node data actually handed to the targeted check so it skips
  // its own eve_ip.pyc call — defaulting it to explicitNode preserves today's exact behavior for
  // every existing caller, but the default chain's Step 3 sweep below passes reuseNode explicitly
  // (the resolved node, always) even on a single-node chassis, since Step 1 already paid for that
  // exact same eve_ip lookup moments earlier; re-deriving it again per targeted check was pure
  // waste (confirmed harmless to skip since runPowerOnCheck/runHostnicCheck only ever gate on
  // whether a node was already given, never on how many nodes the chassis has).
  const runAndReportCheck = async (checkName, targetedCheck, explicitNode = null, targetSn = serialNumber, labelPrefix = '', reuseNode = explicitNode) => {
    const label = `${labelPrefix}${explicitNode ? `${explicitNode.label} ${checkName}` : checkName}`;
    try {
      const result = await targetedCheck(targetSn, checkOptions, reuseNode);
      const faults = explicitNode ? tagFaultsWithNode(result.faults, explicitNode) : result.faults;
      sendPartial(label, faults, result.raw);
      return result;
    } catch (err) {
      console.error(`[diagnose] targeted check ${checkName} failed for ${targetSn}:`, err.message);
      const rawFaults = { ...emptyFaults, genericErrors: [`${checkName} check failed: ${err.message}`] };
      const faults = explicitNode ? tagFaultsWithNode(rawFaults, explicitNode) : rawFaults;
      sendPartial(label, faults, err.message);
      return { faults };
    }
  };

  // Deliberately excludes genericErrors — confirmed on real hardware (SN 2629YW10F0, 2026-07-28):
  // CHECK_POWER_ON (with bypassPowerState) came back with zero components/psuPorts/etc. and only
  // a genericErrors note ("host is not powered on, PS0/PS1 reading 0A/0V is expected") explaining
  // *why* nothing else was checked. Treating that as "a real answer, stop here" (the first version
  // of this fix did) meant the default chain never got a chance to actually check anything for
  // that unit. A plain informational/explanatory message on its own isn't a part-level finding —
  // only components/psuPorts/retimerIds/e1sIds/pcieFaults/fanIds/cableFaults/pcieSwitchIds/dimmIds
  // count as "the targeted check actually found something", so genericErrors-only results now
  // fall through too (the message itself is still kept — see sendPartial in runAndReportCheck).
  const hasRealFinding = (f) => !!f && [
    'components', 'psuPorts', 'retimerIds', 'e1sIds', 'pcieFaults', 'fanIds',
    'cableFaults', 'pcieSwitchIds', 'dimmIds',
  ].some((key) => (f[key] || []).length > 0);

  try {
    // ?forceCheck=<checkName> runs a specific targeted check directly, regardless of what the
    // mfg-collector cache currently says (or whether the SN is in it at all) — the cache is a
    // live, rolling view, so a SN you know is actually affected by a given check may have already
    // aged out of it by the time you test through the app. Takes full precedence over everything
    // else below, including skipCollector.
    if (forceCheck) {
      const targetedCheck = MFG_COLLECTOR_TARGETED_CHECKS[forceCheck];
      if (!targetedCheck) {
        sendFatal(`No targeted check mapped for "${forceCheck}". Known checks: ${Object.keys(MFG_COLLECTOR_TARGETED_CHECKS).join(', ')}`);
        return res.end();
      }
      console.log(`[diagnose] forceCheck=${forceCheck} set, running its targeted check directly for ${serialNumber}, bypassing mfg-collector entirely`);
      const forcedResult = await runAndReportCheck(forceCheck, targetedCheck);
      sendDone({
        source: `forced -> ${forceCheck}`,
        ...(forcedResult.chassisModel ? { chassisModel: forcedResult.chassisModel, isE5E6Chassis: forcedResult.isE5E6Chassis } : {}),
      });
      return res.end();
    }

    // Step 0: check the Jira ticket (if supplied) first, then the mfg-collector cache (populated
    // by the background poller above, not fetched live — the real page takes ~45s, too slow to
    // pay per-request) before opening any ILOM SSH session. Jira takes priority when given —
    // mfg-collector's live JBOG test table only ever covers the small subset of units currently
    // mid-manufacturing-test, so a unit already routed to repair (like the one this feature was
    // built for) is often only findable via its own Jira ticket, not the table. If it already
    // knows this SN is failing a check the ILOM chain below can't see, report that directly
    // instead of paying for a full SSH round-trip that won't find anything. A miss in both (no
    // jiraLink, or a jiraLink whose fetch/parse failed, and no mfg-collector record either) just
    // falls through to the normal flow below, same as if this feature didn't exist.
    // ?skipCollector=1 forces that fallthrough for the mfg-collector cache specifically (it has no
    // effect on a supplied jiraLink, which still takes priority when successfully fetched).
    //
    // Whenever nothing above matched a specific targeted check — no mfg-collector record at all,
    // a record that's failing a check the ILOM chain happens to cover anyway, or a failing check
    // with no dedicated script yet — that's not a reason to skip diagnostics, but the user should
    // still be told the default/generic ILOM chain (Open_Problems -> fmadm -> hwdiag -> every
    // targeted check) is what's running and why, instead of it looking identical to a real
    // targeted-check match. defaultFlowNotice is surfaced as its own response field (see Step 3
    // below) so the UI can show it — see also GET /precheck above, which reports the exact same
    // notice/sourceTag before this handler even opens an ILOM SSH session, letting the client
    // show it immediately instead of only after this whole request finishes.
    console.log('[diagnose] mfg-collector cache lookup for', serialNumber, '(cache last updated', mfgCollectorCacheUpdatedAt, ')', jiraLink ? `— jiraLink also supplied: ${jiraLink}` : '');
    const jiraFlow = await describeJiraFlow(jiraLink);
    let {
      notice: defaultFlowNotice, sourceTag: defaultFlowSourceTag, targetedCheckName, resolvedFaults, resolvedRaw,
    } = jiraFlow || describeDefaultFlow(serialNumber, skipCollector);
    // Seeded from describeJiraFlow (describeDefaultFlow has no Model field to read, since
    // mfg-collector's JBOG table doesn't carry one) but reassigned below (`let`, not `const`)
    // whenever CHECK_POWER_ON actually runs and reads the live "show /SYS" product_name — that's
    // the primary, always-available detection path (works with no Jira link at all); the Jira
    // Model field is only a fallback for a request that never reaches CHECK_POWER_ON. See
    // E5_E6_MODEL_RE and runPowerOnCheck's own product_name parsing above.
    let chassisModel = jiraFlow?.chassisModel ?? null;
    let isE5E6Chassis = jiraFlow?.isE5E6Chassis ?? false;
    // Sent the instant the chassis type is (re)confirmed — a Jira Model field known before any
    // ILOM session even opens, or a later live "show /SYS" reading — so the client can switch
    // pages before a single fault partial renders on the wrong one. Guarded so an unchanged value
    // (e.g. Jira already said E6-2c and the live read just confirms it) doesn't resend needlessly.
    if (chassisModel) sendChassisInfo(chassisModel, isE5E6Chassis);
    // Applied after every targeted-check call below — a check that doesn't set chassisModel
    // (everything except CHECK_POWER_ON) leaves the current value untouched. Only announces when
    // the value actually changes, per the guard above.
    const adoptLiveChassisModel = (result) => {
      if (result?.chassisModel && result.chassisModel !== chassisModel) {
        chassisModel = result.chassisModel;
        isE5E6Chassis = result.isE5E6Chassis;
        sendChassisInfo(chassisModel, isE5E6Chassis);
      }
    };
    if (resolvedFaults) {
      console.log(`[diagnose] ${defaultFlowSourceTag} — fault(s) already documented in the ticket's comments, using them directly instead of opening an ILOM session`);
      sendPartial(defaultFlowSourceTag, resolvedFaults, resolvedRaw);
      sendDone({ source: defaultFlowSourceTag, chassisModel, isE5E6Chassis });
      return res.end();
    }
    // A Fixture SN takes priority over everything below: run the full normal command flow (eve_ip
    // -> Open_Problems -> fmadm -> hwdiag -> every targeted check) against the FIXTURE first, then
    // ask whether to also run it for the UUT itself — same resumeParam pattern as
    // continueToDefault above, just gating the fixture-vs-UUT choice instead of
    // targeted-check-vs-default-chain. ?continueToUut=1 is how the client re-requests after
    // answering "yes" to that prompt; at that point isFixturePass is false and everything below
    // proceeds exactly as if fixtureSn didn't exist. effectiveSn (used everywhere below in place
    // of serialNumber for eve_ip and every targeted-check call) is the fixture's SN during that
    // first pass, the real UUT serialNumber on every other request.
    const isFixturePass = !!jiraFlow?.fixtureSn && !(continueToUut === '1' || continueToUut === 'true');
    const effectiveSn = isFixturePass ? jiraFlow.fixtureSn : serialNumber;
    const fixtureLabelPrefix = isFixturePass ? `FIXTURE ${effectiveSn}: ` : '';
    if (isFixturePass) {
      console.log(`[diagnose] Jira ticket carries a Fixture SN (${effectiveSn}) — running the full normal command flow against it before ${serialNumber} itself`);
    }
    // ?continueToDefault=1 is how the client re-requests after the user answers "yes" to the
    // confirm prompt below — skips straight past the targeted-check short-circuit into the
    // default chain (which unconditionally re-sweeps every targeted check in Step 3 anyway, so
    // there's no need to run it again here first). isFixturePass also forces this, since a Fixture
    // SN pre-pass is specifically about the *normal command flow*, not a single targeted check —
    // skippedViaContinueToDefault (not the combined skipTargetedCheck) gates the
    // defaultFlowNotice/defaultFlowSourceTag rewrite further below, so the fixture pass doesn't
    // misreport itself as "the user confirmed running the full chain" when no such confirm ever
    // happened for it.
    const skippedViaContinueToDefault = continueToDefault === '1' || continueToDefault === 'true';
    const skipTargetedCheck = skippedViaContinueToDefault || isFixturePass;
    if (targetedCheckName && !skipTargetedCheck) {
      console.log(`[diagnose] ${defaultFlowSourceTag} — running its targeted check instead of the generic ILOM chain`);
      const targetedResult = await runAndReportCheck(targetedCheckName, MFG_COLLECTOR_TARGETED_CHECKS[targetedCheckName]);
      const targetedFaults = targetedResult.faults;
      adoptLiveChassisModel(targetedResult);

      // The check stopped at a bypassable gate (runPowerOnCheck's own power_state/HOSTNIC checks —
      // see gateParam) without that bypass already being active. Ask specifically whether to keep
      // running *this* targeted check past the gate, before considering the broader default chain
      // at all — a "no" here just means stop, not "ask about the default chain instead" (see below,
      // reached only when no gate was hit this time).
      if (targetedResult.gateParam && !checkOptions[targetedResult.gateParam]) {
        console.log(`[diagnose] ${targetedCheckName} stopped at a gate (${targetedResult.gateParam}) for ${serialNumber} — asking whether to keep running the targeted check`);
        let gateNote = (targetedFaults?.genericErrors || []).join(' ') || `${targetedCheckName} stopped early`;
        if (!/[.?!]$/.test(gateNote)) gateNote += '.';
        sendConfirm(`${gateNote} Keep running the targeted check anyway?`, targetedResult.gateParam);
        return res.end();
      }

      // The targeted check ran to completion this time (found a real fault, found nothing, or ran
      // after a gate bypass) — in general, always ask whether to also continue to the default
      // diagnostic chain, regardless of what this one check found, since any single targeted check
      // only ever covers its own narrow slice (e.g. CHECK_POWER_ON never looks at fans/DIMMs/PCIe).
      console.log(`[diagnose] ${targetedCheckName} finished for ${serialNumber} — asking whether to continue to the default ILOM diagnostic chain`);
      let continueNote;
      if (hasRealFinding(targetedFaults)) {
        continueNote = `${targetedCheckName} found a fault (${(targetedFaults.components || []).join(', ') || 'see details above'}).`;
      } else {
        continueNote = (targetedFaults?.genericErrors || []).join(' ') || `${targetedCheckName} found no fault`;
        if (!/[.?!]$/.test(continueNote)) continueNote += '.';
      }
      sendConfirm(`${continueNote} Continue to the default diagnostic chain (Open_Problems -> fmadm -> hwdiag -> every targeted check)?`, 'continueToDefault');
      return res.end();
    }
    if (skipTargetedCheck && targetedCheckName) {
      defaultFlowNotice = `Continuing to the default ILOM diagnostic chain — ${targetedCheckName} found nothing and the user confirmed running the full chain…`;
      defaultFlowSourceTag = `${defaultFlowSourceTag}-user-confirmed-continue`;
    }
    console.log(`[diagnose] ${defaultFlowSourceTag || 'collector-passing'}: ${defaultFlowNotice || `${serialNumber} mfg-collector-confirmed passing`} — for ${serialNumber}`);

    // The real default/generic command flow now runs every known diagnostic command
    // unconditionally — Open_Problems/fmadm/hwdiag below, plus every targeted check in Step 3's
    // loop (the OSFP loopback check lionking_OSFP.py, the GXR3 firmware check
    // gxr3_fw_update_check, and the POWER_ON power-rail check runPowerOnCheck) — not just the ones
    // a mfg-collector/Jira match happened to name.

    // Step 1: check ILOM status via eve_ip unconditionally — even when ilomIpParam was already
    // supplied (e.g. by /validate-sn, whose own ILOM regex only checks that an ILOM row exists,
    // not that its status is "up" — see server/src/routes/validateSn.js). Skipping this check
    // whenever an IP was already known used to mean a down ILOM never got flagged here at all:
    // the SSH session below would simply fail to connect, but connection-refused/unreachable
    // text doesn't match any fault pattern, so parseIlomProblems returned zero faults and the
    // user saw a misleading "No open problems detected." instead of being told the ILOM is down.
    //
    // eve_ip can also return *two* nodes for a chassis that physically hosts two independent
    // server nodes (see parseEveIpNodes) — isMultiNode branches into its own handling below;
    // everything in the single-node branch is byte-for-byte the same as before this existed.
    // effectiveSn is the Fixture SN during the fixture pre-pass (see isFixturePass above), the
    // real UUT serialNumber on every other request.
    const eveOut = await localExec(`python3 /home/tester/WesleyH/eve_ip.pyc ${effectiveSn}`);
    console.log('[diagnose] eve_ip raw output:\n', eveOut);
    const eveNodes = parseEveIpNodes(eveOut);
    const isMultiNode = eveNodes.length > 1;
    if (isMultiNode) {
      console.log(`[diagnose] eve_ip: ${effectiveSn} is a dual-node chassis (${eveNodes.map((n) => `${n.label}=${n.nodeSn}`).join(', ')})`);
    }

    // A lookup failure for the FIXTURE (unreachable/down ILOM, no eve_ip row at all) must not
    // abort the whole request — the user still needs the chance to say "continue to the UUT
    // anyway" below. Only a failure for the real UUT (isFixturePass false) is genuinely fatal, same
    // as always. Returns true when the caller should stop (res.end() immediately after a real
    // sendFatal); false means it degraded to a partial and the flow should carry on toward the
    // fixture-vs-UUT confirm at the end with reachableNodes left empty.
    const failEveIpLookup = (message) => {
      if (isFixturePass) {
        sendPartial(`${fixtureLabelPrefix}eve_ip`, { ...emptyFaults, genericErrors: [message] }, eveOut);
        return false;
      }
      sendFatal(message);
      return true;
    };

    let reachableNodes;
    if (!isMultiNode) {
      const node = eveNodes[0];
      if (!node.ilomIp) {
        console.log(`[diagnose] eve_ip: no ILOM row matched for ${effectiveSn}`);
        if (failEveIpLookup(`No ILOM interface found for ${effectiveSn} in eve_ip output: ${eveOut.trim()}`)) return res.end();
        reachableNodes = [];
      } else if (!/^up$/i.test(node.ilomStatus)) {
        console.log(`[diagnose] eve_ip: ILOM status "${node.ilomStatus}" is not up for ${effectiveSn}`);
        if (failEveIpLookup(`ILOM for ${effectiveSn} is reported ${node.ilomStatus.toUpperCase()} (IP ${node.ilomIp}) by eve_ip — cannot run diagnostics until it is back up`)) return res.end();
        reachableNodes = [];
      } else {
        console.log(`[diagnose] eve_ip: ILOM row matched — IP ${node.ilomIp}, status "${node.ilomStatus}"`);
        // ilomIpParam comes from /validate-sn, which only ever resolves the entered/UUT
        // serialNumber's own IP — applying it during the fixture pass would silently point the
        // fixture's session at the UUT's ILOM instead.
        if (ilomIpParam && !isFixturePass) node.ilomIp = ilomIpParam;
        console.log('[diagnose] ILOM IP:', node.ilomIp, (ilomIpParam && !isFixturePass) ? '(from validation, confirmed up via eve_ip)' : '(from eve_ip)');
        reachableNodes = [node];
      }
    } else {
      // An unreachable node is reported as its own partial rather than aborting a node that IS
      // reachable — a dual-node chassis where only one node is actually down still deserves full
      // diagnostics for the other. ilomIpParam (from /validate-sn) never applies here: that
      // endpoint's own ILOM regex only ever resolves a single-ILOM unit's IP.
      reachableNodes = [];
      for (const node of eveNodes) {
        if (!node.ilomIp) {
          console.log(`[diagnose] eve_ip: no ${node.label} row matched for ${effectiveSn}`);
          sendPartial(`${fixtureLabelPrefix}${node.label}`, { ...emptyFaults, genericErrors: [`No ${node.label} interface found for ${effectiveSn} (node ${node.nodeSn}) in eve_ip output`] }, eveOut);
          continue;
        }
        if (!/^up$/i.test(node.ilomStatus)) {
          console.log(`[diagnose] eve_ip: ${node.label} status "${node.ilomStatus}" is not up — skipping this node`);
          sendPartial(`${fixtureLabelPrefix}${node.label}`, { ...emptyFaults, genericErrors: [`${node.label} (node ${node.nodeSn}) is reported ${node.ilomStatus.toUpperCase()} — skipping diagnostics for this node until it is back up`] }, eveOut);
          continue;
        }
        reachableNodes.push(node);
      }
      if (reachableNodes.length === 0) {
        if (failEveIpLookup(`No reachable ILOM found for ${effectiveSn} across ${eveNodes.length} nodes in eve_ip output: ${eveOut.trim()}`)) return res.end();
      }
    }

    const ilomUser = process.env.ILOM_USER || 'root';
    const ilomPassword = process.env.ILOM_PASSWORD || 'changeme';

    // Steps 1.5/2/3 (chassis identification, Open_Problems, fmadm/hwdiag/every targeted check) —
    // extracted into a per-node function so a dual-node chassis runs the *exact same procedure*
    // against each of its nodes independently, matching single-ILOM behavior for each. Every
    // sendPartial label and fault is tagged by node (tagLabel/tagFaults, both no-ops when
    // isMultiNode is false) so the B300 visualizer's fault banners always say which physical
    // node/ILOM a finding came from once there's more than one to distinguish.
    const runDefaultChainForNode = async (node) => {
      const ilomIp = node.ilomIp;
      const tagLabel = (label) => `${fixtureLabelPrefix}${isMultiNode ? `${node.label} ${label}` : label}`;
      const tagFaults = (faults) => (isMultiNode ? tagFaultsWithNode(faults, node) : faults);
      const nodeSuffix = isMultiNode ? ` (${node.label})` : '';

      // Step 1.5: identify the chassis type before any fault data streams to the client — run as
      // its own dedicated session (not combined into Step 2's Open_Problems session below) so its
      // output never shares a parsing buffer with anything parseIlomProblems scans. A shared
      // buffer once caused parseIlomProblems to false-positive on every PSU in an unrelated temp
      // dump (see diagnose_parser_isolation memory) — "show /SYS"'s own Targets listing carries
      // enough bare component names (IOU3, IOU6, ...) that feeding it into that same scan risked
      // the same class of bug. Kept deliberately minimal (just this one read) and non-fatal: a
      // failure here just means the chassis type stays whatever Jira already said (or unknown),
      // it doesn't abort the rest of the chain.
      try {
        const identOut = await runIlomSession([
          { line: 'show /SYS', delayAfterMs: 1500 },
          { line: 'exit', delayAfterMs: 750 },
        ], ilomIp, ilomUser, ilomPassword, 10000);
        const productNameMatch = identOut.match(/product_name\s*=\s*(.+)/i);
        // Never adopt the FIXTURE's own chassis type — it's a different physical unit that may
        // well be a different chassis model than the UUT, and chassisModel/isE5E6Chassis drives
        // which page the client renders (B300 vs E5-2c/E6-2c) for the UUT currently on screen.
        if (productNameMatch && !isFixturePass) {
          adoptLiveChassisModel({
            chassisModel: productNameMatch[1].trim(),
            isE5E6Chassis: E5_E6_MODEL_RE.test(productNameMatch[1].trim()),
          });
        }
      } catch (err) {
        console.error(`[diagnose] chassis identification (show /SYS) failed for ${effectiveSn}${nodeSuffix}:`, err.message);
      }

      // Step 2: SSH to ILOM using native ssh + sshpass. Passing the command as an ssh remote-
      // command *argument* (`ssh ... 'show /System/Open_Problems'`) was observed to hang
      // indefinitely on some devices even with -tt forcing a pty — this ILOM's restricted CLI
      // apparently doesn't reliably support that invocation mode. A manual/interactive session
      // (connect, then type the command) works fine, so run it the same way: open a bare
      // session and write the command to stdin via runIlomSession, matching tier 2/3. A
      // trailing "exit" is required too — closing stdin (EOF) alone does not make this CLI log
      // out and close the connection, it just sits at the prompt until the timeout kills it,
      // even when the actual command already succeeded and returned a complete result.
      //
      // Each of Step 2/3's SSH sessions below is wrapped in its own try/catch and reported as a
      // partial either way, same reasoning as runAndReportCheck above — a timeout on any one of
      // them (Open_Problems, fmadm, or the hwdiag session) must not discard whatever the others
      // already found or are still about to find.
      //
      // The generic fan-capacity fallback (see parseIlomProblems' fanCapacityAlert) can't be
      // judged from Open_Problems/fmadm alone — only hwdiag (parsed further below) knows the
      // chassis type and which fan/PSU bays are actually populated — so it's held back here
      // instead of being sent as its own partial immediately, and only resolved once hwdiag's
      // result (or failure) is known.
      let fanCapacityAlertPending = false;
      let hwdiagOut = null;
      try {
        const ilomOut = await runIlomSession(
          [
            { line: 'show /System/Open_Problems', delayAfterMs: 2500 },
            { line: 'exit', delayAfterMs: 750 },
          ],
          ilomIp, ilomUser, ilomPassword, 15000
        );
        console.log(`[diagnose] ILOM raw output${nodeSuffix}:\n`, ilomOut);
        const openProblemsParsed = parseIlomProblems(ilomOut);
        console.log('[diagnose] parsed faults:', JSON.stringify(openProblemsParsed.faults));
        if (openProblemsParsed.fanCapacityAlert) fanCapacityAlertPending = true;
        sendPartial(tagLabel('Open_Problems'), tagFaults(openProblemsParsed.faults), ilomOut);
      } catch (err) {
        console.error(`[diagnose] Open_Problems check failed for ${effectiveSn}${nodeSuffix}:`, err.message);
        sendPartial(tagLabel('Open_Problems'), tagFaults({ ...emptyFaults, genericErrors: [`Open_Problems check failed: ${err.message}`] }), err.message);
      }

      // Step 3: run every remaining diagnostic tier unconditionally and merge all findings,
      // rather than stopping at the first tier that finds something — a unit can have more than
      // one real problem at once (e.g. a fabric-test PCIe failure *and* a GXR3 firmware failure),
      // and stopping early would silently hide whichever one didn't happen to run first. This is
      // deliberately slow (every diagnosis now pays for every check, every time) in exchange for
      // completeness.
      //
      // fmadm and hwdiag are run as two separate sessions (rather than one combined session/
      // buffer) so each output is parsed in isolation. parseIlomProblems's "/SYS/PS<n>" regex
      // matches any mention of a PSU resource, not just faulted ones — running it against a
      // buffer that also contains the hwdiag temp/fan dumps previously caused every PSU listed
      // in "hwdiag temp get all" (regardless of its actual reading) to be misreported as
      // faulted, instead of only the ones genuinely at 0.00 deg C.
      console.log(`[diagnose] running fmadm faulty -a / hwdiag io config / hwdiag fan info / hwdiag temp get all / hwdiag system fabric test all / every targeted check, unconditionally, for ${effectiveSn}${nodeSuffix}`);

      try {
        const fmadmOut = await runIlomSession([
          { line: 'start -script /SP/faultmgmt/shell', delayAfterMs: 1000 },
          { line: 'fmadm faulty -a', delayAfterMs: 5000 },
          { line: 'exit', delayAfterMs: 750 },
        ], ilomIp, ilomUser, ilomPassword, 22500);
        console.log('[diagnose] fmadm raw output:\n', fmadmOut);
        const fmadmParsed = parseIlomProblems(fmadmOut);
        console.log('[diagnose] fmadm parsed faults:', JSON.stringify(fmadmParsed.faults));
        if (fmadmParsed.fanCapacityAlert) fanCapacityAlertPending = true;
        sendPartial(tagLabel('fmadm'), tagFaults(fmadmParsed.faults), fmadmOut);
      } catch (err) {
        console.error(`[diagnose] fmadm check failed for ${effectiveSn}${nodeSuffix}:`, err.message);
        sendPartial(tagLabel('fmadm'), tagFaults({ ...emptyFaults, genericErrors: [`fmadm check failed: ${err.message}`] }), err.message);
      }

      try {
        hwdiagOut = await runIlomSession([
          { line: 'start -script /SP/diag/shell', delayAfterMs: 1000 },
          // Run first, before fan/temp/fabric — its own "hwdiag_io_cables" cross-check (GI
          // reference wiring vs. what's actually connected) is what catches a swapped IOU PCIe/
          // power cable, the same class of fault previously only visible via a technician's
          // pasted session in a Jira ticket (see parseHwdiagIoCableFaults). No real-hardware
          // timing confirmation yet for this one, so 4000ms is a starting estimate (halved from
          // the original 8000ms estimate) — bump it if it turns out to get cut off the same way
          // "hwdiag temp get all" did below before its delay was corrected.
          { line: 'hwdiag io config', delayAfterMs: 4000 },
          { line: 'hwdiag fan info', delayAfterMs: 2500 },
          // "hwdiag temp get all" prints ~70 sensor lines (vs. fan info's ~7) and was observed on
          // real hardware to still be mid-output when the old 5000ms delay elapsed — the trailing
          // "exit" landed while the diag shell was still busy and cut the sensor table off
          // entirely (only the header printed before the connection closed); 15000ms was the
          // confirmed fix. This is now halved to 7500ms per a deliberate latency-vs-safety-margin
          // tradeoff — still above the confirmed-broken 5000ms, but NOT independently confirmed
          // safe against real hardware the way 15000ms was. Re-verify against a real unit; bump
          // back toward 15000ms if this command's output gets truncated again.
          { line: 'hwdiag temp get all', delayAfterMs: 7500 },
          // "hwdiag system fabric test all" actively trains/tests PCIe links, not just reading
          // cached values like the two commands above — no real-hardware timing confirmation for
          // this one yet, so 10000ms is a starting estimate (halved from the original 20000ms
          // estimate); bump it if it turns out to get cut off the same way temp get all did.
          { line: 'hwdiag system fabric test all', delayAfterMs: 10000 },
          { line: 'exit', delayAfterMs: 750 }, // leave the diag shell, back to top-level "->"
          { line: 'exit', delayAfterMs: 750 }, // log out of the top-level session
        ], ilomIp, ilomUser, ilomPassword, 42500);
        console.log('[diagnose] hwdiag raw output:\n', hwdiagOut);

        const ioConfigParsed = parseHwdiagIoCableFaults(hwdiagOut);
        console.log('[diagnose] hwdiag io config parsed faults:', JSON.stringify(ioConfigParsed.faults));
        sendPartial(tagLabel('hwdiag io config'), tagFaults(ioConfigParsed.faults), hwdiagOut);
        const fanParsed = parseHwdiagFanInfo(hwdiagOut);
        console.log('[diagnose] hwdiag fan parsed faults:', JSON.stringify(fanParsed.faults));
        sendPartial(tagLabel('hwdiag fan info'), tagFaults(fanParsed.faults), hwdiagOut);
        const tempParsed = parseHwdiagTempGetAll(hwdiagOut);
        console.log('[diagnose] hwdiag temp parsed faults:', JSON.stringify(tempParsed.faults));
        sendPartial(tagLabel('hwdiag temp get all'), tagFaults(tempParsed.faults), hwdiagOut);
        const fabricParsed = parseHwdiagFabricTestAll(hwdiagOut);
        console.log('[diagnose] hwdiag fabric test parsed faults:', JSON.stringify(fabricParsed.faults));
        sendPartial(tagLabel('hwdiag system fabric test all'), tagFaults(fabricParsed.faults), hwdiagOut);
      } catch (err) {
        console.error(`[diagnose] hwdiag check failed for ${effectiveSn}${nodeSuffix}:`, err.message);
        sendPartial(tagLabel('hwdiag'), tagFaults({ ...emptyFaults, genericErrors: [`hwdiag check failed: ${err.message}`] }), err.message);
      }

      // Resolve the fan-capacity alert held back above, now that hwdiag's chassis-type/bay-
      // presence result (or lack of one) is known.
      if (fanCapacityAlertPending) {
        if (isNormalReducedFanChassis(hwdiagOut)) {
          console.log(`[diagnose] fan-capacity alert suppressed for ${effectiveSn}${nodeSuffix} — confirmed 2U chassis with FM0/FM1/FM2/PS0/PS1 all present`);
        } else {
          sendPartial(
            tagLabel('fan-capacity-check'),
            tagFaults({ ...emptyFaults, components: ['gpu'], genericErrors: ['Fan-related problem reported (insufficient cooling capacity or multiple fan issues) — see raw output for detail'] }),
            ''
          );
        }
      }

      // VERIFY_OSFP_LINKS (which always runs first — see MFG_COLLECTOR_TARGETED_CHECKS' own
      // order) discovers this unit's associated test fixture as a side effect of its own lookup
      // (see FIXTURE_SN_RE/runLionkingOSFPCheck) — UPDATE_GXR3_FW needs that same fixture SN, not
      // effectiveSn's own JBOG SN, to resolve a MAC via SFCS (confirmed on real hardware: it fails
      // every time otherwise). Falls back to effectiveSn if VERIFY_OSFP_LINKS's own run didn't
      // yield one (e.g. its script errored before reaching that lookup) — no worse than before.
      let discoveredFixtureSn = null;
      for (const [checkName, targetedCheck] of Object.entries(MFG_COLLECTOR_TARGETED_CHECKS)) {
        console.log(`[diagnose] running targeted check ${checkName} for ${effectiveSn}${nodeSuffix}`);
        const targetSnForCheck = (checkName === 'UPDATE_GXR3_FW' && discoveredFixtureSn) ? discoveredFixtureSn : effectiveSn;
        const stepResult = await runAndReportCheck(checkName, targetedCheck, isMultiNode ? node : null, targetSnForCheck, fixtureLabelPrefix, node);
        if (checkName === 'VERIFY_OSFP_LINKS' && stepResult.fixtureSn) {
          discoveredFixtureSn = stepResult.fixtureSn;
          console.log(`[diagnose] VERIFY_OSFP_LINKS discovered Fixture SN ${discoveredFixtureSn} for ${effectiveSn}${nodeSuffix} — UPDATE_GXR3_FW will use it`);
        }
        // See the Step 1.5 adoptLiveChassisModel guard above — CHECK_POWER_ON's own live
        // product_name read must not switch the UUT's page based on the fixture's chassis type.
        if (!isFixturePass) adoptLiveChassisModel(stepResult);
      }
    };

    // Each node's chain talks to a fully independent ILOM (its own ilomIp, own runIlomSession
    // child process, own local fanCapacityAlertPending/hwdiagOut closure vars — see
    // runIlomSession above, which has no shared/module-level state between calls), so a dual-node
    // chassis can run both chains concurrently instead of paying their combined latency back to
    // back. sendPartial/sendChassisInfo are synchronous per-call res.write()s (no interleaving
    // risk on Node's single-threaded event loop), and adoptLiveChassisModel's shared chassisModel/
    // isE5E6Chassis guard is idempotent no matter which node's "show /SYS" read resolves first.
    await Promise.all(reachableNodes.map((node) => runDefaultChainForNode(node)));

    // The fixture pass never reaches a real {type:'done'} — it ends in a confirm instead, asking
    // whether to also run this same normal command flow for the UUT itself. Answering "yes"
    // re-requests with ?continueToUut=1, at which point isFixturePass is false and this whole
    // handler runs again for the real serialNumber, ending in the sendDone below exactly as any
    // other request does.
    if (isFixturePass) {
      sendConfirm(
        `Finished running the normal diagnostic flow against Fixture ${effectiveSn}. Continue to also run it for ${serialNumber} itself?`,
        'continueToUut'
      );
      return res.end();
    }

    sendDone({
      // defaultFlowNotice is a status update ("running the default chain because X"), not a
      // fault — it must stay out of genericErrors (which the UI renders as red fault banners)
      // and be surfaced separately so the frontend can show it as a neutral status line instead.
      ...(defaultFlowNotice ? { defaultFlowNotice } : {}),
      ...(defaultFlowSourceTag ? { source: `default-ilom-chain (${defaultFlowSourceTag})` } : {}),
      chassisModel, isE5E6Chassis,
    });
    res.end();
  } catch (err) {
    console.error('[diagnose]', err.message);
    if (res.headersSent) {
      sendFatal(err.message);
      res.end();
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

export default router;
