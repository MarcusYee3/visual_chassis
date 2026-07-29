import { useState, useEffect, useRef } from 'react';
import ServerContainer from '../components/ServerContainer/ServerContainer';
import OSFPModule from '../components/OSFPModules/OSFPModule';
import PSUPort from '../components/PSUPorts/PSUPort';
import E1SBoard from '../components/E1SBoards/E1SBoard';
import GXR3VRetimer from '../components/GXR3VRetimer/GXR3VRetimer';
import PCIeSwitch from '../components/PCIeSwitch/PCIeSwitch';
import FanModule from '../components/FanModule/FanModule';
import DimmModule from '../components/DimmModule/DimmModule';
import { useServerData } from '../hooks/useServerData';
import { getOSFPModules, getPSUPorts } from '../services/api';

const EMPTY_FAULTS = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };

// One color per category of raw part, used for that category's section header below — never red,
// since red is reserved exclusively for fault highlighting (see faultGlow/faultBorder) and a
// category rendered in red could otherwise be misread as "this whole category is faulted". PSU
// used to be "red" here (and PSUPort.module.css's own backplate used to be red-toned too) for
// exactly that reason — both were changed to teal.
const CATEGORY_COLORS = {
  blue: { background: 'linear-gradient(180deg, #243d64 0%, #182a48 100%)', border: '#3a5a8f', color: '#a8c4e8' },
  purple: { background: 'linear-gradient(180deg, #392060 0%, #251746 100%)', border: '#5a3a8f', color: '#c9ace8' },
  green: { background: 'linear-gradient(180deg, #1e4a38 0%, #143528 100%)', border: '#3a7a5a', color: '#a8dcc0' },
  teal: { background: 'linear-gradient(180deg, #1a4a4a 0%, #123636 100%)', border: '#2a7a7a', color: '#a8dcdc' },
};

// Shared look for both the (still-interactive) per-OSFP-module "back" link and the plain,
// non-interactive category section headers below — same colored pill, minus the pointer/hover
// affordances when nothing is actually clickable.
const categoryHeaderStyle = (colorKey = 'blue', interactive = false) => {
  const c = CATEGORY_COLORS[colorKey] || CATEGORY_COLORS.blue;
  return {
    ...(interactive ? { cursor: 'pointer', transition: 'all 0.15s' } : {}),
    padding: '5px 10px',
    marginBottom: '8px',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: c.color,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    background: c.background,
    border: `1px solid ${c.border}`,
    borderRadius: '3px',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 3px rgba(0,0,0,0.3)',
    userSelect: 'none',
  };
};

const faultBorder = '1px solid #ff4444';
// Intensified per user request — the previous two-layer glow (12px/24px, 0.5/0.2 opacity) read as
// too subtle once every raw part is always on screen at once instead of hidden behind a collapsed
// tray. A third, wider/softer outer layer plus higher opacities makes a fault visibly jump out.
const faultGlow = '0 0 18px rgba(255,68,68,0.75), 0 0 36px rgba(255,68,68,0.4), 0 0 54px rgba(255,68,68,0.15)';

// Same physical OSFP-slot -> IOU convention as server/src/routes/diagnose.js's own
// OSFP_SLOT_TO_IOU (which parses lionking_OSFP.py's loopback link results) — each numbered OSFP
// slot is one end of a physical loopback cable pairing two IOU ports:
//   slot 1 = IOU 6     slot 2 = IOU 1     slot 3 = IOU 7     slot 4 = IOU 2
//   slot 5 = IOU 9     slot 6 = IOU 4     slot 7 = IOU 10    slot 8 = IOU 5
// The Retimer BD's 8 GXR3 retimer cards live on these same 8 IOUs, so they're labeled/ordered by
// OSFP slot here too (see the Retimer BD section below) rather than by raw IOU number.
const OSFP_SLOT_TO_IOU = { 1: 6, 2: 1, 3: 7, 4: 2, 5: 9, 6: 4, 7: 10, 8: 5 };
// Adjacent slot pairs joined by one physical loopback cable, per lionking_OSFP.py's own port
// order (mirrors server/src/routes/diagnose.js's OSFP_CABLE_SLOT_PAIRS) — labeled "CABLE 1-2" etc.
// below, by slot number rather than the IOU numbers on either end.
const OSFP_CABLE_SLOT_PAIRS = [[1, 2], [3, 4], [5, 6], [7, 8]];
// The two physical OSFP boards this chassis actually has — OSFP BD 1 carries slots 1-4 (its 2
// cable pairs), OSFP BD 2 carries slots 5-8, matching the original backend osfpModules grouping
// (server/src/data/serverData.js's "osfp-1"/"osfp-2").
const OSFP_BD_GROUPS = [
  { name: 'OSFP BD 1', pairs: OSFP_CABLE_SLOT_PAIRS.slice(0, 2) },
  { name: 'OSFP BD 2', pairs: OSFP_CABLE_SLOT_PAIRS.slice(2, 4) },
];

