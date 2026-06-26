import styles from './ServerContainer.module.css';

function ServerContainer({ children, label }) {
  return (
    <div className={styles.outer}>
      <div className={styles.rackEarLeft}>
        <div className={styles.screwHole} />
        <div className={styles.screwHole} />
        <div className={styles.screwHole} />
      </div>
      <div className={styles.chassis}>
        <div className={styles.faceplate}>
          <div className={styles.faceplateLeft}>
            <div className={styles.powerBtn} />
            <div className={styles.statusLeds}>
              <div className={`${styles.statusLed} ${styles.ledOn}`} />
              <div className={`${styles.statusLed} ${styles.ledAmber}`} />
              <div className={styles.statusLed} />
              <div className={styles.statusLed} />
            </div>
          </div>
          {label && <span className={styles.faceplateLabel}>{label}</span>}
          <div className={styles.faceplateRight}>
            <div className={styles.usbPort} />
            <div className={styles.usbPort} />
            <div className={styles.idBtn}>ID</div>
          </div>
        </div>
        <div className={styles.body}>
          <div className={styles.leftRail}>
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className={styles.ventSlot} />
            ))}
          </div>
          <div className={styles.bayArea}>
            {children}
          </div>
          <div className={styles.rightRail}>
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className={styles.ventSlot} />
            ))}
          </div>
        </div>
        <div className={styles.bottomEdge} />
      </div>
      <div className={styles.rackEarRight}>
        <div className={styles.screwHole} />
        <div className={styles.screwHole} />
        <div className={styles.screwHole} />
      </div>
    </div>
  );
}

export default ServerContainer;
