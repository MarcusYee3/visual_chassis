import styles from './PCIeSwitch.module.css';

function PCIeSwitch({ id, label, faulted = false, title, onClick }) {
  return (
    <div
      id={id}
      className={`${styles.chip} ${faulted ? styles.faulted : ''}`}
      aria-label={title || label}
      title={title}
      style={{ cursor: onClick ? 'pointer' : undefined }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
    >
      <div className={styles.pinRow} />
      <div className={styles.body}>
        <span className={styles.label}>{label}</span>
      </div>
      <div className={styles.pinRow} />
    </div>
  );
}

export default PCIeSwitch;
