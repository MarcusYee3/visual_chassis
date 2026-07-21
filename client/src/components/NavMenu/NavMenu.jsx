import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import styles from './NavMenu.module.css';

function NavMenu() {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button className={styles.trigger} type="button" onClick={() => setOpen((o) => !o)}>
        Menu <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>▾</span>
      </button>
      {/* Always mounted (rather than conditionally rendered) so closing can transition out via
          CSS instead of the panel just disappearing instantly. */}
      <div className={`${styles.dropdown} ${open ? styles.open : ''}`}>
        <Link className={styles.item} to="/failures" onClick={() => setOpen(false)}>Failure Log</Link>
        <Link className={styles.item} to="/about" onClick={() => setOpen(false)}>About</Link>
      </div>
    </div>
  );
}

export default NavMenu;
