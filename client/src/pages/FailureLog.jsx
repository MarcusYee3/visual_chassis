import { useState, useEffect, useMemo } from 'react';
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

const inputStyle = {
  ...fontStyle,
  fontSize: '11px',
  padding: '5px 8px',
  borderRadius: '3px',
  border: '1px solid #33405a',
  background: '#161b28',
  color: '#cdd6e8',
};

const cardStyle = {
  ...fontStyle,
  flex: 1,
  padding: '10px 12px',
  borderRadius: '6px',
  border: '1px solid #2a3550',
  backgroundImage: 'radial-gradient(circle at 3px 3px, rgba(168,196,232,0.04) 0.5px, transparent 0.5px), linear-gradient(180deg, #1a2030 0%, #141926 100%)',
  backgroundSize: '6px 6px, 100% 100%',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
};

const cardLabelStyle = {
  fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6a7a99',
};

// Top N [key, count] pairs from a plain tally object, most-frequent first — used for both the
// "top failing part" and "top failing check" stat cards below.
function topEntries(tally, n) {
  return Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function FailureLog() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(new Set());
  // { ids: [...], label } — label is what the confirmation dialog names (one part's label for a
  // single-row delete, or "N entries" for a bulk delete), so one dialog covers both flows.
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [checkFilter, setCheckFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    getAllPartFailures()
      .then(setEntries)
      .catch((e) => setError(e.message || 'Failed to load failure log'))
      .finally(() => setLoading(false));
  }, []);

  // Stats reflect the *whole* log regardless of the filters below — an overall health summary,
  // not a recap of whatever's currently being searched for.
  const stats = useMemo(() => {
    const byPart = {};
    const byCheck = {};
    const byUnit = {};
    for (const e of entries) {
      byPart[e.part_label] = (byPart[e.part_label] || 0) + 1;
      byCheck[e.check_name || 'Unknown'] = (byCheck[e.check_name || 'Unknown'] || 0) + 1;
      byUnit[e.serial_number] = (byUnit[e.serial_number] || 0) + 1;
    }
    return {
      total: entries.length,
      topParts: topEntries(byPart, 3),
      topChecks: topEntries(byCheck, 3),
      repeatUnits: Object.values(byUnit).filter((count) => count > 1).length,
    };
  }, [entries]);

  const checkOptions = useMemo(
    () => [...new Set(entries.map((e) => e.check_name).filter(Boolean))].sort(),
    [entries]
  );

  const hasActiveFilter = !!(search || checkFilter || dateFrom || dateTo);

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (q && !e.serial_number.toLowerCase().includes(q) && !e.part_label.toLowerCase().includes(q)) return false;
      if (checkFilter && e.check_name !== checkFilter) return false;
      if (dateFrom && e.logged_at < dateFrom) return false;
      if (dateTo && e.logged_at > `${dateTo} 23:59:59`) return false;
      return true;
    });
  }, [entries, search, checkFilter, dateFrom, dateTo]);

  const clearFilters = () => {
    setSearch('');
    setCheckFilter('');
    setDateFrom('');
    setDateTo('');
  };

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

      {!loading && !error && entries.length > 0 && (
        <>
          {/* Overview stats — always the full log, independent of the search/filter bar below. */}
          <div style={{ display: 'flex', gap: '10px', marginBottom: '16px' }}>
            <div style={cardStyle}>
              <span style={cardLabelStyle}>Total Logged</span>
              <span style={{ fontSize: '20px', fontWeight: 700, color: '#cdd6e8' }}>{stats.total}</span>
            </div>
            <div style={cardStyle}>
              <span style={cardLabelStyle}>Top Failing Part{stats.topParts.length > 1 ? 's' : ''}</span>
              {stats.topParts.map(([label, count]) => (
                <span key={label} style={{ fontSize: '11px', color: '#cdd6e8' }}>{label} <span style={{ color: '#6a7a99' }}>×{count}</span></span>
              ))}
            </div>
            <div style={cardStyle}>
              <span style={cardLabelStyle}>Top Failing Check{stats.topChecks.length > 1 ? 's' : ''}</span>
              {stats.topChecks.map(([label, count]) => (
                <span key={label} style={{ fontSize: '11px', color: '#cdd6e8' }}>{label} <span style={{ color: '#6a7a99' }}>×{count}</span></span>
              ))}
            </div>
            <div style={cardStyle}>
              <span style={cardLabelStyle}>Repeat-Failure Units</span>
              <span style={{ fontSize: '20px', fontWeight: 700, color: stats.repeatUnits > 0 ? '#ff9999' : '#cdd6e8' }}>{stats.repeatUnits}</span>
            </div>
          </div>

          {/* Search/filter bar — narrows the table below only; stats above stay whole-log. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
            <input
              style={{ ...inputStyle, flex: '1 1 220px' }}
              type="text"
              placeholder="Search serial number or part…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select style={inputStyle} value={checkFilter} onChange={(e) => setCheckFilter(e.target.value)}>
              <option value="">All checks</option>
              {checkOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label style={{ fontSize: '10px', color: '#8fa8d6', display: 'flex', alignItems: 'center', gap: '4px' }}>
              From
              <input style={inputStyle} type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </label>
            <label style={{ fontSize: '10px', color: '#8fa8d6', display: 'flex', alignItems: 'center', gap: '4px' }}>
              To
              <input style={inputStyle} type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </label>
            {hasActiveFilter && (
              <button style={buttonStyle()} onClick={clearFilters}>Clear</button>
            )}
          </div>
          {hasActiveFilter && (
            <p style={{ color: '#6a7a99', fontSize: '10px', margin: '0 0 8px' }}>
              Showing {filteredEntries.length} of {entries.length} entries
            </p>
          )}
        </>
      )}

      {!loading && !error && entries.length === 0 && (
        <p style={{ color: '#999', fontSize: '12px' }}>No part failures logged yet.</p>
      )}

      {!loading && entries.length > 0 && filteredEntries.length === 0 && (
        <p style={{ color: '#999', fontSize: '12px' }}>No entries match the current filters.</p>
      )}

      {!loading && filteredEntries.length > 0 && (
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
            {filteredEntries.map((e) => (
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
