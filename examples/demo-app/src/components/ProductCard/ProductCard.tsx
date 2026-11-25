import { Badge } from "../Badge/Badge";
import { Button } from "../Button/Button";
import { ShippingBadge } from "../ShippingBadge/ShippingBadge";
import { FREE_SHIPPING } from "../../feature";
import styles from "./ProductCard.module.css";

export type ProductCardProps = {
  title: string;
  price: string;
  imageUrl: string;
  onSale?: boolean;
  freeShipping?: boolean;
  onAddToCart?: () => void;
};

export function ProductCard({ title, price, imageUrl, onSale = false, freeShipping = false, onAddToCart }: ProductCardProps) {
  return (
    <article className={styles.card}>
      <img className={styles.image} src={imageUrl} alt="" />
      <div className={onSale ? `${styles.body} ${styles.sale}` : styles.body}>
        <div className={styles.header}>
          <h3 className={styles.title}>{title}</h3>
          {onSale && <Badge label="Sale" tone="sale" />}
        </div>
        <p className={styles.price}>{price}</p>
        {FREE_SHIPPING && freeShipping && <ShippingBadge />}
        <Button label="Add to cart" onClick={onAddToCart} />
      </div>
    </article>
  );
}
