/**
 * Toast — Sonner Toaster restyled to CHERR.IO design system.
 * Usage: wrap app in <ToastProvider /> and call toast("message") anywhere.
 * Square corners, ink border, hard shadow (no radius).
 */
"use client";
import { Toaster as SonnerToaster, type ToasterProps } from "sonner";

export { toast } from "sonner";

/**
 * Drop-in Toaster provider with CHERR.IO styles. Square corners, ink border, hard shadow.
 * Place in the root layout: <ToastProvider position="bottom-right" />
 */
export function ToastProvider(props: ToasterProps) {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "ch-toast",
          title: "ch-toast-title",
          description: "ch-toast-desc",
          actionButton: "ch-btn ch-btn-primary",
          cancelButton: "ch-btn",
          error: "ch-toast-error",
          success: "ch-toast-success",
          info: "ch-toast-info",
        },
      }}
      {...props}
    />
  );
}
