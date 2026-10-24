import { expect, type Page } from "@playwright/test";

export const MOCK = "http://127.0.0.1:8443";
export const MOCK_MUC = "http://127.0.0.1:8444";

export async function resetMock(version?: string) {
  for (const base of [MOCK, MOCK_MUC]) {
    const res = await fetch(`${base}/__mock/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(version ? { version } : {}),
    });
    expect(res.ok).toBe(true);
  }
}

export async function mockState() {
  return (await (await fetch(`${MOCK}/__mock/state`)).json()) as {
    rules: Record<string, string>[];
    aliases: Record<string, string>[];
    pendingApply: boolean;
    applyCount: number;
  };
}

/** Sign in with the same OPNsense account on every site (the default). */
export async function login(page: Page, username = "admin", password = "ruledeck-dev") {
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("grid")).toBeVisible();
}

/** Grid cell for a rule row (by description text) and column label. */
export function cell(page: Page, rowText: string, column: string) {
  return page
    .getByRole("row")
    .filter({ hasText: rowText })
    .locator(`td.col-${column}`);
}
