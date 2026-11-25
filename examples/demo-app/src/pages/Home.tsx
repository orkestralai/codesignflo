import { Footer } from "../components/Footer/Footer";
import { Header } from "../components/Header/Header";
import { ProductCard } from "../components/ProductCard/ProductCard";
import { products } from "../data/products";
import styles from "./Home.module.css";

export function Home() {
  return (
    <div className={styles.page}>
      <Header cartCount={2} />
      <main className={styles.main}>
        <h1 className={styles.heading}>New arrivals</h1>
        <div className={styles.grid}>
          {products.map((p) => (
            <ProductCard key={p.id} title={p.title} price={p.price} onSale={p.onSale} freeShipping={p.freeShipping} imageUrl="/product.svg" onAddToCart={() => (window.location.hash = "#/cart")} />
          ))}
        </div>
      </main>
      <Footer />
    </div>
  );
}
