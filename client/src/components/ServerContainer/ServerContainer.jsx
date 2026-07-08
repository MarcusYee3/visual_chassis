import styles from './ServerContainer.module.css';

const U_SECTIONS = [
  { key: 'osfp', label: '1U', grow: 1 },
  { key: 'gpu', label: '6U', grow: 6 },
  { key: 'iob', label: '3U', grow: 3 },
  { key: 'psu', label: '2U', grow: 2 },
];

function ServerContainer({ children, label }) {
  return (
    <div className={styles.outer}>
      <div className={styles.uLabels}>
        <div className={styles.uLabelsTopSpacer} />
        <div className={styles.uLabelsBody}>
          {U_SECTIONS.map((section) => (
            <div key={section.key} className={styles.uSection} style={{ flexGrow: section.grow }}>
              <span className={styles.uBracket} />
              <span className={styles.uText}>{section.label}</span>
            </div>
          ))}
        </div>
        <div className={styles.uLabelsBottomSpacer} />
      </div>
      <div className={styles.rackEarLeft}>
        <div className={styles.screwHole} />
        <div className={styles.screwHole} />
        <div className={styles.screwHole} />
      </div>
      <div className={styles.chassis}>
        <div className={`${styles.cornerScrew} ${styles.screwTL}`} />
        <div className={`${styles.cornerScrew} ${styles.screwTR}`} />
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
            <div className={styles.ejectorHandle} />
          </div>
          <div className={styles.bayArea}>
            {children}
          </div>
          <div className={styles.rightRail}>
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className={styles.ventSlot} />
            ))}
            <div className={styles.ejectorHandle} />
          </div>
        </div>
        <div className={styles.bottomEdge} />
        <div className={`${styles.cornerScrew} ${styles.screwBL}`} />
        <div className={`${styles.cornerScrew} ${styles.screwBR}`} />
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
