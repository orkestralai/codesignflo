import styles from "./ShippingBadge.module.css";

/** Free shipping, on a product that ships free. Built quickly by the developer, before its design: its colour is off. */
export function ShippingBadge({ label = "Free shipping" }: { label?: string }) {
  return <span className={styles.badge}>{label}</span>;
}
