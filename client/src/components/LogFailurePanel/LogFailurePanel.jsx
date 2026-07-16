import { useState } from 'react';
import { checkPartFailure, logPartFailure } from '../../services/api';

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

const STATUS_IDLE = 'idle';
const STATUS_LOGGED = 'logged';

function LogFailurePanel({ serialNumber, parts, checkName, source, onDismiss }) {
  const [statusByPart, setStatusByPart] = useState({});
  const [confirmTarget, setConfirmTarget] = useState(null); // { partId, partLabel, existing }
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [bulkLogging, setBulkLogging] = useState(false);

  if (!parts || parts.length === 0) return null;

  const doLog = async (part) => {
    setError('');
    try {
      const entry = await logPartFailure({
        serialNumber,
        partId: part.partId,
        partLabel: part.partLabel,
        checkName,
        source,
      });
      setStatusByPart((prev) => ({ ...prev, [part.partId]: STATUS_LOGGED }));
      return entry;
    } catch (e) {
      setError(e.message || 'Failed to log failure');
    }
  };

  const handleLogClick = async (part) => {
    setError('');
    try {
      const existing = await checkPartFailure(serialNumber, part.partId);
      if (existing && existing.length > 0) {
        setConfirmTarget({ ...part, existing });
        return;
      }
      await doLog(part);
    } catch (e) {
      setError(e.message || 'Failed to check failure log');
    }
  };

  // Logs every part that isn't already logged (in this session or in the DB) in one click. Parts
  // that already have an existing DB entry are left alone rather than silently duplicated — the
  // user can still log those individually, which goes through the normal already-logged confirm.
  const handleLogAllClick = async () => {
    setError('');
    setNotice('');
    setBulkLogging(true);
    let loggedCount = 0;
    let skippedCount = 0;
    try {
      for (const part of parts) {
        if (statusByPart[part.partId] === STATUS_LOGGED) continue;
        const existing = await checkPartFailure(serialNumber, part.partId);
        if (existing && existing.length > 0) {
          skippedCount++;
          continue;
        }
        await doLog(part);
        loggedCount++;
      }
      const summary = [];
      if (loggedCount > 0) summary.push(`logged ${loggedCount} part${loggedCount === 1 ? '' : 's'}`);
      if (skippedCount > 0) summary.push(`${skippedCount} already logged — use its button to confirm logging again`);
      setNotice(summary.length > 0 ? summary.join('; ') : 'Nothing new to log.');
    } catch (e) {
      setError(e.message || 'Failed to log all failures');
    } finally {
      setBulkLogging(false);
    }
  };

  const allLogged = parts.every((p) => statusByPart[p.partId] === STATUS_LOGGED);

  return (
    <div style={panelStyle}>
      <div style={{ ...rowStyle }}>
        <span style={{ ...labelStyle, color: '#8fa8d6' }}>LOG PART FAILURE — {serialNumber}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            style={{ ...buttonStyle(), opacity: (bulkLogging || allLogged) ? 0.5 : 1, cursor: (bulkLogging || allLogged) ? 'default' : 'pointer' }}
            onClick={handleLogAllClick}
            disabled={bulkLogging || allLogged}
          >
            {bulkLogging ? 'Logging…' : 'Log All'}
          </button>
          <span style={{ cursor: 'pointer', color: '#6a7a99', fontSize: '13px' }} onClick={onDismiss} role="button" tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onDismiss()}>✕</span>
        </div>
      </div>

      {parts.map((part) => {
        const status = statusByPart[part.partId];
        return (
          <div key={part.partId} style={rowStyle}>
            <span style={labelStyle}>{part.partLabel}</span>
            {status === STATUS_LOGGED ? (
              <span style={{ ...fontStyle, fontSize: '10px', color: '#7ad67a', fontWeight: 700 }}>✓ LOGGED</span>
            ) : (
              <button style={buttonStyle()} onClick={() => handleLogClick(part)}>Log Failure</button>
            )}
          </div>
        );
      })}

      {notice && <div style={{ ...fontStyle, fontSize: '10px', color: '#a8c4e8' }}>{notice}</div>}
      {error && <div style={{ ...fontStyle, fontSize: '10px', color: '#ff8080' }}>{error}</div>}

      {confirmTarget && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{ ...panelStyle, maxWidth: '420px', border: '1px solid #8a6a2a' }}>
            <div style={{ ...labelStyle, color: '#e8c890' }}>ALREADY LOGGED</div>
            <div style={{ ...fontStyle, fontSize: '11px', color: '#cdd6e8', lineHeight: 1.5 }}>
              <strong>{confirmTarget.partLabel}</strong> on <strong>{serialNumber}</strong> was already logged
              {confirmTarget.existing.length > 1 ? ` ${confirmTarget.existing.length} times` : ''}, most recently at{' '}
              <strong>{confirmTarget.existing[0].logged_at}</strong>. Log it again?
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button style={buttonStyle()} onClick={() => setConfirmTarget(null)}>Cancel</button>
              <button style={buttonStyle('danger')} onClick={async () => {
                await doLog(confirmTarget);
                setConfirmTarget(null);
              }}>Log Again</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LogFailurePanel;
