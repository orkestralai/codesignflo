import styles from "./Badge.module.css";

export type BadgeProps = { label: string; tone?: "neutral" | "sale" };

export function Badge({ label, tone = "neutral" }: BadgeProps) {
  return <span className={[styles.badge, styles[tone]].join(" ")}>{label}</span>;
}
