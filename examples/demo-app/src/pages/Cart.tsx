import { Button } from "../components/Button/Button";
import { CartItem } from "../components/CartItem/CartItem";
import { Footer } from "../components/Footer/Footer";
import { Header } from "../components/Header/Header";
import { products } from "../data/products";
import styles from "./Cart.module.css";

export function Cart() {
  const items = [
    { ...products[0]!, quantity: 1 },
    { ...products[2]!, quantity: 1 },
  ];
  return (
    <div className={styles.page}>
      <Header cartCount={2} />
      <main className={styles.main}>
        <section className={styles.list}>
          <h1 className={styles.heading}>Your cart</h1>
          {items.map((i) => (
            <CartItem key={i.id} title={i.title} price={i.price} onSale={i.onSale} quantity={i.quantity} imageUrl="/product.svg" />
          ))}
        </section>
        <aside className={styles.summary}>
          <div className={styles.row}>
            <span data-cdf="label">Subtotal</span>
            <span data-cdf="value">€68</span>
          </div>
          <div className={styles.row}>
            <span data-cdf="label">Shipping</span>
            <span data-cdf="value">Free</span>
          </div>
          <div className={styles.total}>
            <span data-cdf="label">Total</span>
            <span data-cdf="value">€68</span>
          </div>
          <Button label="Checkout" />
        </aside>
      </main>
      <Footer />
    </div>
  );
}
