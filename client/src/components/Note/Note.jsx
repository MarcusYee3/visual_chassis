import { useState } from 'react';
import styles from './Note.module.css';
import { diagnoseServer } from '../../services/api';
import { mergeFaultsClient } from '../../utils/mergeFaults';

const EMPTY_FAULTS = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };

function NoteEntry({ record, onHighlight, serialNumber }) {
  const [expanded, setExpanded] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const isFail = record.ok === '0';

  const handleToggle = async () => {
    const next = !expanded;
    setExpanded(next);

    if (!next) {
      onHighlight?.(null);
      return;
    }

    if (isFail && serialNumber) {
      setDiagnosing(true);
      try {
        // diagnoseServer now streams one partial fault fragment per command as it completes
        // (see services/api.js) rather than one final blob — accumulate them the same way App.jsx
        // does and only highlight once the stream ends, so this still reads as one atomic result.
        let accumulated = EMPTY_FAULTS;
        await diagnoseServer('server-1', serialNumber, undefined, undefined, (event) => {
          if (event.type === 'partial') accumulated = mergeFaultsClient(accumulated, event.faults);
        });
        onHighlight?.({ faults: accumulated });
      } catch (e) {
        console.error('Diagnose failed:', e);
      } finally {
        setDiagnosing(false);
      }
    }
  };

  return (
    <div className={`${styles.entry} ${isFail ? styles.fail : styles.pass}`}>
      <div
        className={styles.entryHeader}
        onClick={handleToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleToggle()}
      >
        <span className={styles.taskcase}>{record.taskcase}</span>
        <div className={styles.headerRight}>
          <span className={styles.timestamp}>{record.Finished}</span>
          {diagnosing && <span className={styles.diagnosing}>scanning…</span>}
          <span className={isFail ? styles.statusFail : styles.statusPass}>
            {isFail ? 'FAIL' : 'PASS'}
          </span>
          <span className={styles.chevron}>{expanded ? '▾' : '▸'}</span>
        </div>
      </div>
      {expanded && <p className={styles.message}>{record.taskcase_message}</p>}
    </div>
  );
}

function sortRecords(records, sortBy) {
  const sorted = [...records];
  if (sortBy === 'time') {
    sorted.sort((a, b) => new Date(b.Finished) - new Date(a.Finished));
  } else if (sortBy === 'status') {
    sorted.sort((a, b) => {
      if (a.ok === b.ok) return new Date(b.Finished) - new Date(a.Finished);
      return a.ok === '0' ? -1 : 1;
    });
  }
  return sorted;
}

function Note({ records, onHighlight, serialNumber }) {
  const [collapsed, setCollapsed] = useState(false);
  const [sortBy, setSortBy] = useState('time');

  return (
    <div className={styles.container}>
      <h2
        className={styles.title}
        onClick={() => setCollapsed(!collapsed)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setCollapsed(!collapsed)}
      >
        <span className={styles.chevron}>{collapsed ? '▸' : '▾'}</span>
        Task Messages
        {records && records.length > 0 && <span className={styles.count}>({records.length})</span>}
      </h2>
      {!collapsed && (
        !records || records.length === 0 ? (
          <p className={styles.empty}>No records loaded. Submit a serial number to view task messages.</p>
        ) : (
          <>
            <div className={styles.sortBar}>
              <span className={styles.sortLabel}>Sort:</span>
              <button
                className={`${styles.sortBtn} ${sortBy === 'time' ? styles.sortActive : ''}`}
                onClick={() => setSortBy('time')}
              >
                Time
              </button>
              <button
                className={`${styles.sortBtn} ${sortBy === 'status' ? styles.sortActive : ''}`}
                onClick={() => setSortBy('status')}
              >
                Pass / Fail
              </button>
            </div>
            <div className={styles.list}>
              {sortRecords(records, sortBy).map((record, i) => (
                <NoteEntry key={i} record={record} onHighlight={onHighlight} serialNumber={serialNumber} />
              ))}
            </div>
          </>
        )
      )}
    </div>
  );
}

export default Note;
