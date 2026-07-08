import styles from './FanModule.module.css';

function FanModule({ number, faulted = false }) {
  return (
    <div className={`${styles.fan} ${faulted ? styles.faulted : ''}`} aria-label={`Fan ${number}`}>
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
