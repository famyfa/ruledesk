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

/** Open the rule editor dialog for a rule (double-click on its row). */
export async function openRule(page: Page, rowText: string) {
  await cell(page, rowText, "description").dblclick();
  const dialog = page.getByRole("dialog", { name: "Edit rule" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Open the dialog for a new rule (below the active row). */
export async function newRule(page: Page) {
  await page.getByRole("button", { name: "+ Add rule" }).click();
  const dialog = page.getByRole("dialog", { name: "New rule" });
  await expect(dialog).toBeVisible();
  return dialog;
}

export const tab = (dialog: ReturnType<Page["locator"]>, name: string) => dialog.getByRole("tab", { name: new RegExp(`^${name}`) }).click();

/** Stage a change through the form: switch logging on for a rule. */
export async function turnLogOn(page: Page, rowText: string) {
  const dialog = await openRule(page, rowText);
  await tab(dialog, "Actions");
  await dialog.getByLabel("Log packets that match this rule").check();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toBeHidden();
}
