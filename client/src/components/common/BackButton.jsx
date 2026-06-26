import styles from './BackButton.module.css';

function BackButton({ onClick, label = '← Back' }) {
  return (
    <button
      className={styles.backButton}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export default BackButton;
