import styles from "./Footer.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <span className={styles.copy}>© 2026 Shop</span>
      <div className={styles.links}>
        <a className={styles.link} href="#/">
          Shipping
        </a>
        <a className={styles.link} href="#/">
          Returns
        </a>
        <a className={styles.link} href="#/">
          Contact
        </a>
        <a className={styles.link} href="#/">
          Privacy
        </a>
      </div>
    </footer>
  );
}
