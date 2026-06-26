import styles from './GXR3VRetimer.module.css';

function GXR3VRetimer({ id, name, onClick }) {
  return (
    <div
      id={id}
      className={`${styles.chip} ${onClick ? styles.interactive : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
      aria-label={name}
    >
      <div className={styles.pinRow} />
      <div className={styles.body}>
        <span className={styles.label}>{name}</span>
        <span className={styles.partNum}>GXR3V2</span>
      </div>
      <div className={styles.pinRow} />
    </div>
  );
}

export default GXR3VRetimer;
