import { useState, useEffect, useRef } from 'react';
import ServerContainer from '../components/ServerContainer/ServerContainer';
import ServerComponent from '../components/ServerComponent/ServerComponent';
import OSFPModule from '../components/OSFPModules/OSFPModule';
import PCIePort from '../components/PCIePorts/PCIePort';
import PSUPort from '../components/PSUPorts/PSUPort';
import E1SBoard from '../components/E1SBoards/E1SBoard';
import GXR3VRetimer from '../components/GXR3VRetimer/GXR3VRetimer';
import FanModule from '../components/FanModule/FanModule';
import { useServerData } from '../hooks/useServerData';
import { getOSFPModules, getPCIePorts, getPSUPorts } from '../services/api';

const EMPTY_FAULTS = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [] };

const genericErrorStyle = {
  width: '100%',
  maxWidth: '740px',
  padding: '8px 14px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: '#ffd6d6',
  background: 'linear-gradient(180deg, #7a2020 0%, #5c1818 100%)',
  border: '1px solid #cc3333',
  borderRadius: '6px',
  boxShadow: '0 0 12px rgba(204,51,51,0.35), inset 0 1px 0 rgba(255,255,255,0.06)',
};

const BACK_LINK_COLORS = {
  blue: { background: 'linear-gradient(180deg, #243d64 0%, #182a48 100%)', border: '#3a5a8f', color: '#a8c4e8' },
  purple: { background: 'linear-gradient(180deg, #392060 0%, #251746 100%)', border: '#5a3a8f', color: '#c9ace8' },
  green: { background: 'linear-gradient(180deg, #1e4a38 0%, #143528 100%)', border: '#3a7a5a', color: '#a8dcc0' },
  red: { background: 'linear-gradient(180deg, #542424 0%, #3c1818 100%)', border: '#8a3a3a', color: '#e8b0b0' },
};

const backLinkStyle = (colorKey = 'blue') => {
  const c = BACK_LINK_COLORS[colorKey] || BACK_LINK_COLORS.blue;
  return {
    cursor: 'pointer',
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
    transition: 'all 0.15s',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 3px rgba(0,0,0,0.3)',
    userSelect: 'none',
  };
};

const faultBorder = '1px solid #ff4444';
const faultGlow = '0 0 12px rgba(255,68,68,0.5), 0 0 24px rgba(255,68,68,0.2)';

// Real IOU numbers carrying a GXR3 retimer card (same 8 IOUs the OSFP boards use, 1,2,4,5,6,7,9,10
// — 3 and 8 don't have one), per gxr3_fw_update_check's own output.
const IOU_GXR3_NUMBERS = [1, 2, 4, 5, 6, 7, 9, 10];

