import { execFile } from "node:child_process";

import chalk from "chalk";

import { DEFAULT_PORT } from "@tuttiai/server";

import { serveCommand, type ServeOptions } from "./serve.js";

const BROWSER_OPEN_DELAY_MS = 1000;

/**
 * Open `url` in the user's default browser. Best-effort — no error
 * propagates back to the caller, since failure to open the browser
 * (e.g. headless CI) should not bring down the studio server.
 */
function openBrowser(url: string): void {
  const handler = (err: Error | null): void => {
    if (err) return;
  };
  if (process.platform === "win32") {
    execFile("cmd.exe", ["/c", "start", "", url], handler);
    return;
  }
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(cmd, [url], handler);
}

/**
 * `tutti-ai studio` — start the Tutti server with the Studio SPA mounted
 * at `/studio` and open the browser.
 *
 * Equivalent to running `tutti-ai serve --studio` and then navigating to
 * the studio URL, with a 1-second delay so the server is listening
 * before the browser opens.
 */
export async function studioCommand(
  scorePath?: string,
  options: ServeOptions = {},
): Promise<void> {
  const port = parsePort(options.port);
  const host = options.host ?? "0.0.0.0";
  const display = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const url = "http://" + display + ":" + port + "/studio";

  setTimeout(() => {
    console.log(chalk.bold("\n  Tutti Studio open at " + url + "\n"));
    openBrowser(url);
  }, BROWSER_OPEN_DELAY_MS);

  await serveCommand(scorePath, { ...options, studio: true });
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : DEFAULT_PORT;
}
