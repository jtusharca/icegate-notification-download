import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const webhook = (process.env.APPS_SCRIPT_URL || '').trim();
const token = (process.env.DOWNLOAD_TOKEN || '').trim();

if (!webhook) {
  throw new Error('APPS_SCRIPT_URL is missing. Add it under Repository secrets and check the workflow env mapping.');
}
if (!token) {
  throw new Error('DOWNLOAD_TOKEN is missing. Add it under Repository secrets and check the workflow env mapping.');
}
if (!/^https:\/\/script\.google\.com\/(?:macros\/s|a\/macros\/[^/]+\/s)\/[A-Za-z0-9_-]+\/exec(?:\?[^\s]*)?$/.test(webhook)) {
  throw new Error('APPS_SCRIPT_URL is present but has the wrong format. Copy the Web app URL ending /exec from Deploy > Manage deployments. Paste without quotes.');
}
console.log('Both required secrets are present and the Web app URL format is valid.');
async function callScript(payload) {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({...payload, token}),
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error('Apps Script HTTP ' + response.status);
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Apps Script response was not JSON. Check deployment access is Anyone and URL ends /exec.'); }
  if (!data.ok) throw new Error(data.error || 'Apps Script operation failed.');
  return data;
}

const status = await callScript({action: 'check'});
if (!status.needed) {
  console.log('Drive PDF already current, notification ' + status.number);
} else {
  if (!/^\d{1,6}\/\d{4}$/.test(status.number)) throw new Error('Invalid notification number.');
  const browser = await chromium.launch({headless: true, timeout: 30000});
  try {
    const context = await browser.newContext({acceptDownloads: true, locale: 'en-US'});
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    await page.goto('https://foservices.icegate.gov.in/#/services/notifyPublishScreen', {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    const row = page.locator('tr').filter({has: page.getByText(status.number, {exact: true})});
    await row.waitFor({state: 'visible'});
    const [download] = await Promise.all([
      page.waitForEvent('download', {timeout: 60000}),
      row.locator('a').filter({hasText: /Download PDF/i}).click()
    ]);
    if (await download.failure()) throw new Error('ICEGATE browser download failed.');
    const bytes = await readFile(await download.path());
    if (bytes.length < 100 || bytes.length > 10000000 || bytes.subarray(0, 5).toString() !== '%PDF-' ||
        !bytes.subarray(-1024).toString().includes('%%EOF')) throw new Error('Invalid PDF received from website.');
    await callScript({action: 'upload', number: status.number, digest: status.digest, pdf: bytes.toString('base64')});
    console.log('Original ICEGATE PDF saved to Drive, notification ' + status.number);
  } finally {
    await browser.close();
  }
}
