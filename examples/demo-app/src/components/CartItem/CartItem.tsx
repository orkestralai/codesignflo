import { Badge } from "../Badge/Badge";
import { QuantityStepper } from "../QuantityStepper/QuantityStepper";
import styles from "./CartItem.module.css";

export type CartItemProps = { title: string; price: string; imageUrl: string; quantity: number; onSale?: boolean };

export function CartItem({ title, price, imageUrl, quantity, onSale = false }: CartItemProps) {
  return (
    <div className={styles.item}>
      <img className={styles.image} src={imageUrl} alt="" />
      <div className={styles.info}>
        <p className={styles.title}>{title}</p>
        {onSale && <Badge label="Sale" tone="sale" />}
        <p className={styles.price}>{price}</p>
      </div>
      <QuantityStepper value={quantity} />
    </div>
  );
}