// Each CPU (P0/P1) carries 16 DIMM slots (D0-D15) across 4 memory controllers of 4 DIMMs each,
// per the real captured "CPU <p> Memory Controller <m>" hwdiag fabric-test output — see
// parseHwdiagFabricTestAll in diagnose.js. Static layout (no fetch needed, unlike OSFP/PSU which
// vary per unit) since every unit with this platform has the same slot count.
const DIMM_SLOTS = Array.from({ length: 16 }, (_, i) => i);

function ServerOverview({ refreshKey = 0, faults = EMPTY_FAULTS }) {
  const { data: server, loading, error } = useServerData('server-1', refreshKey);
  const [osfpModules, setOsfpModules] = useState([]);
  const [expandedMb, setExpandedMb] = useState(false);
  const [psuPorts, setPsuPorts] = useState([]);
  // Keyed by OSFP slot (1-8) — toggles that OSFP module's own single-IOU cable-link reveal (see
  // the GBB Tray section below).
  const [expandedOsfpSlot, setExpandedOsfpSlot] = useState({});
  // Keyed by OSFP slot (1-8) — same idea as expandedOsfpSlot above, but for the Retimer BD's own
  // OSFP row further down (independent state since both can be open at once).
  const [expandedRetimerCable, setExpandedRetimerCable] = useState({});
  const prevFaults = useRef(EMPTY_FAULTS);

  const has = (comp) => faults.components.includes(comp);

  // GBB/GPU/IOB/PSU are no longer collapsed-by-default trays (see the removed ServerComponent
  // usage below) — every raw part is always on screen, so their data is fetched unconditionally on
  // mount instead of gated behind an expand click.
  useEffect(() => {
    getOSFPModules('server-1').then(setOsfpModules).catch(console.error);
    getPSUPorts('server-1').then(setPsuPorts).catch(console.error);
  }, []);

  // Motherboard is still its own collapsed-by-default panel (it's an external unit floating beside
  // the chassis, not one of the 4 always-shown rack trays) — auto-expand it the moment its own
  // fault first arrives, same as before.
  useEffect(() => {
    const prev = prevFaults.current;
    const mbFaulted = (has('mb') || (faults.dimmIds || []).length > 0) &&
      !prev.components.includes('mb') && !(prev.dimmIds || []).length;
    if (mbFaulted) setExpandedMb(true);
    prevFaults.current = faults;
  }, [faults]);

  const handleMbClick = () => setExpandedMb(!expandedMb);

  const handleRetimerClick = (slot) => setExpandedRetimerCable((prev) => ({ ...prev, [slot]: !prev[slot] }));

  const handleOsfpSlotClick = (slot) => setExpandedOsfpSlot((prev) => ({ ...prev, [slot]: !prev[slot] }));

  if (loading) return (
    <div style={{ textAlign: 'center', padding: '80px 20px', color: '#999' }}>
      <p>Loading server data...</p>
    </div>
  );

  if (error) return (
    <div style={{ textAlign: 'center', padding: '80px 20px', color: '#c33' }}>
      <p>Error loading server data: {error}</p>
    </div>
  );

  if (!server) return null;

  const topRow = psuPorts.filter((p) => {
    const num = parseInt(p.name.replace(/\D/g, ''), 10);
    return num >= 7 && num <= 12;
  });
  const bottomRow = psuPorts.filter((p) => {
    const num = parseInt(p.name.replace(/\D/g, ''), 10);
    return num >= 1 && num <= 6;
  });

  // The 2 backend OSFP BD modules' pciePorts, flattened in order, line up exactly with OSFP slots
  // 1-8 (module 1 = slots 1-4, module 2 = slots 5-8 — confirmed against serverData.js's seed:
  // module 1's ports are literally named "IOU 6"/"IOU 1"/"IOU 7"/"IOU 2", matching
  // OSFP_SLOT_TO_IOU[1..4]). Real port ids are reused as-is; only the displayed label changes.
  const allOsfpPorts = osfpModules.flatMap((m) => m.pciePorts || []);

  const fontStyle = { fontFamily: "'JetBrains Mono', monospace", fontSize: '8px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' };

  const bmcFaulted = has('bmc');
  const rotFaulted = has('rot');

  // Motherboard is an external unit (the DIMMs live on a separate physical head node) linked in
  // via cable to the GBB Tray rather than occupying a rack slot — see the floating panel below.
  const mbFaulted = has('mb') || (faults.dimmIds || []).length > 0;
  const mbCableColor = mbFaulted ? '#ff4444' : '#c08a3a';
  const mbPlugStyle = {
    width: '5px', height: '12px', borderRadius: '1px', flexShrink: 0,
    background: 'linear-gradient(180deg, #222 0%, #1a1a1a 100%)',
    border: `1px solid ${mbCableColor}`,
    boxShadow: mbFaulted ? faultGlow : 'inset 0 0 3px rgba(0,0,0,0.6)',
  };

  return (
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start' }}>
      <ServerContainer label={`${server.name} — SN: ${server.serialNumber}`}>

        {/* GBB Tray — always shown flat (no collapsed tray box to click through). Grouped into
            the 2 physical OSFP BDs (BD 1 = OSFP 1-4, BD 2 = OSFP 5-8), each holding its own 2
            cable pairs. */}
        <div style={{ width: '100%' }}>
          <div style={categoryHeaderStyle('blue')}>GBB Tray</div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {OSFP_BD_GROUPS.map((bd) => (
              <div key={bd.name} style={{
                flex: 1, display: 'flex', flexDirection: 'column', gap: '4px',
                padding: '5px', borderRadius: '4px', border: '1px solid #2a3a50',
                background: 'rgba(36,61,100,0.14)',
              }}>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: '8px', fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase', color: '#7a92bd', textAlign: 'center',
                }}>
                  {bd.name}
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {bd.pairs.map(([slotA, slotB]) => {
                    const iouA = OSFP_SLOT_TO_IOU[slotA];
                    const iouB = OSFP_SLOT_TO_IOU[slotB];
                    const cableFaulted = (faults.cableFaults || []).includes(`cable-${iouA}-${iouB}`);
                    const cableColor = cableFaulted ? '#ff4444' : '#5a7ab0';
                    // Same plug-and-dotted-line look as the Motherboard cable and the OSFP<->IOU
                    // reveal below, so the physical loopback cable between a pair's two OSFP
                    // modules actually reads as a cable instead of just a text label.
                    const cablePlugStyle = {
                      width: '3px', height: '10px', borderRadius: '1px', flexShrink: 0,
                      background: 'linear-gradient(180deg, #222 0%, #1a1a1a 100%)',
                      border: `1px solid ${cableColor}`,
                      boxShadow: cableFaulted ? faultGlow : 'inset 0 0 3px rgba(0,0,0,0.6)',
                    };
                    // Renders slotA, the connector, and slotB as three independent siblings
                    // (rather than nesting the connector inside slotB's own flex:1 wrapper) so
                    // both modules get an identical width share — nesting it inside slotB's
                    // wrapper previously ate into that module's own space, rendering it visibly
                    // narrower than slotA's.
                    const renderModule = (slot) => {
                      const iou = OSFP_SLOT_TO_IOU[slot];
                      const port = allOsfpPorts[slot - 1];
                      const hasFault = (faults.pcieFaults || []).some((f) => f.iou === iou)
                        || (faults.cableFaults || []).some((id) => id.split('-').slice(1).map(Number).includes(iou));
                      return (
                        <div key={slot} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <OSFPModule id={port?.id || `osfp-slot-${slot}`} name={`OSFP ${slot}`}
                            onClick={() => handleOsfpSlotClick(slot)}
                            hasFault={hasFault} />
                          {expandedOsfpSlot[slot] && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}
                              title={`OSFP ${slot} <-> IOU ${iou}`}>
                              <div style={{ flex: 1, height: 0, borderTop: '2px dotted #5a7ab0' }} />
                              <div style={{
                                fontFamily: "'JetBrains Mono', monospace", fontSize: '7px', fontWeight: 700,
                                letterSpacing: '0.04em', color: '#a8bad6', background: '#1a1e28',
                                border: '1px solid #333', borderRadius: '2px', padding: '1px 4px',
                                whiteSpace: 'nowrap',
                              }}>
                                IOU {iou}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    };
                    return (
                      <div key={`${slotA}-${slotB}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                          {renderModule(slotA)}
                          <div style={{ display: 'flex', alignItems: 'center', width: '18px', flexShrink: 0, marginTop: '16px' }}
                            title={`Loopback cable: OSFP ${slotA} <-> OSFP ${slotB}${cableFaulted ? ' — DOWN' : ''}`}>
                            <div style={cablePlugStyle} />
                            <div style={{
                              flex: 1, height: 0, borderTop: `2px dotted ${cableColor}`,
                              filter: cableFaulted ? 'drop-shadow(0 0 3px rgba(255,68,68,0.7))' : 'none',
                            }} />
                            <div style={cablePlugStyle} />
                          </div>
                          {renderModule(slotB)}
                        </div>
                        <div style={{
                          fontFamily: "'JetBrains Mono', monospace", fontSize: '8px', fontWeight: 700,
                          letterSpacing: '0.05em', color: cableFaulted ? '#ff8080' : '#7a8bab', textAlign: 'center',
                        }}>
                          CABLE {slotA}-{slotB}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Nvidia B300 GPU Baseboard */}
        <div style={{ width: '100%' }}>
          <div style={categoryHeaderStyle('purple')}>Nvidia B300 GPU Baseboard — Fan Modules</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {[25, 19, 13, 7, 1].map((rowStart) => (
              <div key={rowStart} style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '3px' }}>
                {Array.from({ length: 6 }, (_, i) => rowStart + i).map((n) => (
                  <FanModule key={n} number={n} faulted={(faults.fanIds || []).includes(n)} />
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* IOB Tray */}
        <div style={{ width: '100%' }}>
          <div style={categoryHeaderStyle('green')}>IOB Tray</div>
          {/* Left/right columns are just a couple of single-item cards (E1S board, BMC, ROT,
              filler) and don't need much room — narrowed so the center Retimer BD column (which
              has to fit 8-wide OSFP + PCIE SW rows) gets the width it actually needs instead of
              being squeezed into an equal third. */}
          <div style={{ display: 'grid', gridTemplateColumns: '0.6fr 1.8fr 0.6fr', gap: '4px' }}>

            {/* Left: E1S A + BMC + ROT */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <E1SBoard id="e1s-a" name="E1S A" faulted={faults.e1sIds.includes('e1s-a')} />
              <div id="bmc-card" style={{
                flex: 1,
                backgroundImage: 'radial-gradient(circle at 3px 3px, rgba(192,132,252,0.07) 0.5px, transparent 0.5px), linear-gradient(180deg, #1e1a30 0%, #161228 100%)',
                backgroundSize: '6px 6px, 100% 100%',
                border: bmcFaulted ? faultBorder : '1px solid #3a2a50',
                boxShadow: bmcFaulted ? faultGlow : 'none',
                borderRadius: '2px', display: 'flex', alignItems: 'center', gap: '5px', padding: '0 5px', minHeight: '26px',
                animation: bmcFaulted ? 'faultPulse 1.4s ease-in-out infinite' : 'none',
              }}>
                <div style={{ width: '3px', height: '3px', borderRadius: '50%', background: bmcFaulted ? '#ff4444' : '#c084fc', boxShadow: bmcFaulted ? '0 0 6px rgba(255,68,68,0.9)' : '0 0 4px rgba(192,132,252,0.5)', flexShrink: 0 }} />
                <span style={{ ...fontStyle, color: bmcFaulted ? '#ff9999' : '#7a5aaa' }}>BMC Card</span>
              </div>
              <div id="rot-card" style={{
                backgroundImage: 'radial-gradient(circle at 3px 3px, rgba(251,191,36,0.06) 0.5px, transparent 0.5px), linear-gradient(180deg, #1a1e28 0%, #111620 100%)',
                backgroundSize: '6px 6px, 100% 100%',
                border: rotFaulted ? faultBorder : '1px solid #2a3040',
                boxShadow: rotFaulted ? faultGlow : 'none',
                borderRadius: '2px', display: 'flex', alignItems: 'center', gap: '5px', padding: '5px',
                animation: rotFaulted ? 'faultPulse 1.4s ease-in-out infinite' : 'none',
              }}>
                <div style={{ width: '3px', height: '3px', borderRadius: '50%', background: rotFaulted ? '#ff4444' : '#fbbf24', boxShadow: rotFaulted ? '0 0 6px rgba(255,68,68,0.9)' : '0 0 4px rgba(251,191,36,0.4)', flexShrink: 0 }} />
                <span style={{ ...fontStyle, color: rotFaulted ? '#ff9999' : '#607090' }}>ROT 4.1</span>
              </div>
            </div>

            {/* Center: Retimer BD — the 8 GXR3 retimer cards are labeled/ordered by OSFP slot
                (see OSFP_SLOT_TO_IOU) rather than raw IOU number, matching the GBB Tray's own
                OSFP numbering. Clicking one reveals a cable-link tag naming its actual IOU, same
                pairing the GBB Tray's own cable view uses. PCIE SW 1-8 get their own single row,
                no longer paired one-per-retimer. */}
            <div style={{ backgroundImage: 'radial-gradient(circle at 3.5px 3.5px, rgba(200,220,50,0.08) 0.6px, transparent 0.6px), repeating-linear-gradient(90deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px, transparent 1px, transparent 7px), linear-gradient(180deg, #22280f 0%, #161a08 100%)', backgroundSize: '7px 7px, 7px 7px, 100% 100%', border: '1px solid #3e4a1a', borderRadius: '2px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px 8px', boxShadow: 'inset 0 1px 0 rgba(200,220,50,0.04)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '2px' }}>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((slot) => {
                    const iou = OSFP_SLOT_TO_IOU[slot];
                    return (
                      <div key={slot} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <GXR3VRetimer id={`retimer-${iou}`} name={`OSFP ${slot}`}
                          onClick={() => handleRetimerClick(slot)}
                          faulted={faults.retimerIds.includes(`retimer-${iou}`)} />
                        {expandedRetimerCable[slot] && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}
                            title={`OSFP ${slot} <-> IOU ${iou}`}>
                            <div style={{ flex: 1, height: 0, borderTop: '2px dotted #5a7ab0' }} />
                            <div style={{
                              fontFamily: "'JetBrains Mono', monospace", fontSize: '6px', fontWeight: 700,
                              letterSpacing: '0.04em', color: '#a8bad6', background: '#1a1e28',
                              border: '1px solid #333', borderRadius: '2px', padding: '1px 3px',
                              whiteSpace: 'nowrap',
                            }}>
                              IOU {iou}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '2px' }}>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((switchNum) => {
                    const switchFaulted = (faults.pcieSwitchIds || []).includes(switchNum);
                    return (
                      <PCIeSwitch key={switchNum} id={`pcie-sw-${switchNum}`} label={`PCIE SW ${switchNum}`}
                        faulted={switchFaulted}
                        title={`PCIE_SW${switchNum}${switchFaulted ? ' — FAILED' : ''}`} />
                    );
                  })}
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ ...fontStyle, fontSize: '9px', color: '#8a9a45' }}>8x GXR3V2</div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '7px', color: '#5a6a30', letterSpacing: '0.04em', textTransform: 'uppercase', marginTop: '2px' }}>Retimer BD</div>
              </div>
            </div>

            {/* Right: E1S B + filler */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <E1SBoard id="e1s-b" name="E1S B" faulted={faults.e1sIds.includes('e1s-b')} />
              <div style={{ flex: 1, background: 'linear-gradient(180deg, #161a1e 0%, #0e1114 100%)', border: '1px solid #222628', borderRadius: '2px' }} />
            </div>
          </div>
        </div>

        {/* PSU — category color is teal, not red, so a healthy PSU section can't be mistaken for
            a faulted one (PSUPort.module.css's own backplate was changed for the same reason). */}
        <div style={{ width: '100%' }}>
          <div style={categoryHeaderStyle('teal')}>PSU</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '3px' }}>
              {topRow.map((port) => (
                <PSUPort key={port.id} id={port.id} name={port.name} status={port.status}
                  faulted={faults.psuPorts.includes(port.id)} />
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '3px' }}>
              {bottomRow.map((port) => (
                <PSUPort key={port.id} id={port.id} name={port.name} status={port.status}
                  faulted={faults.psuPorts.includes(port.id)} />
              ))}
            </div>
          </div>
        </div>

      </ServerContainer>

        {/* Motherboard — external unit, cabled to the IOB Tray rather than rack-mounted (its
            DIMMs live on a separate physical head node, not this chassis). alignItems:'center'
            keeps the cable and the panel always vertically centered against each other (so they
            never visually detach), but that means the row's marginTop has to change with the
            panel's own height (~35px collapsed vs ~300+px expanded with the DIMM grids) to keep
            the *center* of the row landing on the same fixed point (the IOB Tray) in both states —
            a single fixed marginTop only works for one state. */}
        <div style={{ display: 'flex', alignItems: 'center', marginTop: expandedMb ? '295px' : '505px', flexShrink: 0 }}
          title={`Head node motherboard — linked via cable${mbFaulted ? ' — FAULT' : ''}`}>
          <div style={{ display: 'flex', alignItems: 'center', width: '46px', flexShrink: 0 }}>
            <div style={mbPlugStyle} />
            <div style={{
              flex: 1, height: 0,
              borderTop: `2px dotted ${mbCableColor}`,
              filter: mbFaulted ? 'drop-shadow(0 0 3px rgba(255,68,68,0.7))' : 'none',
            }} />
            <div style={mbPlugStyle} />
          </div>
          <div
            onClick={handleMbClick} role="button" tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleMbClick()}
            style={{
              width: expandedMb ? '210px' : '170px',
              padding: '10px 12px',
              borderRadius: '6px',
              cursor: 'pointer',
              backgroundImage: 'radial-gradient(circle at 3px 3px, rgba(224,168,80,0.06) 0.5px, transparent 0.5px), linear-gradient(180deg, #2a2010 0%, #1e1608 100%)',
              backgroundSize: '6px 6px, 100% 100%',
              border: mbFaulted ? faultBorder : '1px solid #5a4520',
              boxShadow: mbFaulted ? faultGlow : '0 4px 14px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
              transition: 'width 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: expandedMb ? '10px' : '0' }}>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 700,
                letterSpacing: '0.06em', textTransform: 'uppercase', color: mbFaulted ? '#ff9999' : '#e0a850',
              }}>
                Motherboard
              </span>
              <span style={{ color: mbFaulted ? '#ff4444' : '#8a6a2a', fontSize: '10px' }}>{expandedMb ? '✕' : '▸'}</span>
            </div>
            {expandedMb && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {[0, 1].map((cpu) => (
                  <div key={cpu} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{
                      fontFamily: "'JetBrains Mono', monospace", fontSize: '8px', fontWeight: 700,
                      letterSpacing: '0.04em', textTransform: 'uppercase', color: '#c08a3a', textAlign: 'center',
                    }}>
                      CPU {cpu} (P{cpu})
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '3px' }}>
                      {DIMM_SLOTS.map((slot) => (
                        <DimmModule key={slot} cpu={cpu} slot={slot}
                          faulted={(faults.dimmIds || []).includes(`dimm-p${cpu}-d${slot}`)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>
  );
}

export default ServerOverview;
