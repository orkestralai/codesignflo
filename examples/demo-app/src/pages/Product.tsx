import { Badge } from "../components/Badge/Badge";
import { Button } from "../components/Button/Button";
import { Footer } from "../components/Footer/Footer";
import { Header } from "../components/Header/Header";
import { ShippingBadge } from "../components/ShippingBadge/ShippingBadge";
import { QuantityStepper } from "../components/QuantityStepper/QuantityStepper";
import { products } from "../data/products";
import { FREE_SHIPPING } from "../feature";
import styles from "./Product.module.css";

export function Product() {
  const p = products[0]!;
  return (
    <div className={styles.page}>
      <Header cartCount={2} />
      <main className={styles.main}>
        <img className={styles.image} src="/product.svg" alt="" />
        <div className={styles.details}>
          {p.onSale && <Badge label="Sale" tone="sale" />}
          <h1 className={styles.title}>{p.title}</h1>
          <p className={styles.price}>{p.price}</p>
          {FREE_SHIPPING && p.freeShipping && <ShippingBadge />}
          <p className={styles.description}>{p.description}</p>
          <div className={styles.actions}>
            <QuantityStepper value={1} />
            <Button label="Add to cart" onClick={() => (window.location.hash = "#/cart")} />
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
