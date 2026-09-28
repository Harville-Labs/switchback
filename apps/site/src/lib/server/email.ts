/**
 * Outgoing email: sign-in links and invitations. In production through
 * Cloudflare's SMTP service with nodemailer; `log` prints messages for local
 * development; tests capture them in memory.
 */
import nodemailer, { type Transporter } from 'nodemailer';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

export class LogMailer implements Mailer {
  async send(email: Email): Promise<void> {
    console.log(`\n--- email to ${email.to}: ${email.subject}\n${email.text}\n---\n`);
  }
}

export class MemoryMailer implements Mailer {
  readonly sent: Email[] = [];
  async send(email: Email): Promise<void> {
    this.sent.push(email);
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

/** Cloudflare: smtp.mx.cloudflare.net, port 465 (implicit TLS), user `api_token`. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(private readonly options: SmtpOptions) {
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.port === 465,
      auth: { user: options.user, pass: options.password },
    });
  }

  async send(email: Email): Promise<void> {
    await this.transport.sendMail({ from: this.options.from, ...email });
  }
}
