import { expect, type Page } from "@playwright/test";

export const MOCK = "http://127.0.0.1:8443";

export async function resetMock(version?: string) {
  const res = await fetch(`${MOCK}/__mock/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(version ? { version } : {}),
  });
  expect(res.ok).toBe(true);
}

export async function mockState() {
  return (await (await fetch(`${MOCK}/__mock/state`)).json()) as {
    rules: Record<string, string>[];
    aliases: Record<string, string>[];
    pendingApply: boolean;
    applyCount: number;
  };
}

export async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Password").fill("ruledeck-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("grid")).toBeVisible();
}

/** Grid cell for a rule row (by description text) and column label. */
export function cell(page: Page, rowText: string, column: string) {
  return page
    .getByRole("row")
    .filter({ hasText: rowText })
    .locator(`td.col-${column}`);
}
