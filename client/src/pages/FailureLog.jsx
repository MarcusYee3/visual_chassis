import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getAllPartFailures, deletePartFailures } from '../services/api';

const fontStyle = { fontFamily: "'JetBrains Mono', monospace" };

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

function FailureLog() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(new Set());
  // { ids: [...], label } — label is what the confirmation dialog names (one part's label for a
  // single-row delete, or "N entries" for a bulk delete), so one dialog covers both flows.
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    getAllPartFailures()
      .then(setEntries)
      .catch((e) => setError(e.message || 'Failed to load failure log'))
      .finally(() => setLoading(false));
  }, []);

  const toggleSelected = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runDelete = async (ids) => {
    setDeleting(true);
    setError('');
    try {
      await deletePartFailures(ids);
      const idSet = new Set(ids);
      setEntries((prev) => prev.filter((e) => !idSet.has(e.id)));
      setSelected((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      setConfirmTarget(null);
    } catch (e) {
      setError(e.message || 'Failed to delete part failure(s)');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div style={{ ...fontStyle, padding: '20px', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2 style={{ color: '#cdd6e8', fontSize: '16px', letterSpacing: '0.04em', margin: 0, display: 'flex', alignItems: 'baseline', gap: '10px' }}>
          PART FAILURE LOG
          {!loading && !error && (
            <span style={{ color: '#8fa8d6', fontSize: '11px', fontWeight: 400, letterSpacing: '0.03em' }}>
              ({entries.length} logged)
            </span>
          )}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          {selected.size > 0 && (
            <button
              style={buttonStyle('danger')}
              onClick={() => setConfirmTarget({ ids: [...selected], label: `${selected.size} entr${selected.size === 1 ? 'y' : 'ies'}` })}
            >
              Delete Selected ({selected.size})
            </button>
          )}
          <Link to="/" style={{ color: '#a8c4e8', fontSize: '11px', textDecoration: 'none' }}>← Back to Diagnostics</Link>
        </div>
      </div>

      {loading && <p style={{ color: '#999' }}>Loading…</p>}
      {error && <p style={{ color: '#ff8080' }}>{error}</p>}

      {!loading && !error && entries.length === 0 && (
        <p style={{ color: '#999', fontSize: '12px' }}>No part failures logged yet.</p>
      )}

      {!loading && entries.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#8fa8d6', borderBottom: '1px solid #3a4a6b' }}>
              <th style={{ padding: '6px 8px', width: '20px' }}></th>
              <th style={{ padding: '6px 8px' }}>Logged At</th>
              <th style={{ padding: '6px 8px' }}>Serial Number</th>
              <th style={{ padding: '6px 8px' }}>Part</th>
              <th style={{ padding: '6px 8px' }}>Check</th>
              <th style={{ padding: '6px 8px' }}>Source</th>
              <th style={{ padding: '6px 8px' }}></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} style={{ borderBottom: '1px solid #23293b', color: '#cdd6e8' }}>
                <td style={{ padding: '6px 8px' }}>
                  <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleSelected(e.id)} />
                </td>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{e.logged_at}</td>
                <td style={{ padding: '6px 8px' }}>{e.serial_number}</td>
                <td style={{ padding: '6px 8px' }}>{e.part_label}</td>
                <td style={{ padding: '6px 8px', color: '#999' }}>{e.check_name || '—'}</td>
                <td style={{ padding: '6px 8px', color: '#999' }}>{e.source || '—'}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                  <button
                    style={{ ...buttonStyle('danger'), padding: '3px 8px', fontSize: '9px' }}
                    onClick={() => setConfirmTarget({ ids: [e.id], label: `${e.part_label} on ${e.serial_number}` })}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirmTarget && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            ...fontStyle, maxWidth: '420px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px',
            background: 'linear-gradient(180deg, #1c2333 0%, #161b28 100%)',
            border: '1px solid #8a3a3a', borderRadius: '6px', boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
          }}>
            <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.03em', color: '#e8b0b0' }}>DELETE FAILURE LOG {confirmTarget.ids.length > 1 ? 'ENTRIES' : 'ENTRY'}</div>
            <div style={{ fontSize: '11px', color: '#cdd6e8', lineHeight: 1.5 }}>
              Permanently delete <strong>{confirmTarget.label}</strong> from the failure log? This cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button style={buttonStyle()} onClick={() => setConfirmTarget(null)} disabled={deleting}>Cancel</button>
              <button
                style={{ ...buttonStyle('danger'), opacity: deleting ? 0.6 : 1, cursor: deleting ? 'default' : 'pointer' }}
                onClick={() => runDelete(confirmTarget.ids)}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default FailureLog;
