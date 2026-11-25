import styles from "./PromoBanner.module.css";

export type PromoBannerProps = { title: string; description: string };

export function PromoBanner({ title, description }: PromoBannerProps) {
  return (
    <section className={styles.banner} data-cdf="promo-banner">
      <h2 className={styles.title} data-cdf="title">{title}</h2>
      <p className={styles.description} data-cdf="description">{description}</p>
    </section>
  );
}