function ServerOverview({ refreshKey = 0, faults = EMPTY_FAULTS }) {
  const { data: server, loading, error } = useServerData('server-1', refreshKey);
  const [expandedGbb, setExpandedGbb] = useState(false);
  const [osfpModules, setOsfpModules] = useState([]);
  const [expandedOsfp, setExpandedOsfp] = useState({});
  const [pciePorts, setPciePorts] = useState({});
  const [expandedGpu, setExpandedGpu] = useState(false);
  const [expandedIob, setExpandedIob] = useState(false);
  const [expandedPsu, setExpandedPsu] = useState(false);
  const [psuPorts, setPsuPorts] = useState([]);
  const prevFaults = useRef(EMPTY_FAULTS);

  const has = (comp) => faults.components.includes(comp);

  useEffect(() => {
    if (expandedGbb && osfpModules.length === 0) {
      getOSFPModules('server-1').then(setOsfpModules).catch(console.error);
    }
  }, [expandedGbb, osfpModules.length]);

  // Auto-expand trays when their faults arrive
  useEffect(() => {
    const prev = prevFaults.current;
    const psuFaulted = (has('psu') || faults.psuPorts.length > 0) &&
      !prev.components.includes('psu') && !prev.psuPorts.length;
    const iobFaulted = (has('iob') || faults.retimerIds.length > 0 || faults.e1sIds.length > 0) &&
      !prev.components.includes('iob') && !prev.retimerIds.length && !prev.e1sIds.length;

    if (psuFaulted) setExpandedPsu(true);
    if (iobFaulted) setExpandedIob(true);

    prevFaults.current = faults;
  }, [faults]);

  useEffect(() => {
    if (expandedPsu && psuPorts.length === 0) {
      getPSUPorts('server-1').then(setPsuPorts).catch(console.error);
    }
  }, [expandedPsu, psuPorts.length]);

  const handleGbbClick = () => setExpandedGbb(!expandedGbb);
  const handleGpuClick = () => setExpandedGpu(!expandedGpu);
  const handleIobClick = () => setExpandedIob(!expandedIob);
  const handlePsuClick = () => setExpandedPsu(!expandedPsu);

  const handleOsfpClick = (osfpId) => {
    if (expandedOsfp[osfpId]) {
      setExpandedOsfp((prev) => ({ ...prev, [osfpId]: false }));
      return;
    }
    if (!pciePorts[osfpId]) {
      getPCIePorts('server-1', osfpId)
        .then((ports) => setPciePorts((prev) => ({ ...prev, [osfpId]: ports })))
        .catch(console.error);
    }
    setExpandedOsfp((prev) => ({ ...prev, [osfpId]: true }));
  };

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

  const fontStyle = { fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' };

  const bmcFaulted = has('bmc');
  const rotFaulted = has('rot');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
      {(faults.genericErrors || []).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', maxWidth: '740px' }}>
          {faults.genericErrors.map((msg, i) => (
            <div key={i} style={genericErrorStyle}>⚠ {msg}</div>
          ))}
        </div>
      )}
      <ServerContainer label={`${server.name} — SN: ${server.serialNumber}`}>

        {/* GBB Tray */}
        {expandedGbb ? (
          <div style={{ width: '100%' }}>
            <div style={backLinkStyle('blue')} onClick={handleGbbClick} role="button" tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleGbbClick()}>
              ← GBB Tray
            </div>
            <div style={{ display: 'flex', gap: '4px' }}>
              {osfpModules.map((mod) => {
                const modIouNums = (mod.pciePorts || []).map((p) => parseInt(p.name.replace(/\D/g, ''), 10));
                const modHasFault = (faults.pcieFaults || []).some(f => modIouNums.includes(f.iou))
                  || (faults.cableFaults || []).some((id) => id.split('-').slice(1).some((n) => modIouNums.includes(parseInt(n, 10))));
                return expandedOsfp[mod.id] ? (
                  <div key={mod.id} style={{ flex: 1 }}>
                    <div style={{ ...backLinkStyle('blue'), fontSize: '12px', marginBottom: '4px' }}
                      onClick={() => handleOsfpClick(mod.id)} role="button" tabIndex={0}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleOsfpClick(mod.id)}>
                      ← {mod.name}
                    </div>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      {[0, 2].map((pairStart) => {
                        const portA = (pciePorts[mod.id] || [])[pairStart];
                        const portB = (pciePorts[mod.id] || [])[pairStart + 1];
                        if (!portA || !portB) return null;
                        const iouA = parseInt(portA.name.replace(/\D/g, ''), 10);
                        const iouB = parseInt(portB.name.replace(/\D/g, ''), 10);
                        const cableId = `cable-${iouA}-${iouB}`;
                        const cableFaulted = (faults.cableFaults || []).includes(cableId);
                        const faultA = (faults.pcieFaults || []).find(f => f.iou === iouA);
                        const faultB = (faults.pcieFaults || []).find(f => f.iou === iouB);
                        const cableColor = cableFaulted ? '#ff4444' : '#5a7ab0';
                        const plugStyle = {
                          width: '5px', height: '12px', borderRadius: '1px', flexShrink: 0,
                          background: 'linear-gradient(180deg, #222 0%, #1a1a1a 100%)',
                          border: `1px solid ${cableColor}`,
                          boxShadow: cableFaulted ? faultGlow : 'inset 0 0 3px rgba(0,0,0,0.6)',
                        };
                        return (
                          <div key={cableId} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}
                            title={`Loopback cable: IOU${iouA} <-> IOU${iouB}${cableFaulted ? ' — DOWN' : ''}`}>
                            <div style={{ display: 'flex', alignItems: 'center' }}>
                              <PCIePort id={portA.id} name={portA.name} status={portA.status}
                                faulted={!!faultA} probability={faultA?.probability ?? null} />
                              <div style={{ display: 'flex', alignItems: 'center', width: '38px', flexShrink: 0 }}>
                                <div style={plugStyle} />
                                <div style={{
                                  flex: 1, height: 0,
                                  borderTop: `2px dotted ${cableColor}`,
                                  filter: cableFaulted ? 'drop-shadow(0 0 3px rgba(255,68,68,0.7))' : 'none',
                                }} />
                                <div style={plugStyle} />
                              </div>
                              <PCIePort id={portB.id} name={portB.name} status={portB.status}
                                faulted={!!faultB} probability={faultB?.probability ?? null} />
                            </div>
                            <div style={{
                              fontFamily: "'JetBrains Mono', monospace", fontSize: '8px', fontWeight: 700,
                              letterSpacing: '0.05em', color: cableFaulted ? '#ff8080' : '#7a8bab',
                            }}>
                              CABLE {iouA}↔{iouB}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <OSFPModule key={mod.id} id={mod.id} name={mod.name}
                    onClick={() => handleOsfpClick(mod.id)}
                    hasFault={modHasFault} />
                );
              })}
            </div>
          </div>
        ) : (
          <ServerComponent id="gbb-tray" name="GBB Tray"
            color="blue"
            alert={has('gbb')}
            interactive onClick={handleGbbClick}
            badge={(faults.pcieFaults || []).length > 0 || (faults.cableFaults || []).length > 0} />
        )}

        {/* GPU Baseboard */}
        {expandedGpu ? (
          <div style={{ width: '100%' }}>
            <div style={backLinkStyle('purple')} onClick={handleGpuClick} role="button" tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleGpuClick()}>
              ← Nvidia B300 GPU Baseboard — Fan Modules
            </div>
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
        ) : (
          <ServerComponent id="gpu-baseboard" name="Nvidia B300 GPU Baseboard"
            color="purple"
            alert={has('gpu')}
            interactive onClick={handleGpuClick}
            badge={(faults.fanIds || []).length > 0}
            style={{ height: '140px' }} />
        )}

        {/* IOB Tray */}
        {expandedIob ? (
          <div style={{ width: '100%' }}>
            <div style={backLinkStyle('green')} onClick={handleIobClick} role="button" tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleIobClick()}>
              ← IOB Tray
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px' }}>

              {/* Left: E1S A + BMC + ROT */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <E1SBoard id="e1s-a" name="8x E1S A" faulted={faults.e1sIds.includes('e1s-a')} />
                <div id="bmc-card" style={{
                  flex: 1,
                  backgroundImage: 'radial-gradient(circle at 3px 3px, rgba(192,132,252,0.07) 0.5px, transparent 0.5px), linear-gradient(180deg, #1e1a30 0%, #161228 100%)',
                  backgroundSize: '6px 6px, 100% 100%',
                  border: bmcFaulted ? faultBorder : '1px solid #3a2a50',
                  boxShadow: bmcFaulted ? faultGlow : 'none',
                  borderRadius: '2px', display: 'flex', alignItems: 'center', gap: '8px', padding: '0 8px', minHeight: '40px',
                  animation: bmcFaulted ? 'faultPulse 1.4s ease-in-out infinite' : 'none',
                }}>
                  <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: bmcFaulted ? '#ff4444' : '#c084fc', boxShadow: bmcFaulted ? '0 0 6px rgba(255,68,68,0.9)' : '0 0 4px rgba(192,132,252,0.5)', flexShrink: 0 }} />
                  <span style={{ ...fontStyle, color: bmcFaulted ? '#ff9999' : '#7a5aaa' }}>BMC Card</span>
                </div>
                <div id="rot-card" style={{
                  backgroundImage: 'radial-gradient(circle at 3px 3px, rgba(251,191,36,0.06) 0.5px, transparent 0.5px), linear-gradient(180deg, #1a1e28 0%, #111620 100%)',
                  backgroundSize: '6px 6px, 100% 100%',
                  border: rotFaulted ? faultBorder : '1px solid #2a3040',
                  boxShadow: rotFaulted ? faultGlow : 'none',
                  borderRadius: '2px', display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 8px',
                  animation: rotFaulted ? 'faultPulse 1.4s ease-in-out infinite' : 'none',
                }}>
                  <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: rotFaulted ? '#ff4444' : '#fbbf24', boxShadow: rotFaulted ? '0 0 6px rgba(255,68,68,0.9)' : '0 0 4px rgba(251,191,36,0.4)', flexShrink: 0 }} />
                  <span style={{ ...fontStyle, color: rotFaulted ? '#ff9999' : '#607090' }}>ROT 4.1</span>
                </div>
              </div>

              {/* Center: Retimer BD */}
              <div style={{ backgroundImage: 'radial-gradient(circle at 3.5px 3.5px, rgba(200,220,50,0.08) 0.6px, transparent 0.6px), repeating-linear-gradient(90deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px, transparent 1px, transparent 7px), linear-gradient(180deg, #22280f 0%, #161a08 100%)', backgroundSize: '7px 7px, 7px 7px, 100% 100%', border: '1px solid #3e4a1a', borderRadius: '2px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px 8px', boxShadow: 'inset 0 1px 0 rgba(200,220,50,0.04)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '3px', width: '100%' }}>
                  {IOU_GXR3_NUMBERS.map((iou) => (
                    <GXR3VRetimer key={iou} id={`retimer-${iou}`} name={`IOU ${iou} GXR3`}
                      onClick={() => {}}
                      faulted={faults.retimerIds.includes(`retimer-${iou}`)} />
                  ))}
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ ...fontStyle, fontSize: '9px', color: '#8a9a45' }}>8x GXR3V2</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '7px', color: '#5a6a30', letterSpacing: '0.04em', textTransform: 'uppercase', marginTop: '2px' }}>Retimer BD</div>
                </div>
              </div>

              {/* Right: E1S B + filler */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <E1SBoard id="e1s-b" name="8x E1S B" faulted={faults.e1sIds.includes('e1s-b')} />
                <div style={{ flex: 1, background: 'linear-gradient(180deg, #161a1e 0%, #0e1114 100%)', border: '1px solid #222628', borderRadius: '2px' }} />
              </div>
            </div>
          </div>
        ) : (
          <ServerComponent id="iob-tray" name="IOB Tray"
            color="green"
            alert={has('iob')}
            interactive onClick={handleIobClick}
            style={{ height: '120px' }} />
        )}

        {/* PSU */}
        {expandedPsu ? (
          <div style={{ width: '100%' }}>
            <div style={backLinkStyle('red')} onClick={handlePsuClick} role="button" tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handlePsuClick()}>
              ← PSU
            </div>
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
        ) : (
          <ServerComponent id="psu" name="PSU"
            color="red"
            alert={has('psu')}
            interactive onClick={handlePsuClick} />
        )}

      </ServerContainer>
    </div>
  );
}

export default ServerOverview;
