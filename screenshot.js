#!/usr/bin/env node
/**
 * screenshot.js
 * Usage:
 *   node screenshot.js [url] [selector] [output]
 * Examples:
 *   node screenshot.js
 *   node screenshot.js "https://example.com" "#my-element" output.png
 */

const puppeteer = require('puppeteer');

const defaultUrl = 'https://wiki.biligame.com/blhx/%E5%A8%81%E5%BB%89%C2%B7D%C2%B7%E6%B3%A2%E7%89%B9';
const defaultSelector = '#mw-content-text > div > div.row > div.col-lg-6.col-md-6.col-sm-6.col-xs-12.jntj-left > table.wikitable.sv-general';
const defaultOutput = 'element.png';

const url = process.argv[2] || defaultUrl;
const selector = process.argv[3] || defaultSelector;
const output = process.argv[4] || defaultOutput;

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36');

  try {
    console.log('打开页面：', url);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('等待元素：', selector);
    await page.waitForSelector(selector, { timeout: 30000 });

    // 将元素滚动到视口中心
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
    }, selector);

    const elHandle = await page.$(selector);
    if (!elHandle) {
      console.error('元素未找到，保存整页截图到', output);
      await page.screenshot({ path: output, fullPage: true });
    } else {
      await elHandle.screenshot({ path: output });
      console.log('已保存元素截图到', output);
    }
  } catch (err) {
    console.error('截图失败：', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
