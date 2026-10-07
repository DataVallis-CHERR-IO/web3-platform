// Minimal types for the one call we use (qrcode@1.5.4 ships none; @types/qrcode is not a dependency).
declare module "qrcode" {
  export function toString(
    text: string,
    options: { type: "svg"; errorCorrectionLevel?: "L" | "M" | "Q" | "H"; margin?: number; width?: number }
  ): Promise<string>;
}
