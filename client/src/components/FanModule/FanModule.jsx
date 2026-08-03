import styles from './FanModule.module.css';

// style is an escape hatch for a caller that needs to override this module's own intrinsic,
// content-driven box shape (e.g. forcing it square) without touching FanModule.module.css itself
// — that CSS is shared with the B300 page's dense 6-wide fan grid, which must stay unaffected.
function FanModule({ number, faulted = false, style, onClick }) {
  return (
    <div
      className={`${styles.fan} ${faulted ? styles.faulted : ''}`}
      aria-label={`Fan ${number}`}
      style={{ ...style, cursor: onClick ? 'pointer' : undefined }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
    >
      {faulted && <div className={styles.badge}>!</div>}
      <div className={styles.spinner}>
        <div className={styles.blade} />
        <div className={styles.blade} />
        <div className={styles.blade} />
        <div className={styles.hub} />
      </div>
      <div className={styles.led} />
      <span className={styles.label}>FAN {number}</span>
    </div>
  );
}

export default FanModule;
