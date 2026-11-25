import { Button } from "../Button/Button";
import styles from "./Header.module.css";

export type HeaderProps = { cartCount: number };

export function Header({ cartCount }: HeaderProps) {
  return (
    <header className={styles.header}>
      <a className={styles.logo} href="#/">
        Shop
      </a>
      <nav className={styles.nav}>
        <a className={styles.link} href="#/">
          New arrivals
        </a>
        <a className={styles.link} href="#/product">
          Featured
        </a>
        <Button label={`Cart (${cartCount})`} variant="secondary" onClick={() => (window.location.hash = "#/cart")} />
      </nav>
    </header>
  );
}
