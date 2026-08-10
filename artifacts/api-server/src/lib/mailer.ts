import nodemailer from "nodemailer";
import { logger } from "./logger";

export interface ResearchCompleteEmailData {
  serviceName: string;
  serviceId: number;
  runId: number;
}

function hasSmtpConfig(): boolean {
  return !!(
    process.env["SMTP_HOST"] &&
    process.env["SMTP_USERNAME"] &&
    process.env["SMTP_PASSWORD"] &&
    process.env["SMTP_FROM"] &&
    process.env["ALERT_EMAIL"]
  );
}

export async function sendResearchCompleteEmail(
  data: ResearchCompleteEmailData,
): Promise<void> {
  if (!hasSmtpConfig()) return;

  const host = process.env["SMTP_HOST"]!;
  const port = parseInt(process.env["SMTP_PORT"] ?? "587", 10);
  const user = process.env["SMTP_USERNAME"]!;
  const pass = process.env["SMTP_PASSWORD"]!;
  const from = process.env["SMTP_FROM"]!;
  const to = process.env["ALERT_EMAIL"]!;
  const appBaseUrl = (process.env["APP_BASE_URL"] ?? "http://localhost").replace(
    /\/$/,
    "",
  );

  const serviceUrl = `${appBaseUrl}/services/${data.serviceId}`;
  const name = data.serviceName;
  const runId = data.runId;

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transport.sendMail({
    from,
    to,
    subject: `Renewal Scout: Research complete for ${name}`,
    text: [
      `Research has completed for: ${name}`,
      ``,
      `View the results: ${serviceUrl}`,
      ``,
      `Run ID: ${runId}`,
    ].join("\n"),
    html: [
      `<p>Research has completed for: <strong>${name}</strong></p>`,
      `<p><a href="${serviceUrl}">View the results</a></p>`,
      `<p>Run ID: ${runId}</p>`,
    ].join("\n"),
  });

  logger.info({ serviceId: data.serviceId, runId, to }, "Research complete email sent");
}
