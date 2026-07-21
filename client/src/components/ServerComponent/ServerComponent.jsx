import { useState } from 'react';
import styles from './ServerComponent.module.css';

function ServerComponent({ id, name, color = 'default', interactive = false, onClick, style, badge = false, alert = false, delay = 0 }) {
  // The entrance animation's fill-mode:both holds its final `transform` value in effect
  // indefinitely (that's how CSS animation fills work) — which silently wins over the
  // .interactive:hover/:active transform rules forever, not just during the intro. Dropping the
  // .entering class once the animation actually finishes frees `transform` back up for hover/
  // active to control normally afterward.
  const [entered, setEntered] = useState(false);

  const colorClass = styles[color] || styles.default;
  const interactiveClass = interactive ? styles.interactive : '';
  const alertClass = alert ? styles.alert : '';
  const enteringClass = entered ? '' : styles.entering;

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
      className={`${styles.component} ${colorClass} ${alertClass} ${interactiveClass} ${enteringClass}`}
      style={{ ...style, animationDelay: entered ? undefined : `${delay}ms` }}
      onAnimationEnd={() => setEntered(true)}
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
