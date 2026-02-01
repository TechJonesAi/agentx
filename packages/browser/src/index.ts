import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import type { Tool, AgentConfig } from '@agentx/core';
import { createLogger } from '@agentx/core';

const log = createLogger('browser');

export class BrowserController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private headless: boolean;
  private timeout: number;

  constructor(config?: { headless?: boolean; timeout?: number }) {
    this.headless = config?.headless ?? true;
    this.timeout = config?.timeout ?? 30000;
  }

  async launch(): Promise<void> {
    if (this.browser) return;

    log.info({ headless: this.headless }, 'Launching browser');
    this.browser = await chromium.launch({ headless: this.headless });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.timeout);
  }

  async ensurePage(): Promise<Page> {
    if (!this.page) {
      await this.launch();
    }
    return this.page!;
  }

  async navigate(url: string): Promise<string> {
    const page = await this.ensurePage();
    log.info({ url }, 'Navigating');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return page.url();
  }

  async click(selector: string): Promise<void> {
    const page = await this.ensurePage();
    await page.click(selector);
  }

  async fill(selector: string, value: string): Promise<void> {
    const page = await this.ensurePage();
    await page.fill(selector, value);
  }

  async getText(selector?: string): Promise<string> {
    const page = await this.ensurePage();
    if (selector) {
      return page.textContent(selector) as Promise<string>;
    }
    return page.evaluate(() => document.body.innerText);
  }

  async getHtml(selector?: string): Promise<string> {
    const page = await this.ensurePage();
    if (selector) {
      return page.innerHTML(selector);
    }
    return page.content();
  }

  async screenshot(path?: string): Promise<Buffer> {
    const page = await this.ensurePage();
    return page.screenshot({ path, fullPage: true });
  }

  async evaluate<T>(script: string): Promise<T> {
    const page = await this.ensurePage();
    return page.evaluate(script) as T;
  }

  async waitForSelector(selector: string, timeout?: number): Promise<void> {
    const page = await this.ensurePage();
    await page.waitForSelector(selector, { timeout: timeout ?? this.timeout });
  }

  async type(selector: string, text: string, delay = 50): Promise<void> {
    const page = await this.ensurePage();
    await page.type(selector, text, { delay });
  }

  async selectOption(selector: string, value: string): Promise<void> {
    const page = await this.ensurePage();
    await page.selectOption(selector, value);
  }

  async getUrl(): Promise<string> {
    const page = await this.ensurePage();
    return page.url();
  }

  async getTitle(): Promise<string> {
    const page = await this.ensurePage();
    return page.title();
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      log.info('Browser closed');
    }
  }
}

// ─── Browser tools for the agent ─────────────────────────────────────────────

let sharedBrowser: BrowserController | null = null;

function getBrowser(): BrowserController {
  if (!sharedBrowser) {
    sharedBrowser = new BrowserController();
  }
  return sharedBrowser;
}

export const browserNavigateTool: Tool = {
  definition: {
    name: 'browser_navigate',
    description: 'Navigate the browser to a URL and return the page text content',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to' },
      },
      required: ['url'],
    },
  },
  async execute(args) {
    const browser = getBrowser();
    const url = args['url'] as string;
    await browser.navigate(url);
    const text = await browser.getText();
    const title = await browser.getTitle();
    return `[Title]: ${title}\n[URL]: ${url}\n\n${text.slice(0, 5000)}`;
  },
};

export const browserClickTool: Tool = {
  definition: {
    name: 'browser_click',
    description: 'Click an element on the page by CSS selector',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click' },
      },
      required: ['selector'],
    },
  },
  async execute(args) {
    const browser = getBrowser();
    await browser.click(args['selector'] as string);
    return 'Clicked successfully';
  },
};

export const browserFillTool: Tool = {
  definition: {
    name: 'browser_fill',
    description: 'Fill in a form field by CSS selector',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input field' },
        value: { type: 'string', description: 'Value to fill in' },
      },
      required: ['selector', 'value'],
    },
  },
  async execute(args) {
    const browser = getBrowser();
    await browser.fill(args['selector'] as string, args['value'] as string);
    return 'Filled successfully';
  },
};

export const browserScreenshotTool: Tool = {
  definition: {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional file path to save the screenshot' },
      },
    },
  },
  async execute(args) {
    const browser = getBrowser();
    const buffer = await browser.screenshot(args['path'] as string | undefined);
    return `Screenshot taken (${buffer.length} bytes)`;
  },
};

export const browserExtractTool: Tool = {
  definition: {
    name: 'browser_extract',
    description: 'Extract text content from the page, optionally from a specific CSS selector',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to extract from' },
      },
    },
  },
  async execute(args) {
    const browser = getBrowser();
    const text = await browser.getText(args['selector'] as string | undefined);
    return text.slice(0, 10000);
  },
};

export function getBrowserTools(): Tool[] {
  return [browserNavigateTool, browserClickTool, browserFillTool, browserScreenshotTool, browserExtractTool];
}
