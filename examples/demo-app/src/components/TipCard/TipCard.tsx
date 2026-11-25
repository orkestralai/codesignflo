import styles from "./TipCard.module.css";

export type TipCardProps = { title: string; body: string };

export function TipCard({ title, body }: TipCardProps) {
  return (
    <div className={styles.tipCard} data-cdf="tip-card">
      <p className={styles.title} data-cdf="title">{title}</p>
      <p className={styles.body} data-cdf="body">{body}</p>
      <span className={styles.decoration} data-cdf="decoration" aria-hidden="true" />
    </div>
  );
}
