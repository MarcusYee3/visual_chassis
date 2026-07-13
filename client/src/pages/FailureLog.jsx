import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getAllPartFailures } from '../services/api';

const fontStyle = { fontFamily: "'JetBrains Mono', monospace" };

function FailureLog() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getAllPartFailures()
      .then(setEntries)
      .catch((e) => setError(e.message || 'Failed to load failure log'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ ...fontStyle, padding: '20px', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2 style={{ color: '#cdd6e8', fontSize: '16px', letterSpacing: '0.04em', margin: 0 }}>PART FAILURE LOG</h2>
        <Link to="/" style={{ color: '#a8c4e8', fontSize: '11px', textDecoration: 'none' }}>← Back to Diagnostics</Link>
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
              <th style={{ padding: '6px 8px' }}>Logged At</th>
              <th style={{ padding: '6px 8px' }}>Serial Number</th>
              <th style={{ padding: '6px 8px' }}>Part</th>
              <th style={{ padding: '6px 8px' }}>Check</th>
              <th style={{ padding: '6px 8px' }}>Source</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} style={{ borderBottom: '1px solid #23293b', color: '#cdd6e8' }}>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{e.logged_at}</td>
                <td style={{ padding: '6px 8px' }}>{e.serial_number}</td>
                <td style={{ padding: '6px 8px' }}>{e.part_label}</td>
                <td style={{ padding: '6px 8px', color: '#999' }}>{e.check_name || '—'}</td>
                <td style={{ padding: '6px 8px', color: '#999' }}>{e.source || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default FailureLog;
