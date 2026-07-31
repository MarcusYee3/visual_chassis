import styles from './OSFPModule.module.css';

// bodyStyle/labelStyle are escape hatches for a caller that needs to override the visible .body
// box's own intrinsic height, or its .label text's own font size (both fixed in
// OSFPModule.module.css for the B300 page's dense OSFP/IOU rows), without touching that shared
// CSS module.
function OSFPModule({ id, name, onClick, hasFault = false, bodyStyle, labelStyle }) {
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
      style={{ position: 'relative' }}
    >
      {hasFault && <div className={styles.badge}>!</div>}
      <div className={styles.tab} />
      <div className={`${styles.body} ${hasFault ? styles.faulted : ''}`} style={bodyStyle}>
        <div className={styles.led} />
        <span className={styles.label} style={labelStyle}>{name}</span>
      </div>
    </div>
  );
}

export default OSFPModule;
