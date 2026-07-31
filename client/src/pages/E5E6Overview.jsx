import { useState, useEffect, useRef } from 'react';
import { useServerData } from '../hooks/useServerData';
import OSFPModule from '../components/OSFPModules/OSFPModule';
import FanModule from '../components/FanModule/FanModule';
import PSUPort from '../components/PSUPorts/PSUPort';
import DimmModule from '../components/DimmModule/DimmModule';

const EMPTY_FAULTS = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };

// Same palette/fault convention as ServerOverview.jsx (never red for a category — red is fault-only).
const VIEW_COLORS = {
  front: { background: 'linear-gradient(180deg, #243d64 0%, #182a48 100%)', border: '#3a5a8f', color: '#a8c4e8' },
  back: { background: 'linear-gradient(180deg, #1e4a38 0%, #143528 100%)', border: '#3a7a5a', color: '#a8dcc0' },
};

// Front panel: 10 IOU bays in two rows, matching the unit's own silkscreen layout — top row reads
// 6-10 left to right, bottom row reads 1-5 left to right (not a simple 1-10 sequence).
const IOU_ROWS = [
  [6, 7, 8, 9, 10],
  [1, 2, 3, 4, 5],
];

// Fixed-function bays; every other IOU is a plain general-purpose slot (its own label just stays
// "IOU {n}", same as an OSFP module with nothing special behind it). IOU8 hosts two independent
// SSDs, hence the combined label.
const IOU_ROLES = {
  1: 'ROT/FIM',
  3: 'NIC',
  6: 'Ortano Card',
  8: 'SSD0 / SSD1',
};

// Shared exact height for whichever view (Front/Back) is active (see the render below for why) —
// Back's own natural height (the 3x-zoomed fan modules are taller than Front's 2 IOU rows), so
// Front's shorter content centers within the extra space rather than shrinking Back's fans to fit
// Front's natural height instead. Measured live (both views' natural, unconstrained heights).
const VIEW_CONTENT_HEIGHT = 170;

// This chassis carries 12 DIMM slots per CPU (0-11), not the B300's 16 (0-15) — same
// "Motherboard is an external head-node unit, not a rack slot" convention as ServerOverview.jsx,
// just with this platform's own slot count.
const DIMM_SLOTS = Array.from({ length: 12 }, (_, i) => i);

const faultBorder = '1px solid #ff4444';
const faultGlow = '0 0 18px rgba(255,68,68,0.75), 0 0 36px rgba(255,68,68,0.4), 0 0 54px rgba(255,68,68,0.15)';

const pillTagStyle = {
  fontFamily: "'JetBrains Mono', monospace", fontSize: '7px', fontWeight: 700,
  letterSpacing: '0.04em', color: '#a8bad6', background: '#1a1e28',
  border: '1px solid #333', borderRadius: '2px', padding: '1px 4px',
  whiteSpace: 'nowrap', textAlign: 'center',
};

