"use client";

import type { CSSProperties, ReactNode } from "react";

type Props = {
  id?: string;
  label?: ReactNode;
  description?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
};

export default function Field({ id, label, description, hint, error, required, className, style, children }: Props) {
  return (
    <div className={["field", className].filter(Boolean).join(" ")} style={style}>
      {label ? (
        <label htmlFor={id}>
          {label}
          {required ? <span style={{ color: "var(--danger)", marginLeft: 6 }}>*</span> : null}
        </label>
      ) : null}
      {description ? <div className="fieldDesc">{description}</div> : null}
      {children}
      {error ? <div className="fieldError">{error}</div> : hint ? <div className="fieldHint">{hint}</div> : null}
    </div>
  );
}

