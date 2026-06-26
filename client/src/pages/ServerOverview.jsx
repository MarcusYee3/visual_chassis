import { useState, useEffect } from 'react';
import ServerContainer from '../components/ServerContainer/ServerContainer';
import ServerComponent from '../components/ServerComponent/ServerComponent';
import OSFPModule from '../components/OSFPModules/OSFPModule';
import PCIePort from '../components/PCIePorts/PCIePort';
import PSUPort from '../components/PSUPorts/PSUPort';
import E1SBoard from '../components/E1SBoards/E1SBoard';
import GXR3VRetimer from '../components/GXR3VRetimer/GXR3VRetimer';
import { useServerData } from '../hooks/useServerData';
import { getOSFPModules, getPCIePorts, getPSUPorts } from '../services/api';

const backLinkStyle = {
  cursor: 'pointer',
  padding: '5px 10px',
  marginBottom: '8px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#a8c4d8',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  background: 'linear-gradient(180deg, #243040 0%, #18222e 100%)',
  border: '1px solid #3a5060',
  borderRadius: '3px',
  transition: 'all 0.15s',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 3px rgba(0,0,0,0.3)',
  userSelect: 'none',
};

function ServerOverview({ refreshKey = 0, highlight }) {
  const { data: server, loading, error } = useServerData('server-1', refreshKey);
  const [expandedGbb, setExpandedGbb] = useState(false);
  const [osfpModules, setOsfpModules] = useState([]);
  const [expandedOsfp, setExpandedOsfp] = useState({});
  const [pciePorts, setPciePorts] = useState({});
  const [expandedIob, setExpandedIob] = useState(false);
  const [expandedPsu, setExpandedPsu] = useState(false);
  const [psuPorts, setPsuPorts] = useState([]);

  useEffect(() => {
    if (expandedGbb && osfpModules.length === 0) {
      getOSFPModules('server-1')
        .then(setOsfpModules)
        .catch(console.error);
    }
  }, [expandedGbb, osfpModules.length]);

  useEffect(() => {
    if (expandedPsu && psuPorts.length === 0) {
      getPSUPorts('server-1')
        .then(setPsuPorts)
        .catch(console.error);
    }
  }, [expandedPsu, psuPorts.length]);

  const handleGbbClick = () => {
    setExpandedGbb(!expandedGbb);
  };

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

  const handleIobClick = () => {
    setExpandedIob(!expandedIob);
  };

  const handlePsuClick = () => {
    setExpandedPsu(!expandedPsu);
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 20px', color: '#999' }}>
        <p>Loading server data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 20px', color: '#c33' }}>
        <p>Error loading server data: {error}</p>
      </div>
    );
  }

  if (!server) {
    return null;
  }

  const topRow = psuPorts.filter((p) => {
    const num = parseInt(p.name.replace(/\D/g, ''), 10);
    return num >= 7 && num <= 12;
  });
  const bottomRow = psuPorts.filter((p) => {
    const num = parseInt(p.name.replace(/\D/g, ''), 10);
    return num >= 1 && num <= 6;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <ServerContainer label={`${server.name} — SN: ${server.serialNumber}`}>
        {expandedGbb ? (
          <div style={{ width: '100%' }}>
            <div
              style={backLinkStyle}
              onClick={handleGbbClick}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleGbbClick()}
            >
              ← GBB Tray
            </div>
            <div style={{ display: 'flex', gap: '4px' }}>
              {osfpModules.map((mod) =>
                expandedOsfp[mod.id] ? (
                  <div key={mod.id} style={{ flex: 1 }}>
                    <div
                      style={{ ...backLinkStyle, fontSize: '12px', marginBottom: '4px' }}
                      onClick={() => handleOsfpClick(mod.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleOsfpClick(mod.id)}
                    >
                      ← {mod.name}
                    </div>
                    <div style={{ display: 'flex', gap: '3px' }}>
                      {(pciePorts[mod.id] || []).map((port) => (
                        <PCIePort
                          key={port.id}
                          id={port.id}
                          name={port.name}
                          status={port.status}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <OSFPModule
                    key={mod.id}
                    id={mod.id}
                    name={mod.name}
                    onClick={() => handleOsfpClick(mod.id)}
                  />
                )
              )}
            </div>
          </div>
        ) : (
          <ServerComponent
            id="gbb-tray"
            name="GBB Tray"
            color={highlight === 'gbb' ? 'alert' : 'blue'}
            interactive
            onClick={handleGbbClick}
          />
        )}
        <ServerComponent
          id="gpu-baseboard"
          name="Nvidia B300 GPU Baseboard"
          color="purple"
          interactive={false}
          style={{ height: '140px' }}
        />
        {expandedIob ? (
          <div style={{ width: '100%' }}>
            <div
              style={backLinkStyle}
              onClick={handleIobClick}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleIobClick()}
            >
              ← IOB Tray
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px' }}>
              {/* Left: 8x E1S A + BMC + ROT */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <E1SBoard id="e1s-a" name="8x E1S A" />
                <div id="bmc-card" style={{ flex: 1, background: 'linear-gradient(180deg, #1e1a30 0%, #161228 100%)', border: '1px solid #3a2a50', borderRadius: '2px', display: 'flex', alignItems: 'center', gap: '8px', padding: '0 8px', minHeight: '40px' }}>
                  <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#c084fc', boxShadow: '0 0 4px rgba(192,132,252,0.5)', flexShrink: 0 }} />
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#7a5aaa' }}>BMC Card</span>
                </div>
                <div id="rot-card" style={{ background: 'linear-gradient(180deg, #1a1e28 0%, #111620 100%)', border: '1px solid #2a3040', borderRadius: '2px', display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 8px' }}>
                  <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#fbbf24', boxShadow: '0 0 4px rgba(251,191,36,0.4)', flexShrink: 0 }} />
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#607090' }}>ROT 4.1</span>
                </div>
              </div>

              {/* Center: Retimer BD */}
              <div style={{ background: 'linear-gradient(180deg, #22280f 0%, #161a08 100%)', border: '1px solid #3e4a1a', borderRadius: '2px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px 8px', boxShadow: 'inset 0 1px 0 rgba(200,220,50,0.04)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '3px', width: '100%' }}>
                  {Array.from({ length: 8 }, (_, i) => (
                    <GXR3VRetimer
                      key={i}
                      id={`retimer-${i}`}
                      name={`Retimer ${i}`}
                      onClick={() => {}}
                    />
                  ))}
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '9px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#8a9a45' }}>8x GXR3V2</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '7px', color: '#5a6a30', letterSpacing: '0.04em', textTransform: 'uppercase', marginTop: '2px' }}>Retimer BD</div>
                </div>
              </div>

              {/* Right: 8x E1S B + empty filler */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <E1SBoard id="e1s-b" name="8x E1S B" />
                <div style={{ flex: 1, background: 'linear-gradient(180deg, #161a1e 0%, #0e1114 100%)', border: '1px solid #222628', borderRadius: '2px' }} />
              </div>
            </div>
          </div>
        ) : (
          <ServerComponent
            id="iob-tray"
            name="IOB Tray"
            color="green"
            interactive
            onClick={handleIobClick}
            style={{ height: '120px' }}
          />
        )}
        {expandedPsu ? (
          <div style={{ width: '100%' }}>
            <div
              style={backLinkStyle}
              onClick={handlePsuClick}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handlePsuClick()}
            >
              ← PSU
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '3px' }}>
                {topRow.map((port) => (
                  <PSUPort key={port.id} id={port.id} name={port.name} status={port.status} />
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '3px' }}>
                {bottomRow.map((port) => (
                  <PSUPort key={port.id} id={port.id} name={port.name} status={port.status} />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <ServerComponent
            id="psu"
            name="PSU"
            color="red"
            interactive
            onClick={handlePsuClick}
          />
        )}
      </ServerContainer>
    </div>
  );
}

export default ServerOverview;
