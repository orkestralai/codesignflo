import styles from "./QuantityStepper.module.css";

export type QuantityStepperProps = { value: number; disabled?: boolean; onChange?: (value: number) => void };

export function QuantityStepper({ value, disabled = false, onChange }: QuantityStepperProps) {
  return (
    <div className={[styles.stepper, disabled ? styles.disabled : ""].join(" ")}>
      <button type="button" className={styles.step} disabled={disabled} aria-label="Decrease" onClick={() => onChange?.(Math.max(1, value - 1))}>
        −
      </button>
      <span className={styles.value}>{value}</span>
      <button type="button" className={styles.step} disabled={disabled} aria-label="Increase" onClick={() => onChange?.(value + 1)}>
        +
      </button>
    </div>
  );
}
