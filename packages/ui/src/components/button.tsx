/**
 * Button — Human layer.
 * Square, uppercase, 3px ink border, hard offset shadow; press pushes into shadow.
 * Variants: primary (cherry fill, one per view), secondary (raised surface), ghost (underlined).
 */
import * as React from "react";
import { cn } from "../lib/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "md" | "lg";
  block?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "md", block = false, className, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "ch-btn",
          variant === "primary" && "ch-btn-primary",
          variant === "ghost" && "ch-btn-ghost",
          size === "lg" && "ch-btn-lg",
          block && "ch-btn-block",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
