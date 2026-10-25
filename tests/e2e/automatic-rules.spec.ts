import { expect, test } from "@playwright/test";
import { login, MOCK, resetMock } from "./helpers.ts";

/**
 * Regression: real firewalls list many automatic rules (anti-lockout, DHCP,
 * RFC4890, ...) that share one reference label. They used to look "modified"
 * right after loading, even though nobody edited anything.
 */
test("automatic rules that share one reference don't show up as pending changes", async ({ page }) => {
  await resetMock();
  await fetch(`${MOCK}/__mock/legacy-rules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      { ref: "system/anti-lockout", description: "anti-lockout rule", destination_net: "(self)", destination_port: "443", interface: "lan", protocol: "TCP" },
      { ref: "system/anti-lockout", description: "anti-lockout rule", destination_net: "(self)", destination_port: "80", interface: "lan", protocol: "TCP" },
      { ref: "system/anti-lockout", description: "sshlockout", destination_net: "(self)", destination_port: "22", interface: "lan", protocol: "TCP" },
      { ref: "system/dhcp", description: "allow access to DHCP server", source_port: "68", destination_port: "67", protocol: "UDP", interface: "lan" },
      { ref: "system/dhcp", description: "allow access to DHCP server", source_port: "547", destination_port: "546", protocol: "UDP", interface: "lan", ipprotocol: "inet6" },
    ]),
  });
  await login(page);

  // Default read-only rules are hidden until asked for.
  await expect(page.getByText("7 of 13 rules")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: /anti-lockout rule/ })).toHaveCount(0);
  await page.getByLabel("Hide default read-only rules").uncheck();

  // Every automatic rule is listed (7 normal + 1 built-in + 5 added = 13), none is "modified".
  await expect(page.getByText("13 of 13 rules")).toBeVisible();
  await expect(page.getByRole("button", { name: /0 pending/ })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "MOD" })).toHaveCount(0);

  // Each rule keeps its own values (no mix-ups between rules with the same reference).
  const lockout = page.getByRole("row").filter({ hasText: /anti-lockout rule/ });
  await expect(lockout).toHaveCount(2);
  await expect(lockout.nth(0)).toContainText("443");
  await expect(lockout.nth(1)).toContainText("80");
  await expect(page.getByRole("row").filter({ hasText: "sshlockout" })).toContainText("22");

  // Nothing to apply: the apply button stays off.
  await expect(page.getByRole("button", { name: "Review & apply", exact: true })).toBeDisabled();

  // Still true after a reload.
  await page.reload();
  await expect(page.getByRole("button", { name: /0 pending/ })).toBeVisible();
});
