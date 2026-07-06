import styles from './PCIePort.module.css';

function PCIePort({ id, name, status = 'active', faulted = false, probability = null }) {
  const statusClass = faulted ? styles.faulted : (status === 'active' ? styles.active : styles.inactive);

  return (
    <div
      id={id}
      className={`${styles.port} ${statusClass}`}
      data-status={faulted ? 'faulted' : status}
      aria-label={`${name} - ${faulted ? 'faulted' : status}`}
    >
      <div className={styles.connector} />
      <div className={styles.info}>
        <span className={styles.label}>{name}</span>
        {faulted && probability !== null && (
          <span className={styles.probability}>{probability}%</span>
        )}
      </div>
    </div>
  );
}

export default PCIePort;
