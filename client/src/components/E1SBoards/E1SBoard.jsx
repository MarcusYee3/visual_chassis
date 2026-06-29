import styles from './E1SBoard.module.css';

function E1SBoard({ id, name, faulted = false }) {
  return (
    <div id={id} className={`${styles.board} ${faulted ? styles.faulted : ''}`} aria-label={name}>
      <div className={styles.handle}>
        <div className={styles.handleGrip} />
      </div>
      <div className={styles.ports}>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className={styles.port}>
            <div className={styles.portLed} />
            <div className={styles.portSlot} />
          </div>
        ))}
      </div>
      <span className={styles.label}>{name}</span>
      <div className={styles.latch} />
    </div>
  );
}

export default E1SBoard;
