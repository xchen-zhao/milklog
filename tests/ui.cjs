// Uses only a fresh temporary database. Never connects to a running family service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const { chromium } = require('playwright');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'milklog-ui-'));
  const python = process.env.MILKLOG_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const server = spawn(python, ['server.py', '--port', '0', '--data', directory, '--show-access-url'], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });
  const exited = once(server, 'exit');
  let browser;
  let startupError = '';
  server.stderr.on('data', chunk => { startupError += chunk; });
  try {
    const ready = (async () => {
      const lines = readline.createInterface({ input: server.stdout });
      for await (const line of lines) {
        const prefix = 'Private family access URL (keep secret): ';
        if (line.startsWith(prefix)) return line.slice(prefix.length);
      }
      throw new Error('Server stopped before startup: ' + startupError);
    })();
    let timeout;
    const url = await Promise.race([ready, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
    })]).finally(() => clearTimeout(timeout));
    browser = await chromium.launch(process.env.MILKLOG_CHROME ? { executablePath: process.env.MILKLOG_CHROME } : {});
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const first = await desktop.newPage();
    const second = await phone.newPage();
    const errors = [];
    for (const page of [first, second]) page.on('pageerror', error => errors.push(error.message));
    await Promise.all([first.goto(url), second.goto(url)]);
    for (const page of [first, second]) await page.locator('#settings-dialog').waitFor({ state: 'visible' });

    await first.locator('#settings-skip').click();
    await first.locator('#settings-dialog').waitFor({ state: 'hidden' });
    await first.reload();
    await first.locator('#settings-button').waitFor({ state: 'visible' });
    assert.equal(await first.locator('#settings-dialog').isVisible(), false, 'Skip must survive reload');

    // Second device still has the first-use version: loading the new version must
    // leave its dialog closable and allow editing again without reloading the page.
    await second.locator('#baby-name').fill('小米');
    await second.locator('#settings-save').click();
    await second.locator('#settings-error').filter({ hasText: '已为你加载最新设置' }).waitFor();
    assert.equal(await second.locator('#baby-name').inputValue(), '');
    await second.locator('#settings-dismiss').click();
    await second.locator('#settings-dialog').waitFor({ state: 'hidden' });
    await second.getByRole('button', { name: '修改昵称', exact: true }).click();
    await second.locator('#baby-name').fill('小米');
    assert.equal(await second.locator('#name-preview').innerText(), '小米的小奶瓶');
    await second.locator('#settings-save').click();
    await second.locator('#settings-dialog').waitFor({ state: 'hidden' });
    assert.equal(await second.title(), '小米的小奶瓶');
    await second.reload();
    await second.locator('#brand-title').filter({ hasText: '小米的小奶瓶' }).waitFor();
    await first.locator('#refresh-button').click();
    await first.locator('#brand-title').filter({ hasText: '小米的小奶瓶' }).waitFor();

    await second.locator('#settings-button').click();
    await second.locator('#baby-name').fill('奶'.repeat(20));
    await second.locator('#settings-save').click();
    await second.locator('#settings-dialog').waitFor({ state: 'hidden' });
    assert.equal(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Long names must fit mobile');
    await second.locator('#settings-button').click();
    await second.locator('#baby-name').fill('<img src=x>');
    await second.locator('#settings-save').click();
    await second.locator('#settings-dialog').waitFor({ state: 'hidden' });
    assert.equal(await second.locator('#brand-title img').count(), 0, 'Names must be rendered as text');
    assert.equal(await second.title(), '<img src=x>的小奶瓶');

    await second.locator('#settings-button').click();
    await second.locator('#baby-name').fill('');
    await second.locator('#settings-save').click();
    await second.locator('#settings-dialog').waitFor({ state: 'hidden' });
    assert.equal(await second.title(), '小奶瓶');
    await second.reload();
    await second.locator('#settings-button').waitFor({ state: 'visible' });
    assert.equal(await second.locator('#settings-dialog').isVisible(), false);

    // Recording supports a custom name and an explicit opt-in to the shared list.
    await first.locator('.desktop-add .add-button').click();
    await first.locator('#amount').fill('180');
    await first.locator('#caregiver-name').fill('奶奶');
    await first.locator('#remember-caregiver').check();
    await first.locator('#save-button').click();
    await first.locator('#record-dialog').waitFor({ state: 'hidden' });
    await first.locator('#records').filter({ hasText: '奶奶记录' }).waitFor();
    await second.locator('#refresh-button').click();
    await second.locator('#records').filter({ hasText: '奶奶记录' }).waitFor();
    await second.locator('#mobile-add .add-button').click();
    await second.getByRole('radio', { name: '奶奶', exact: true }).check();
    assert.equal(await second.locator('#caregiver-name').inputValue(), '奶奶');
    await second.locator('#manage-caregivers').click();
    await second.locator('#caregivers-dialog').waitFor({ state: 'visible' });
    await second.getByRole('button', { name: '移除奶奶', exact: true }).click();
    await second.locator('#new-caregiver').fill('爷爷');
    await second.locator('#new-caregiver').press('Enter');
    await second.locator('#caregivers-save').click();
    await second.locator('#caregivers-dialog').waitFor({ state: 'hidden' });
    assert.equal(await second.locator('#caregiver-name').inputValue(), '奶奶', 'Changing common names must preserve the current form');
    assert.equal(await second.getByRole('radio', { name: '奶奶', exact: true }).count(), 0);
    assert.equal(await second.getByRole('radio', { name: '爷爷', exact: true }).count(), 1);
    assert.equal(await second.locator('#remember-caregiver').isChecked(), false);
    await second.locator('[data-close="record-dialog"]').click();
    await first.locator('#refresh-button').click();
    await first.locator('#records .edit-button').click();
    assert.equal(await first.locator('#caregiver-name').inputValue(), '奶奶', 'Historical names must survive removal from the common list');
    await first.locator('#amount').fill('190');
    await first.locator('#save-button').click();
    await first.locator('#record-dialog').waitFor({ state: 'hidden' });
    await first.locator('#records').filter({ hasText: '奶奶记录' }).waitFor();

    // Two editors must recover from a stale list without overwriting each other.
    await Promise.all([first.locator('#caregivers-button').click(), second.locator('#caregivers-button').click()]);
    for (const page of [first, second]) await page.locator('#caregivers-dialog').waitFor({ state: 'visible' });
    await first.locator('#new-caregiver').fill('阿姨');
    await first.locator('#add-caregiver').click();
    await first.locator('#caregivers-save').click();
    await first.locator('#caregivers-dialog').waitFor({ state: 'hidden' });
    await second.locator('#caregivers-save').click();
    await second.locator('#caregivers-error').filter({ hasText: '已加载最新设置' }).waitFor();
    assert.equal(await second.getByRole('button', { name: '移除阿姨', exact: true }).count(), 1);
    await second.locator('#caregivers-dismiss').click();
    await second.locator('#caregivers-dialog').waitFor({ state: 'hidden' });
    await second.locator('#mobile-add .add-button').click();
    await second.getByRole('radio', { name: '爷爷', exact: true }).check();
    assert.equal(await second.locator('#caregiver-name').inputValue(), '爷爷');
    assert.equal(await second.locator('#record-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'Caregiver controls must fit the mobile dialog');
    await second.locator('[data-close="record-dialog"]').click();
    assert.deepEqual(errors, []);
    console.log('PASS: nickname setup and conflicts, persistence, mobile layout, custom caregivers, shared common names, nested list management, legacy record editing and caregiver settings conflict recovery.');
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
