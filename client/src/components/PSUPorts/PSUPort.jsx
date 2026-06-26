import styles from './PSUPort.module.css';

function PSUPort({ id, name, status = 'active' }) {
  const statusClass = status === 'active' ? styles.active : styles.inactive;

  return (
    <div
      id={id}
      className={`${styles.port} ${statusClass}`}
      data-status={status}
      aria-label={`${name} - ${status}`}
    >
      <div className={styles.led} />
      <span className={styles.label}>{name}</span>
    </div>
  );
}

export default PSUPort;
