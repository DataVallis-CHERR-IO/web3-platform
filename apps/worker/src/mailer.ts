import nodemailer from "nodemailer";
import type { SmtpConfig } from "./config.js";
import type { Mailer } from "./notify/send.js";

/** SMTP through the Data Vallis mail server (ADR-048): STARTTLS on 587, TLS on 465. */
export function smtpMailer(smtp: SmtpConfig): Mailer & { verify(): Promise<true> } {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    requireTLS: smtp.port !== 465,
    auth: { user: smtp.user, pass: smtp.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(email) {
      await transport.sendMail({ from: smtp.from, to: email.to, subject: email.subject, text: email.text, html: email.html, headers: email.headers });
    },
    verify: () => transport.verify(),
  };
}
