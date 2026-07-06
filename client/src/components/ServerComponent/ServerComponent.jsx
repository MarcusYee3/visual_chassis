import styles from './ServerComponent.module.css';

function ServerComponent({ id, name, color = 'default', interactive = false, onClick, style, badge = false }) {
  const colorClass = styles[color] || styles.default;
  const interactiveClass = interactive ? styles.interactive : '';

  const handleClick = () => {
    if (interactive && onClick) {
      onClick();
    }
  };

  const handleKeyDown = (e) => {
    if (interactive && onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      id={id}
      className={`${styles.component} ${colorClass} ${interactiveClass}`}
      style={style}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={name}
    >
      {badge && <div className={styles.badge}>!</div>}
      <div className={styles.handle}>
        <div className={styles.handleGrip} />
      </div>
      <div className={styles.ledCluster}>
        <div className={`${styles.led} ${styles.ledPower}`} />
        <div className={`${styles.led} ${styles.ledActivity}`} />
      </div>
      <span className={styles.label}>{name}</span>
      <div className={styles.latch} />
    </div>
  );
}

export default ServerComponent;
