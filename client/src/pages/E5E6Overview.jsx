import { useState } from 'react';
import { useServerData } from '../hooks/useServerData';
import OSFPModule from '../components/OSFPModules/OSFPModule';
import FanModule from '../components/FanModule/FanModule';
import PSUPort from '../components/PSUPorts/PSUPort';

const EMPTY_FAULTS = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };

// Same palette/fault convention as ServerOverview.jsx (never red for a category — red is fault-only).
const SECTION_COLORS = {
  blue: { background: 'linear-gradient(180deg, #243d64 0%, #182a48 100%)', border: '#3a5a8f', color: '#a8c4e8' },
  green: { background: 'linear-gradient(180deg, #1e4a38 0%, #143528 100%)', border: '#3a7a5a', color: '#a8dcc0' },
};
const sectionHeaderStyle = (colorKey) => {
  const c = SECTION_COLORS[colorKey];
  return {
    padding: '5px 10px', marginBottom: '8px',
    fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 700,
    letterSpacing: '0.08em', textTransform: 'uppercase', color: c.color,
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    background: c.background, border: `1px solid ${c.border}`, borderRadius: '3px',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 3px rgba(0,0,0,0.3)',
  };
};

// Front panel: 10 IOU bays in two rows, matching the unit's own silkscreen layout — top row reads
// 6-10 left to right, bottom row reads 1-5 left to right (not a simple 1-10 sequence).
const IOU_ROWS = [
  [6, 7, 8, 9, 10],
  [1, 2, 3, 4, 5],
];

// Fixed-function bays; every other IOU is a plain general-purpose slot (its reveal just echoes its
// own number, same as an OSFP module with nothing special behind it). IOU8 hosts two independent
// SSDs rather than one single alias, hence the array.
const IOU_ROLES = {
  1: ['ROT/FIM'],
  3: ['NIC'],
  6: ['Ortano Card'],
  8: ['SSD0', 'SSD1'],
};

const pillTagStyle = {
  fontFamily: "'JetBrains Mono', monospace", fontSize: '7px', fontWeight: 700,
  letterSpacing: '0.04em', color: '#a8bad6', background: '#1a1e28',
  border: '1px solid #333', borderRadius: '2px', padding: '1px 4px',
  whiteSpace: 'nowrap', textAlign: 'center',
};

function E5E6Overview({ refreshKey = 0, faults = EMPTY_FAULTS, chassisModel }) {
  const { data: server, loading, error } = useServerData('server-1', refreshKey);
  // Keyed by IOU number (1-10) — toggles that bay's own role/alias reveal, same click-to-expand
  // convention as ServerOverview.jsx's OSFP modules.
  const [expandedIou, setExpandedIou] = useState({});

  const toggleIou = (n) => setExpandedIou((prev) => ({ ...prev, [n]: !prev[n] }));

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

  const iouFaulted = (n) => (faults.pcieFaults || []).some((f) => f.iou === n)
    || (faults.cableFaults || []).some((id) => id.split('-').slice(1).map(Number).includes(n));
  // The shared faults schema's fanIds/psuPorts are always 1-indexed (see
  // server/src/routes/diagnose.js's parseHwdiagFanInfo — its own reducedChassis offset comment
  // explains why), but this chassis's real silkscreen numbering is 0-indexed (Fan 0/1/2, PS0/PS1)
  // — displayed number n maps to internal id n+1.
  const fanFaulted = (displayNum) => (faults.fanIds || []).includes(displayNum + 1);
  const psuFaulted = (displayNum) => (faults.psuPorts || []).includes(`psu-port-${displayNum + 1}`);

  const renderIou = (n) => {
    const faulted = iouFaulted(n);
    const aliases = IOU_ROLES[n] || [`IOU ${n}`];
    return (
      <div key={n} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <OSFPModule id={`iou-${n}`} name={`IOU ${n}`} onClick={() => toggleIou(n)} hasFault={faulted} />
        {expandedIou[n] && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {aliases.map((alias) => (
              <div key={alias} style={{ display: 'flex', alignItems: 'center', gap: '2px' }}
                title={`IOU ${n} <-> ${alias}`}>
                <div style={{ flex: 1, height: 0, borderTop: '2px dotted #5a7ab0' }} />
                <div style={pillTagStyle}>{alias}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{
      width: '520px', display: 'flex', flexDirection: 'column', gap: '4px',
      padding: '14px', borderRadius: '8px', border: '1px solid #2a3550',
      backgroundImage: 'radial-gradient(circle at 3px 3px, rgba(168,196,232,0.04) 0.5px, transparent 0.5px), linear-gradient(180deg, #10141f 0%, #0b0e16 100%)',
      backgroundSize: '6px 6px, 100% 100%',
      boxShadow: '0 8px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.03)',
    }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', fontWeight: 700,
        letterSpacing: '0.05em', color: '#cdd6e8', textAlign: 'center',
        padding: '4px 0 10px', borderBottom: '1px solid #232a3d', marginBottom: '4px',
      }}>
        {server.name} — SN: {server.serialNumber}{chassisModel ? ` (${chassisModel})` : ''}
      </div>

      {/* Front — 10 IOU bays, top row 6-10, bottom row 1-5 (matches the unit's own silkscreen). */}
      <div>
        <div style={sectionHeaderStyle('blue')}>Front</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {IOU_ROWS.map((row) => (
            <div key={row.join('-')} style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '6px' }}>
              {row.map((n) => renderIou(n))}
            </div>
          ))}
        </div>
      </div>

      {/* Back — 3 fans centered, PS0/PS1 at the bottom-left/bottom-right corners. */}
      <div style={{ marginTop: '10px' }}>
        <div style={sectionHeaderStyle('green')}>Back</div>
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '16px', padding: '12px 10px',
          borderRadius: '4px', border: '1px solid #232a3d', background: 'rgba(30,74,56,0.08)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '14px' }}>
            {[0, 1, 2].map((n) => (
              <FanModule key={n} number={n} faulted={fanFaulted(n)} />
            ))}
          </div>
          {/* PSUPort's own width:100% (sized for a grid cell on the B300 page) would otherwise
              stretch to fill this flex row — a fixed-width wrapper keeps each one to the "smaller
              rectangular" size the real PS0/PS1 bays actually are. */}
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div style={{ width: '140px' }}><PSUPort id="psu-port-1" name="PS0" faulted={psuFaulted(0)} /></div>
            <div style={{ width: '140px' }}><PSUPort id="psu-port-2" name="PS1" faulted={psuFaulted(1)} /></div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default E5E6Overview;
