import type { ReactNode } from "react";
import styles from "./Button.module.css";

export type ButtonProps = {
  label: string;
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
  disabled?: boolean;
  leadingIcon?: ReactNode;
  onClick?: () => void;
};

export function Button({ label, variant = "primary", size = "md", disabled = false, leadingIcon, onClick }: ButtonProps) {
  return (
    <button
      type="button"
      className={[styles.button, styles[variant], styles[size]].join(" ")}
      disabled={disabled}
      onClick={onClick}
    >
      {leadingIcon && <span className={styles.icon}>{leadingIcon}</span>}
      <span data-cdf="label">{label}</span>
    </button>
  );
}
