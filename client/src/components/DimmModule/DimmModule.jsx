import styles from './DimmModule.module.css';

function DimmModule({ cpu, slot, faulted = false }) {
  return (
    <div
      className={`${styles.dimm} ${faulted ? styles.faulted : ''}`}
      aria-label={`P${cpu} D${slot}`}
      title={`/SYS/MB/P${cpu}/D${slot}${faulted ? ' — FAILED' : ''}`}
    >
      {faulted && <div className={styles.badge}>!</div>}
      <div className={styles.notch} />
      <span className={styles.label}>D{slot}</span>
    </div>
  );
}

export default DimmModule;
