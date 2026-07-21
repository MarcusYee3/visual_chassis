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
        Menu {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className={styles.dropdown}>
          <Link className={styles.item} to="/failures" onClick={() => setOpen(false)}>Failure Log</Link>
          <Link className={styles.item} to="/about" onClick={() => setOpen(false)}>About</Link>
        </div>
      )}
    </div>
  );
}

export default NavMenu;
