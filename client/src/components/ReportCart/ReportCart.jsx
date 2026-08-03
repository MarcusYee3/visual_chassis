import { useState } from 'react';
import { logPartFailure } from '../../services/api';

const fontStyle = { fontFamily: "'JetBrains Mono', monospace" };

const panelStyle = {
  ...fontStyle,
  width: '100%',
  maxWidth: '740px',
  padding: '12px 14px',
  background: 'linear-gradient(180deg, #1c2333 0%, #161b28 100%)',
  border: '1px solid #3a4a6b',
  borderRadius: '6px',
  boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
};

const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' };
const labelStyle = { fontSize: '11px', fontWeight: 700, letterSpacing: '0.03em', color: '#cdd6e8' };
const buttonStyle = (variant) => ({
  ...fontStyle,
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  padding: '5px 10px',
  borderRadius: '3px',
  cursor: 'pointer',
  border: variant === 'danger' ? '1px solid #8a3a3a' : '1px solid #3a5a8f',
  background: variant === 'danger'
    ? 'linear-gradient(180deg, #542424 0%, #3c1818 100%)'
    : 'linear-gradient(180deg, #243d64 0%, #182a48 100%)',
  color: variant === 'danger' ? '#e8b0b0' : '#a8c4e8',
});

// Manual "report any part" flow: a chassis part click (gated behind report mode in App.jsx) sets
// pendingPart here, this renders a blocking confirm overlay for it, and a confirmed part is added
// to the cart (owned by the caller, since the click originates deep in the chassis tree) rather
// than posted immediately — the caller pushes every cart entry at once via handlePushAll.
function ReportCart({ serialNumber, cart, onRemove, pendingPart, onConfirmPending, onCancelPending }) {
  const [pushing, setPushing] = useState(false);
  const [notice, setNotice] = useState('');

  const handlePushAll = async () => {
    setNotice('');
    setPushing(true);
    let pushedCount = 0;
    let failedCount = 0;
    try {
      for (const part of cart) {
        try {
          // eslint-disable-next-line no-await-in-loop -- entries must land in the log in the order
          // the user added them, and the list is small (a manual reporting session, not a bulk import)
          await logPartFailure({
            serialNumber,
            partId: part.partId,
            partLabel: part.partLabel,
            source: 'manual-report',
          });
          onRemove(part.partId);
          pushedCount++;
        } catch {
          failedCount++;
        }
      }
      const summary = [];
      if (pushedCount > 0) summary.push(`pushed ${pushedCount} failure${pushedCount === 1 ? '' : 's'}`);
      if (failedCount > 0) summary.push(`${failedCount} failed — still in cart, try again`);
      setNotice(summary.join('; '));
    } finally {
      setPushing(false);
    }
  };

  return (
    <div style={panelStyle}>
      <div style={rowStyle}>
        <span style={{ ...labelStyle, color: '#8fa8d6' }}>REPORT CART — {serialNumber} ({cart.length})</span>
        <button
          style={{ ...buttonStyle(), opacity: (pushing || cart.length === 0) ? 0.5 : 1, cursor: (pushing || cart.length === 0) ? 'default' : 'pointer' }}
          onClick={handlePushAll}
          disabled={pushing || cart.length === 0}
        >
          {pushing ? 'Pushing…' : `Push All (${cart.length})`}
        </button>
      </div>

      {cart.length === 0 && (
        <div style={{ ...fontStyle, fontSize: '10px', color: '#6a7a99' }}>
          No parts queued yet — click a part on the chassis to report it.
        </div>
      )}

      {cart.map((part) => (
        <div key={part.partId} style={rowStyle}>
          <span style={labelStyle}>{part.partLabel}</span>
          <span
            style={{ cursor: 'pointer', color: '#6a7a99', fontSize: '13px' }}
            onClick={() => onRemove(part.partId)}
            role="button" tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onRemove(part.partId)}
          >✕</span>
        </div>
      ))}

      {notice && <div style={{ ...fontStyle, fontSize: '10px', color: '#a8c4e8' }}>{notice}</div>}

      {pendingPart && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{ ...panelStyle, maxWidth: '420px', border: '1px solid #3a5a8f' }}>
            <div style={{ ...labelStyle, color: '#a8c4e8' }}>REPORT ISSUE</div>
            <div style={{ ...fontStyle, fontSize: '11px', color: '#cdd6e8', lineHeight: 1.5 }}>
              Report <strong>{pendingPart.partLabel}</strong> as failed on <strong>{serialNumber}</strong>? It will
              be added to your report cart, not logged yet.
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button style={buttonStyle()} onClick={onCancelPending}>Cancel</button>
              <button style={buttonStyle('danger')} onClick={onConfirmPending}>Add to Cart</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ReportCart;
