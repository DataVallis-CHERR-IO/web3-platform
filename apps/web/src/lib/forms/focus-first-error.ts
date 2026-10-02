/**
 * After a failed submit: bring the first field marked invalid into view and
 * focus it, so the problem is never "below the fold" (David, dev test 2026-10-02:
 * a too short story blocked saving and looked like a dead button).
 * Runs after React has rendered the error state.
 */
export function focusFirstError(form: HTMLFormElement | null): void {
  if (!form) return;
  requestAnimationFrame(() => {
    const field = form.querySelector<HTMLElement>(".ch-field-error");
    if (!field) return;
    const target =
      field.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select, button, [tabindex]:not([tabindex='-1'])") ??
      field;
    field.scrollIntoView({ block: "center", behavior: "smooth" });
    target.focus({ preventScroll: true });
  });
}
