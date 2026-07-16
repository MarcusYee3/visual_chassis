import styles from './PCIeSwitch.module.css';

function PCIeSwitch({ id, label, faulted = false, title }) {
  return (
    <div id={id} className={`${styles.chip} ${faulted ? styles.faulted : ''}`} aria-label={title || label} title={title}>
      <div className={styles.pinRow} />
      <div className={styles.body}>
        <span className={styles.label}>{label}</span>
      </div>
      <div className={styles.pinRow} />
    </div>
  );
}

export default PCIeSwitch;
