import styles from './OSFPModule.module.css';

function OSFPModule({ id, name, onClick }) {
  const handleKeyDown = (e) => {
    if (onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      id={id}
      className={styles.module}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={name}
    >
      <div className={styles.tab} />
      <div className={styles.body}>
        <div className={styles.led} />
        <span className={styles.label}>{name}</span>
      </div>
    </div>
  );
}

export default OSFPModule;