function E5E6Overview({ refreshKey = 0, faults = EMPTY_FAULTS, chassisModel }) {
  const { data: server, loading, error } = useServerData('server-1', refreshKey);
  // 'front' or 'back' — only one face is ever shown at once, toggled the same way the B300/E5-2c
  // page switch itself works (see App.jsx), rather than stacking both faces on top of each other.
  const [view, setView] = useState('front');
  // Keyed by IOU number (1-10) — toggles that bay's own IOU-number reveal, same click-to-expand
  // convention as ServerOverview.jsx's OSFP modules (there, the always-visible label is the
  // generic "OSFP {slot}" and clicking reveals the specific "IOU {n}" it's wired to; here it's
  // inverted — the always-visible label is the bay's specific role/alias when it has one, and
  // clicking reveals the generic "IOU {n}" bay number underneath it).
  const [expandedIou, setExpandedIou] = useState({});
  // Motherboard is its own collapsed-by-default external panel, same as ServerOverview.jsx's —
  // it's cabled in from the head node, not one of this chassis's own Front/Back bays.
  const [expandedMb, setExpandedMb] = useState(false);
  const prevFaults = useRef(EMPTY_FAULTS);

  const toggleIou = (n) => setExpandedIou((prev) => ({ ...prev, [n]: !prev[n] }));
  const handleMbClick = () => setExpandedMb((prev) => !prev);

  const mbFaulted = (faults.components || []).includes('mb') || (faults.dimmIds || []).length > 0;

  // Auto-expand the moment a DIMM/motherboard fault first arrives, same as ServerOverview.jsx.
  useEffect(() => {
    const prev = prevFaults.current;
    const justFaulted = mbFaulted
      && !(prev.components || []).includes('mb') && !(prev.dimmIds || []).length;
    if (justFaulted) setExpandedMb(true);
    prevFaults.current = faults;
  }, [faults, mbFaulted]);

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

  const mbCableColor = mbFaulted ? '#ff4444' : '#c08a3a';
  const mbPlugStyle = {
    width: '5px', height: '12px', borderRadius: '1px', flexShrink: 0,
    background: 'linear-gradient(180deg, #222 0%, #1a1a1a 100%)',
    border: `1px solid ${mbCableColor}`,
    boxShadow: mbFaulted ? faultGlow : 'inset 0 0 3px rgba(0,0,0,0.6)',
  };

  const renderIou = (n) => {
    const faulted = iouFaulted(n);
    return (
      <div key={n} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <OSFPModule id={`iou-${n}`} name={IOU_ROLES[n] || `IOU ${n}`} onClick={() => toggleIou(n)} hasFault={faulted}
          bodyStyle={{ height: '78px' }} labelStyle={{ fontSize: '11px' }} />
        {expandedIou[n] && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }} title={`Bay IOU ${n}`}>
            <div style={{ flex: 1, height: 0, borderTop: '2px dotted #5a7ab0' }} />
            <div style={pillTagStyle}>IOU {n}</div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start' }}>
    <div style={{
      width: '900px', display: 'flex', flexDirection: 'column', gap: '4px',
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
        {chassisModel || 'E5-2c/E6-2c'} — SN: {server.serialNumber}
      </div>

      <div style={{ display: 'flex', borderRadius: '4px', border: '1px solid #33405a', overflow: 'hidden', width: 'fit-content', marginBottom: '8px' }}>
        {[{ key: 'front', label: 'Front' }, { key: 'back', label: 'Back' }].map((opt) => (
          <button
            key={opt.key}
            onClick={() => setView(opt.key)}
            style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase', padding: '5px 14px',
              cursor: 'pointer', border: 'none',
              background: view === opt.key ? VIEW_COLORS[opt.key].background : 'transparent',
              color: view === opt.key ? VIEW_COLORS[opt.key].color : '#6a7a99',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Both views share the same fixed height (not just a matching minHeight — an exact height,
          with each view's own content vertically centered inside it) so toggling Front/Back never
          visibly resizes the chassis box. Front's own natural height (2 IOU rows) is only ~80px,
          shorter than Back's ~170px (dominated by the 3x-zoomed fan modules) — VIEW_CONTENT_HEIGHT
          uses the taller of the two so Front centers within the extra space instead of shrinking
          Back's fans down to fit. */}
      {view === 'front' && (
        <div style={{ height: VIEW_CONTENT_HEIGHT, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '6px' }}>
          {IOU_ROWS.map((row) => (
            <div key={row.join('-')} style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '6px' }}>
              {row.map((n) => renderIou(n))}
            </div>
          ))}
        </div>
      )}

      {/* Back — PS0, the 3 fans, and PS1 all sit in one row (the fans rest between the two PSUs,
          not stacked above them). `zoom` (not `transform: scale`) scales each module's actual
          layout footprint along with its rendered pixels, so this row grows to fit them
          automatically instead of needing a manually-sized wrapper the way transform would.
          FanModule/PSUPort are shared with the B300 page (sized for its dense 6-wide grids there),
          so the size bump is applied per-instance here rather than touching their CSS modules
          directly. */}
      {view === 'back' && (
        // alignItems:'flex-end' (not 'center') so the fans and PS0/PS1 sit flush along a shared
        // bottom edge instead of each centering independently — since this row already fills the
        // full VIEW_CONTENT_HEIGHT, that bottom edge is also the container's own bottom, which is
        // what puts the whole row near the bottom of the chassis box rather than mid-height.
        <div style={{ height: VIEW_CONTENT_HEIGHT, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          {/* PSUPort's own width:100% (sized for a grid cell on the B300 page) would otherwise
              stretch to fill this flex row — a fixed-width wrapper keeps each one to the "smaller
              rectangular" size the real PS0/PS1 bays actually are. zoom stays 1.5 (keeps PSU height
              at half the fan modules' zoomed height, per spec) — the *base* width was shrunk from
              140px to 100px instead of touching zoom, since at 140px the row's total fixed content
              (2 PSUs + 3 zoomed square fans + gaps) exceeded the 900px container's inner width and
              bled off the edges once flexShrink:0 stopped it from silently compressing instead. */}
          <div style={{ width: '100px', flexShrink: 0, zoom: 1.5 }}><PSUPort id="psu-port-1" name="PS0" faulted={psuFaulted(0)} /></div>
          <div style={{ display: 'flex', gap: '40px', flexShrink: 0, alignItems: 'flex-end' }}>
            {[0, 1, 2].map((n) => (
              // FanModule's own box is content-sized (narrower than tall) — style={{width}} forces
              // it square (to its own natural height) before zoom scales the whole thing up 3x.
              <div key={n} style={{ flexShrink: 0, zoom: 3 }}>
                <FanModule number={n} faulted={fanFaulted(n)} style={{ width: '47px' }} />
              </div>
            ))}
          </div>
          <div style={{ width: '100px', flexShrink: 0, zoom: 1.5 }}><PSUPort id="psu-port-2" name="PS1" faulted={psuFaulted(1)} /></div>
        </div>
      )}
    </div>

      {/* Motherboard — external head-node unit cabled in, not one of this chassis's own Front/Back
          bays, same convention as ServerOverview.jsx's own Motherboard panel. marginTop is a fixed
          value (not view-dependent) since the outer chassis card's own height doesn't change
          between Front/Back — tuned so the cable points at the chassis card's vertical center in
          both collapsed and expanded states. */}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: expandedMb ? '-43px' : '120px', flexShrink: 0 }}
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
            width: expandedMb ? '230px' : '170px',
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
                    CPU {cpu}
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

export default E5E6Overview;
