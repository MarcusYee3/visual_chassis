import styles from './DimmModule.module.css';

function DimmModule({ cpu, slot, faulted = false, onClick }) {
  return (
    <div
      className={`${styles.dimm} ${faulted ? styles.faulted : ''}`}
      aria-label={`P${cpu} D${slot}`}
      title={`/SYS/MB/P${cpu}/D${slot}${faulted ? ' — FAILED' : ''}`}
      style={{ cursor: onClick ? 'pointer' : undefined }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
    >
      {faulted && <div className={styles.badge}>!</div>}
      <div className={styles.notch} />
      <span className={styles.label}>D{slot}</span>
    </div>
  );
}

export default DimmModule;
