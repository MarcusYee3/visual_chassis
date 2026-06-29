import styles from './PSUPort.module.css';

function PSUPort({ id, name, status = 'active', faulted = false }) {
  const statusClass = faulted ? styles.faulted : (status === 'active' ? styles.active : styles.inactive);

  return (
    <div
      id={id}
      className={`${styles.port} ${statusClass}`}
      data-status={faulted ? 'faulted' : status}
      aria-label={`${name} - ${faulted ? 'faulted' : status}`}
    >
      <div className={styles.led} />
      <span className={styles.label}>{name}</span>
    </div>
  );
}

export default PSUPort;
