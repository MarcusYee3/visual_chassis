import styles from './PCIePort.module.css';

function PCIePort({ id, name, status = 'active' }) {
  const statusClass = status === 'active' ? styles.active : styles.inactive;

  return (
    <div
      id={id}
      className={`${styles.port} ${statusClass}`}
      data-status={status}
      aria-label={`${name} - ${status}`}
    >
      <div className={styles.connector} />
      <span className={styles.label}>{name}</span>
    </div>
  );
}

export default PCIePort;
