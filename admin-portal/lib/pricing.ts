/**
 * Pricing configuration and calculation for the multi-tier reseller system.
 *
 * This module defines base prices for API keys and calculates final prices
 * after applying tier-based discounts.
 *
 * Pricing structure:
 *  - Base price per API key (can be customized per plan/duration in future)
 *  - Discount applied based on account's discountPercent field
 *  - Final price = basePrice * (1 - discountPercent / 100)
 *
 * @module lib/pricing
 */

import type { DynamoClient } from "./dynamo.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Base price for creating an API key (in credits/currency units). */
export const BASE_API_KEY_PRICE = 100;

/** Base price for creating a license (can be customized by plan in future). */
export const BASE_LICENSE_PRICE = 10;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Pricing calculation result. */
export interface PriceCalculation {
  basePrice: number;
  discountPercent: number;
  discountAmount: number;
  finalPrice: number;
}

/** Account info needed for pricing calculation. */
export interface AccountForPricing {
  resellerAccountId: string;
  accountType: "distributor" | "reseller" | "dealer";
  discountPercent: number;
  balance: number;
  state: "active" | "suspended";
}

// ─── Pricing Functions ───────────────────────────────────────────────────────

/**
 * Calculate final price after applying discount.
 *
 * @param basePrice - Base price before discount
 * @param discountPercent - Discount percentage (0-100)
 * @returns Price calculation breakdown
 */
export function calculatePrice(
  basePrice: number,
  discountPercent: number
): PriceCalculation {
  // Ensure discount is within valid range
  const discount = Math.max(0, Math.min(100, discountPercent));
  const discountAmount = basePrice * (discount / 100);
  const finalPrice = basePrice - discountAmount;

  return {
    basePrice,
    discountPercent: discount,
    discountAmount,
    finalPrice: Math.max(0, finalPrice), // Never negative
  };
}

/**
 * Calculate price for an API key based on account's discount.
 *
 * @param account - Account information including discount
 * @returns Price calculation for API key
 */
export function calculateApiKeyPrice(account: AccountForPricing): PriceCalculation {
  return calculatePrice(BASE_API_KEY_PRICE, account.discountPercent);
}

/**
 * Calculate price for a license based on account's discount.
 *
 * @param account - Account information including discount
 * @returns Price calculation for license
 */
export function calculateLicensePrice(account: AccountForPricing): PriceCalculation {
  return calculatePrice(BASE_LICENSE_PRICE, account.discountPercent);
}

/**
 * Check if account has sufficient balance for a purchase.
 *
 * @param account - Account with balance information
 * @param finalPrice - Price after discount
 * @returns True if balance is sufficient
 */
export function hasSufficientBalance(
  account: AccountForPricing,
  finalPrice: number
): boolean {
  return account.balance >= finalPrice;
}

/**
 * Get account information for pricing calculations.
 *
 * @param dynamo - DynamoDB client
 * @param accountId - Account ID to fetch
 * @returns Account info or null if not found
 */
export async function getAccountForPricing(
  dynamo: DynamoClient,
  accountId: string
): Promise<AccountForPricing | null> {
  const item = await dynamo.get({
    TableName: "pdm-portal-resellers",
    Key: { resellerAccountId: accountId },
  });

  if (!item) return null;

  const account = item as Record<string, unknown>;
  return {
    resellerAccountId: account.resellerAccountId as string,
    accountType: account.accountType as "distributor" | "reseller" | "dealer",
    discountPercent: (account.discountPercent as number) ?? 0,
    balance: (account.balance as number) ?? 0,
    state: (account.state as "active" | "suspended") ?? "active",
  };
}

// ─── Future Extensions ───────────────────────────────────────────────────────

/**
 * Future: Support for dynamic pricing based on:
 *  - License plan (basic/pro/enterprise)
 *  - License duration (1 month / 1 year / lifetime)
 *  - Volume discounts (bulk purchases)
 *  - Custom pricing per account
 *  - Seasonal promotions
 */

/** Future pricing rule type. */
export interface PricingRule {
  ruleId: string;
  itemType: "apikey" | "license";
  condition?: {
    plan?: string;
    duration?: string;
    minQuantity?: number;
  };
  price: number;
  priority: number;
}
